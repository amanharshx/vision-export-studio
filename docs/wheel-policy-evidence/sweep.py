#!/usr/bin/env python3
"""H9 wheel-policy sweep: populated-env resolution on a native release target.

Faithful modeling of the app at 3cbf09d:
  * Fresh Ultralytics runtime = `pip install ultralytics` (BARE name, as sent by
    handleInstallUltralyticsRuntime, export-workspace.tsx:1496) into an empty venv
    created with `python -m venv` (bundled pip, never upgraded).
  * Route remedy state = `pip install "ultralytics>=8.4.80"` (check_ultralytics_dep,
    deps.rs:1210) -- documented, not separately re-run: both land on a recent
    ultralytics; the sweep base uses the bare fresh-runtime command.
  * Separate ordinary-policy and binary-policy base envs per interpreter:
      UL_ORD_<tag>: venv + real `pip install ultralytics`
      UL_BIN_<tag>: venv + real `pip install --only-binary=:all: ultralytics`
    Ordinary legs resolve in ORD envs, binary legs in BIN envs.
  * RF-DETR stacks start empty: RF_FRESH_ORD/BIN_<tag> are empty venvs.
  * rfdetr-default is shared by onnx and executorch: ONNX-populated envs (real
    `pip install "rfdetr[onnx]"`) model the second state where that route is
    native. The recorded local audit used 3.12; CI can supply any supported tag.
  * No --ignore-installed anywhere (the app never passes it).
  * Each leg: `pip install --dry-run --report <file> [policy] <payload>`,
    300s timeout. A timeout is recorded as did-not-converge, never as failure.
  * Manifests (deduplicated, base-plus-delta): each shared base environment is
    persisted once (UL-base-<tag>-<ORD|BIN>.txt, RF-fresh-base-empty.txt,
    RF-onnx-base-<tag>-<ORD|BIN>.txt); each route manifest body holds only the
    report delta with a `# base: manifests/<name>` header. A full closure is
    reconstructed as base plus delta, delta versions overriding base versions.
    Classification compares reconstructed full closures, never bare exit codes.
    Failed/timed-out legs still record the base reference with an empty delta.

Configuration (no source edits needed):
  * Work directory: `--work DIR` or `H9_WORK` (required; created if missing).
    A run refuses to reuse existing venv directories, so reruns need a fresh dir.
  * Interpreters: `--interp TAG=PATH` (repeatable) or `H9_INTERPS` JSON object
    (e.g. '{"py312": "/usr/bin/python3.12"}'); otherwise `python3.<minor>` is
    looked up on PATH, else a clear error names the missing tag.
  * Native target: auto-detected, or asserted with `--target`. An assertion that
    does not match the real OS/architecture fails; this is never a simulation.

Usage:
  sweep.py --work DIR [--interp TAG=PATH ...] build <tag>
  sweep.py --work DIR [--interp TAG=PATH ...] build-onnxpop <tag>
  sweep.py --work DIR resolve <tag> [fresh|onnxpop]
  sweep.py --work DIR consolidate --out DIR
Consolidate deterministically merges per-tag summaries and envmeta records plus
the manifest files into the layout validated by check_manifests.py.
Consolidate requires a fresh output directory (nonexistent or empty) and
rejects a nonempty one before writing anything.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys

TIMEOUT = 300

WORK = None
LOG = None
REP = None
MAN = None
ENV = None
PYTHONS = {}
TARGET = None

# Notes embedded verbatim so `consolidate` output matches the tracked files.
NOTE_PY312 = ("UL rows + fresh-stack RF rows (py312_fresh manifests). "
              "ONNX-populated RF-DETR ExecuTorch rows live in "
              "summary_py312_onnxpop.json "
              "(py312_onnxpop manifests).")
NOTE_ONNXPOP = ("RF-DETR ExecuTorch rows only: ONNX and ExecuTorch share rfdetr-default; "
                "CoreML, TFLite, and TensorRT have separate stack environments. UL rows "
                "are already covered by summary_py312.json.")

# Exact app install_package values; onnxslim is optional and therefore omitted
# by getInstallableMissingPackages. Target sets mirror route_platform_lock.
UL_ROUTES = [
    ("ul_onnx", ["onnx"], "all"),
    ("ul_openvino", ["openvino", "nncf"], "all"),
    ("ul_coreml", ["coremltools"], "macos-linux"),
    ("ul_ncnn", ["ncnn", "pnnx"], "all"),
    ("ul_mnn", ["MNN", "onnx"], "all"),
    ("ul_litert", ["litert-torch>=0.9.0", "ai-edge-litert>=2.1.4"],
     "macos-linux-x86_64"),
    ("ul_tfgraph", ["tensorflow", "onnx2tf", "onnx", "onnxruntime"], "all"),
    ("ul_paddle", ["paddlepaddle", "x2paddle"], "all"),
    ("ul_executorch", ["executorch"], "all"),
    ("ul_engine", ["tensorrt"], "linux-windows"),
    ("ul_rknn", ["rknn-toolkit2", "onnx"], "linux"),
    ("ul_imx", ["model-compression-toolkit", "sony-custom-layers",
                "imx500-converter"], "linux"),
    ("ul_axelera", ["axelera"], "linux"),
]
RF_ROUTES = [
    ("rf_onnx", ["rfdetr[onnx]"], "all"),
    ("rf_coreml", ["rfdetr[coreml]"], "macos"),
    ("rf_tflite", ["rfdetr[tflite]>=1.9.4"], "all"),
    ("rf_executorch", ["rfdetr[executorch]>=1.9.0", "torch>=2.13"],
     "macos-arm64-linux-windows-x86_64"),
    ("rf_engine", ["rfdetr[tensorrt]"], "linux-windows"),
]


def native_target():
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else (
        "x86_64" if machine in ("x86_64", "amd64") else machine)
    os_name = {"darwin": "macos", "linux": "linux", "windows": "windows"}.get(
        system, system)
    target = f"{os_name}-{arch}"
    supported = {"macos-arm64", "macos-x86_64", "linux-x86_64", "windows-x86_64"}
    if target not in supported:
        sys.exit(f"[sweep] unsupported native target {target} "
                 f"(system={platform.system()} machine={platform.machine()})")
    return target


def route_allowed(lock):
    os_name, arch = TARGET.rsplit("-", 1)
    return {
        "all": True,
        "macos": os_name == "macos",
        "linux": os_name == "linux",
        "macos-linux": os_name in ("macos", "linux"),
        "linux-windows": os_name in ("linux", "windows"),
        "macos-linux-x86_64": os_name == "macos" or TARGET == "linux-x86_64",
        "macos-arm64-linux-windows-x86_64": (
            TARGET == "macos-arm64" or
            (os_name in ("linux", "windows") and arch == "x86_64")
        ),
    }[lock]


def configure(work, interps, expected_target=None):
    global WORK, LOG, REP, MAN, ENV, PYTHONS, TARGET
    TARGET = native_target()
    if expected_target and expected_target != TARGET:
        sys.exit(f"[sweep] --target asserted {expected_target}, but the native "
                 f"interpreter reports {TARGET}; refusing cross-target simulation")
    WORK = work
    LOG = os.path.join(WORK, "logs")
    REP = os.path.join(WORK, "reports")
    MAN = os.path.join(WORK, "manifests")
    os.makedirs(LOG, exist_ok=True)
    os.makedirs(REP, exist_ok=True)
    os.makedirs(MAN, exist_ok=True)
    ENV = dict(os.environ, PIP_CACHE_DIR=os.path.join(WORK, "cache"))
    PYTHONS = dict(interps)


def interp_for(tag):
    if tag in PYTHONS:
        return PYTHONS[tag]
    guess = shutil.which(f"python{tag[2]}.{tag[3:]}")
    if guess:
        return guess
    sys.exit(f"[sweep] no interpreter for {tag}: pass --interp {tag}=PATH "
             f"or set H9_INTERPS JSON (looked for python{tag[2]}.{tag[3:]} on PATH)")


def run(cmd, logpath, timeout=1800):
    with open(logpath, "w") as f:
        f.write("$ " + " ".join(cmd) + "\n")
        try:
            r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT,
                               timeout=timeout, env=ENV)
            return r.returncode
        except subprocess.TimeoutExpired:
            f.write(f"\n[sweep] killed after {timeout}s (did not converge)\n")
            return f"timeout({timeout}s)"


def venv_py(name):
    scripts = "Scripts" if os.name == "nt" else "bin"
    executable = "python.exe" if os.name == "nt" else "python"
    return os.path.join(WORK, name, scripts, executable)


def require_venv(name):
    py = venv_py(name)
    if not os.path.exists(py):
        sys.exit(f"[sweep] missing environment {os.path.join(WORK, name)}; "
                 f"run the build step first")
    return py


def ensure_venv(interp, name):
    dest = os.path.join(WORK, name)
    if os.path.exists(dest):
        sys.exit(f"[sweep] refusing to reuse existing {dest}; "
                 f"remove it for a fresh reproduction or use a new WORK dir")
    subprocess.run([interp, "-m", "venv", dest], check=True, env=ENV)
    return venv_py(name)


def envmeta(py):
    out = {}
    for code, key in [
        ("import sys; print(sys.executable)", "executable"),
        ("import sys; print('.'.join(map(str, sys.version_info[:3])))", "version"),
        ("import platform; print(platform.machine())", "arch"),
        ("import platform; print(platform.system() + ' ' + platform.release())", "os"),
    ]:
        r = subprocess.run([py, "-c", code], capture_output=True, text=True, env=ENV)
        out[key] = r.stdout.strip()
    r = subprocess.run([py, "-m", "pip", "--version"], capture_output=True, text=True, env=ENV)
    out["pip"] = r.stdout.strip()
    return out


def freeze_raw_text(py):
    r = subprocess.run([py, "-m", "pip", "freeze", "--exclude-editable"],
                       capture_output=True, text=True, env=ENV)
    return [l.strip() for l in r.stdout.splitlines() if l.strip() and "==" in l]


def freeze(py):
    pkgs = {}
    for line in freeze_raw_text(py):
        n, v = line.split("==", 1)
        pkgs[norm(n)] = v.strip()
    return pkgs


def norm(name):
    out = []
    for ch in name.lower():
        out.append(ch if (ch.isalnum()) else "-")
    s = "".join(out)
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")


def base_filename_for(env_name):
    """Shared base-manifest filename for a venv dir name (no I/O)."""
    if env_name.startswith("UL_"):
        _, leg, tag = env_name.split("_", 2)
        return f"UL-base-{tag}-{leg}.txt"
    if env_name.startswith("RF_FRESH_"):
        return "RF-fresh-base-empty.txt"
    if env_name.startswith("RF_ONNX_"):
        _, _, leg, tag = env_name.split("_", 3)
        return f"RF-onnx-base-{tag}-{leg}.txt"
    sys.exit(f"[sweep] unknown environment name: {env_name}")


def persist_base_manifest(env_name, raw_lines, note=""):
    """Write the shared base manifest; returns its filename. Idempotent."""
    fname = base_filename_for(env_name)
    if env_name.startswith("RF_FRESH_"):
        text = ("# shared base: empty fresh stack venv "
                "(pip freeze --exclude-editable reports no packages)\n")
    elif env_name.startswith("RF_ONNX_"):
        text = f"# base freeze of {env_name} ({note})\n"
        text += "".join(l + "\n" for l in raw_lines)
    else:
        text = "".join(l + "\n" for l in raw_lines)
    with open(os.path.join(MAN, fname), "w") as f:
        f.write(text)
    return fname


def report_delta(rep_path):
    """Parse a pip --report file; None when missing/unreadable/malformed."""
    try:
        with open(rep_path) as f:
            r = json.load(f)
    except (OSError, ValueError):
        return None, None
    inst = r.get("install") if isinstance(r, dict) else None
    if not isinstance(inst, list):
        return None, None
    pkgs = {}
    sdists = []
    try:
        for p in inst:
            n = norm(p["metadata"]["name"])
            pkgs[n] = p["metadata"]["version"]
            url = p.get("download_info", {}).get("url", "")
            if url.endswith((".tar.gz", ".zip")):
                sdists.append(f"{n}=={pkgs[n]}")
    except (KeyError, TypeError, ValueError, AttributeError):
        return None, None
    return pkgs, sorted(sdists)


def build(tag):
    interp = interp_for(tag)
    meta = {"tag": tag, "interpreter": interp.replace(os.path.expanduser("~"), "~"),
            "host": f"{platform.system()} {platform.machine()} "
                    "(native runner; hostname not recorded)",
            "target": TARGET}
    # UL ordinary base: exact fresh-runtime command (bare name).
    ord_py = ensure_venv(interp, f"UL_ORD_{tag}")
    meta["UL_ORD"] = envmeta(ord_py)
    meta["UL_ORD"]["install_cmd"] = f"{ord_py} -m pip install ultralytics"
    meta["UL_ORD"]["install_rc"] = run(
        [ord_py, "-m", "pip", "install", "ultralytics"],
        os.path.join(LOG, f"UL_ORD_{tag}_base_install.log"), timeout=3600)
    meta["UL_ORD"]["freeze_count"] = len(freeze(ord_py))
    persist_base_manifest(f"UL_ORD_{tag}", freeze_raw_text(ord_py))
    # UL binary base: same command under the proposed policy.
    bin_py = ensure_venv(interp, f"UL_BIN_{tag}")
    meta["UL_BIN"] = envmeta(bin_py)
    meta["UL_BIN"]["install_cmd"] = f"{bin_py} -m pip install --only-binary=:all: ultralytics"
    meta["UL_BIN"]["install_rc"] = run(
        [bin_py, "-m", "pip", "install", "--only-binary=:all:", "ultralytics"],
        os.path.join(LOG, f"UL_BIN_{tag}_base_install.log"), timeout=3600)
    meta["UL_BIN"]["freeze_count"] = len(freeze(bin_py))
    persist_base_manifest(f"UL_BIN_{tag}", freeze_raw_text(bin_py))
    # RF fresh stacks: empty venvs (stacks start empty).
    for leg in ("ORD", "BIN"):
        rf = ensure_venv(interp, f"RF_FRESH_{leg}_{tag}")
        meta[f"RF_FRESH_{leg}"] = envmeta(rf)
        persist_base_manifest(f"RF_FRESH_{leg}_{tag}", [])
    failed = [leg for leg in ("UL_ORD", "UL_BIN")
              if meta[leg]["install_rc"] != 0]
    meta["base_failures"] = failed
    json.dump(meta, open(os.path.join(REP, f"envmeta_{tag}.json"), "w"), indent=2)
    print(json.dumps(meta, indent=2))
    if failed:
        print(f"[sweep] base installation failed for {failed}; "
              "dependent UL route resolution will be recorded as unavailable")


def build_onnxpop(tag):
    interp = interp_for(tag)
    meta = {"tag": tag, "target": TARGET}
    for leg, extra in (("ORD", []), ("BIN", ["--only-binary=:all:"])):
        name = f"RF_ONNX_{leg}_{tag}"
        py = ensure_venv(interp, name)
        meta[leg] = envmeta(py)
        cmd = [py, "-m", "pip", "install"] + extra + ["rfdetr[onnx]"]
        meta[leg]["install_cmd"] = " ".join(cmd)
        rc = run(cmd, os.path.join(LOG, f"{name}_base_install.log"), timeout=3600)
        meta[leg]["install_rc"] = rc
        meta[leg]["freeze_count"] = len(freeze(py))
        persist_base_manifest(name, freeze_raw_text(py),
                              note=f"real rfdetr[onnx] install, rc {rc}")
    failed = [leg for leg in ("ORD", "BIN") if meta[leg]["install_rc"] != 0]
    meta["base_failures"] = failed
    json.dump(meta, open(os.path.join(REP, f"envmeta_onnxpop_{tag}.json"), "w"), indent=2)
    print(json.dumps(meta, indent=2))
    if failed:
        print(f"[sweep] ONNX-populated base installation failed for {failed}; "
              "the dependent ExecuTorch transition will be recorded as unavailable")


def resolve_leg(py, env_name, base_freeze, group, args, tag, policy,
                pre=False, filetag=None):
    leg = "ordinary" if policy == "ord" else "binary"
    ft = filetag or tag
    base_file = base_filename_for(env_name)
    rep = os.path.join(REP, f"{group}_{ft}_{leg}.json")
    logf = os.path.join(LOG, f"{group}_{ft}_{leg}.log")
    cmd = [py, "-m", "pip", "install", "--dry-run", "--report", rep]
    if pre:
        cmd.append("--pre")
    if policy == "bin":
        cmd.append("--only-binary=:all:")
    cmd += args
    rc = run(cmd, logf, timeout=TIMEOUT)
    delta, sdists = ({}, None)
    if rc == 0:
        # Fail closed: an exit-0 leg without a usable report must not become
        # an empty delta (it could otherwise read as `identical`).
        delta, sdists = report_delta(rep)
        if delta is None:
            sys.exit(f"[sweep] exit-0 leg has no usable report file: {rep} "
                     f"(group={group} leg={leg}); refusing to record an empty delta")
    full = dict(base_freeze)
    full.update(delta)
    man_path = os.path.join(MAN, f"{group}_{ft}_{leg}.txt")
    header = (f"# group={group} tag={tag} filetag={ft} leg={leg} rc={rc}\n"
              f"# base: manifests/{base_file} "
              f"(full manifest = base with delta applied as overrides)\n"
              f"# cmd: {' '.join(cmd)}\n"
              f"# base_freeze={len(base_freeze)} delta={len(delta)} full={len(full)}")
    with open(man_path, "w") as f:
        f.write(header + "\n")
        for n in sorted(delta):
            f.write(f"{n}=={delta[n]}\n")
    return ({"group": group, "rc": rc, "full_count": len(full),
             "delta_count": len(delta),
             "sdists_in_delta": sdists if sdists is not None else "n/a",
             "manifest": os.path.basename(man_path)}, full)


def classify(group, o, b, fo, fb):
    orc, brc = o["rc"], b["rc"]
    if isinstance(orc, str) or isinstance(brc, str):
        verdict = "timeout/non-convergence"
    elif orc != 0 and brc != 0:
        verdict = "unverified"
    elif orc != 0:
        verdict = "unverified"
    elif brc != 0:
        verdict = "binary failure"
    else:
        verdict = "identical" if fo == fb else "divergent"
    return {"group": group, "verdict": verdict,
            "ord_rc": orc, "bin_rc": brc,
            "ord_delta": o["delta_count"], "bin_delta": b["delta_count"],
            "ord_manifest": o["manifest"], "bin_manifest": b["manifest"],
            "sdists_in_ordinary_delta": o["sdists_in_delta"]}


def resolve_all(tag, onnxpop=False):
    state = "onnxpop" if onnxpop else "fresh"
    rows = []
    out = {"tag": tag, "target": TARGET, "stack_state": state, "rows": rows}
    if onnxpop:
        out["platform_skipped"] = [
            group for group, _, lock in RF_ROUTES
            if group == "rf_executorch" and not route_allowed(lock)]
        out["state_skipped"] = {
            "rf_onnx": "already installed in the ONNX-populated base",
            "rf_coreml": "separate rfdetr-coreml stack",
            "rf_tflite": "separate rfdetr-tflite stack",
            "rf_engine": "separate rfdetr-tensorrt stack",
        }
    else:
        out["platform_skipped"] = [
            group for group, _, lock in UL_ROUTES + RF_ROUTES
            if not route_allowed(lock)]
    meta_name = f"envmeta_onnxpop_{tag}.json" if onnxpop else f"envmeta_{tag}.json"
    meta_path = os.path.join(REP, meta_name)
    try:
        with open(meta_path) as f:
            base_meta = json.load(f)
    except (OSError, ValueError) as exc:
        sys.exit(f"[sweep] missing or invalid base metadata {meta_path}: {exc}")
    ul_ord_base = ul_bin_base = {}
    if not onnxpop:
        # UL legs run once (fresh mode); the onnxpop rerun covers RF stacks only,
        # so UL filenames never collide across stack states.
        ul_base_failures = base_meta.get("base_failures", [])
        if ul_base_failures:
            rows.append({"group": "ul_base", "verdict": "base failure",
                         "ord_rc": base_meta["UL_ORD"]["install_rc"],
                         "bin_rc": base_meta["UL_BIN"]["install_rc"],
                         "failed_legs": ul_base_failures})
            print("  ", rows[-1])
        else:
            ord_py = require_venv(f"UL_ORD_{tag}")
            bin_py = require_venv(f"UL_BIN_{tag}")
            ul_ord_base = freeze(ord_py)
            ul_bin_base = freeze(bin_py)
            out["UL_ORD_freeze"] = len(ul_ord_base)
            out["UL_BIN_freeze"] = len(ul_bin_base)
            persist_base_manifest(f"UL_ORD_{tag}", freeze_raw_text(ord_py))
            persist_base_manifest(f"UL_BIN_{tag}", freeze_raw_text(bin_py))
            for group, args, lock in UL_ROUTES:
                if not route_allowed(lock):
                    continue
                o, fo = resolve_leg(ord_py, f"UL_ORD_{tag}", ul_ord_base,
                                    group, args, tag, "ord")
                b, fb = resolve_leg(bin_py, f"UL_BIN_{tag}", ul_bin_base,
                                    group, args, tag, "bin")
                rows.append(classify(group, o, b, fo, fb))
                print("  ", rows[-1])
    elif base_meta.get("base_failures"):
        rows.append({"group": "rf_onnx_base", "verdict": "base failure",
                     "ord_rc": base_meta["ORD"]["install_rc"],
                     "bin_rc": base_meta["BIN"]["install_rc"],
                     "failed_legs": base_meta["base_failures"]})
        out["rows"] = rows
        name = f"summary_{tag}_onnxpop.json"
        json.dump(out, open(os.path.join(REP, name), "w"), indent=2)
        print("  ", rows[-1])
        print(f"wrote {name}")
        return
    rf_env = "RF_ONNX" if onnxpop else "RF_FRESH"
    # Tracked filename convention: plain <group>_<py>_<leg>.txt everywhere,
    # except Python 3.12 RF rows which carry the stack state.
    ft = f"{tag}_onnxpop" if onnxpop else (f"{tag}_fresh" if tag == "py312" else tag)
    ro_py = require_venv(f"{rf_env}_ORD_{tag}")
    rb_py = require_venv(f"{rf_env}_BIN_{tag}")
    ro_base = freeze(ro_py)
    rb_base = freeze(rb_py)
    persist_base_manifest(f"{rf_env}_ORD_{tag}", freeze_raw_text(ro_py),
                          note="real rfdetr[onnx] install" if onnxpop else "")
    persist_base_manifest(f"{rf_env}_BIN_{tag}", freeze_raw_text(rb_py),
                          note="real rfdetr[onnx] install" if onnxpop else "")
    selected_rf_groups = []
    for group, args, lock in RF_ROUTES:
        if onnxpop and group != "rf_executorch":
            continue
        if not route_allowed(lock):
            continue
        selected_rf_groups.append(group)
        if group == "rf_tflite" and tag != "py312":
            print(f"   {group}: skipped (app gates TFLite stack to Python >=3.12,<3.13)")
            rows.append({"group": group, "verdict": "gated-skipped",
                         "ord_rc": "skipped", "bin_rc": "skipped"})
            continue
        o, fo = resolve_leg(ro_py, f"{rf_env}_ORD_{tag}", ro_base, group, args,
                          tag, "ord", filetag=ft)
        b, fb = resolve_leg(rb_py, f"{rf_env}_BIN_{tag}", rb_base, group, args,
                          tag, "bin", filetag=ft)
        rows.append(classify(group, o, b, fo, fb))
        print("  ", rows[-1])
    # flatc is the exact app second stage for RF-DETR ExecuTorch only. Do not
    # simulate it on macOS x86_64, where the route is rejected before install.
    if "rf_executorch" in selected_rf_groups:
        o, fo = resolve_leg(ro_py, f"{rf_env}_ORD_{tag}", ro_base,
                            "rf_executorch_flatc_pre", ["flatc"], tag, "ord",
                            pre=True, filetag=ft)
        b, fb = resolve_leg(rb_py, f"{rf_env}_BIN_{tag}", rb_base,
                            "rf_executorch_flatc_pre", ["flatc"], tag, "bin",
                            pre=True, filetag=ft)
        rows.append(classify("rf_executorch_flatc_pre", o, b, fo, fb))
        print("  ", rows[-1])
    out["rows"] = rows
    name = f"summary_{tag}{'_onnxpop' if onnxpop else ''}.json"
    json.dump(out, open(os.path.join(REP, name), "w"), indent=2)
    print(f"wrote {name}")


# Canonical Step-4 raw artifacts (written by step4.py under its work dir) and
# their tracked destinations: (work-relative source, evidence-relative dest).
STEP4_ARTIFACTS = [
    ("step4-summary.json", "step4-summary.json"),
    ("RF-step4-ordinary-freeze.txt", "manifests/RF-step4-ordinary-freeze.txt"),
    ("RF-step4-binary-freeze.txt", "manifests/RF-step4-binary-freeze.txt"),
    ("step4-ordinary-antlr-build.txt", "step4-ordinary-antlr-build.txt"),
    ("step4-binary-resolution-failure.txt", "step4-binary-resolution-failure.txt"),
]


def consolidate(out):
    """Deterministically merge per-tag outputs into the tracked layout.

    `--out` must be a fresh staging directory (nonexistent or empty); a
    nonempty destination is rejected before anything is written, so a repeated
    consolidation can never leave stale copies behind.
    """
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"[sweep] refusing to consolidate into nonempty {out}; "
                 f"use a fresh empty directory")
    man_out = os.path.join(out, "manifests")
    os.makedirs(man_out, exist_ok=True)
    for fname in sorted(os.listdir(MAN)):
        if fname.endswith(".txt"):
            shutil.copy(os.path.join(MAN, fname), os.path.join(man_out, fname))
    sums = {}
    for fname in sorted(os.listdir(REP)):
        if fname.startswith("summary_") and fname.endswith(".json"):
            with open(os.path.join(REP, fname)) as f:
                sums[fname] = json.load(f)
    if "summary_py312.json" in sums:
        sums["summary_py312.json"]["note"] = NOTE_PY312
    if "summary_py312_onnxpop.json" in sums:
        sums["summary_py312_onnxpop.json"]["note"] = NOTE_ONNXPOP
    with open(os.path.join(out, "sweep-summaries.json"), "w") as f:
        json.dump(sums, f, indent=2)
    env = {}
    for fname in sorted(os.listdir(REP)):
        if fname.startswith("envmeta_") and fname.endswith(".json"):
            rest = fname[len("envmeta_"):-len(".json")]
            key = "onnxpop_py312" if rest == "onnxpop_py312" else rest
            with open(os.path.join(REP, fname)) as f:
                env[key] = json.load(f)
    with open(os.path.join(out, "envmeta.json"), "w") as f:
        json.dump(env, f, indent=2)
    print(f"consolidated {len(sums)} summaries, {len(env)} envmeta records to {out}")
    included, missing = [], []
    for src, dest in STEP4_ARTIFACTS:
        src_path = os.path.join(REP, src)
        if os.path.exists(src_path):
            dest_path = os.path.join(out, dest)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            shutil.copy(src_path, dest_path)
            included.append(dest)
        else:
            missing.append(src)
    print(f"step4 artifacts included: {included if included else 'none'}")
    if missing:
        print(f"step4 artifacts missing (not claimed): {missing}")


def main(argv):
    p = argparse.ArgumentParser(
        description="H9 binary-wheel policy sweep (populated-env dry-run resolution)")
    p.add_argument("--work", default=os.environ.get("H9_WORK"),
                   help="work directory (or H9_WORK); created if missing")
    p.add_argument("--interp", action="append", default=[],
                   metavar="TAG=PATH",
                   help="interpreter per tag, repeatable (or H9_INTERPS JSON)")
    p.add_argument("--target",
                   choices=["macos-arm64", "macos-x86_64", "linux-x86_64",
                            "windows-x86_64"],
                   help="assert the auto-detected native release target")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="create base venvs + real installs")
    b.add_argument("tag")
    bo = sub.add_parser("build-onnxpop", help="create ONNX-populated stacks")
    bo.add_argument("tag")
    r = sub.add_parser("resolve", help="dry-run resolution sweep")
    r.add_argument("tag")
    r.add_argument("state", nargs="?", default="fresh", choices=["fresh", "onnxpop"])
    c = sub.add_parser("consolidate", help="merge outputs into the tracked layout")
    c.add_argument("--out", required=True, help="consolidate destination dir")
    args = p.parse_args(argv)
    if not args.work:
        p.error("no work directory: pass --work DIR or set H9_WORK")
    try:
        file_interps = json.loads(os.environ.get("H9_INTERPS", "{}"))
    except json.JSONDecodeError as e:
        sys.exit(f"[sweep] bad H9_INTERPS JSON: {e}")
    interps = dict(file_interps)
    for pair in args.interp:
        if "=" not in pair:
            sys.exit(f"[sweep] bad --interp {pair!r}; expected TAG=PATH")
        tag, path = pair.split("=", 1)
        interps[tag] = path
    configure(args.work, interps, expected_target=args.target)
    if args.cmd == "build":
        build(args.tag)
    elif args.cmd == "build-onnxpop":
        build_onnxpop(args.tag)
    elif args.cmd == "resolve":
        resolve_all(args.tag, onnxpop=(args.state == "onnxpop"))
    elif args.cmd == "consolidate":
        consolidate(args.out)


if __name__ == "__main__":
    main(sys.argv[1:])
