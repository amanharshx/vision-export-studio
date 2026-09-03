#!/usr/bin/env python3
"""H9 corrected sweep: populated-env dry-run resolution, macOS ARM64 native.

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
  * rfdetr-default is shared by onnx and executorch: on 3.12 only, ONNX-populated
    envs (real `pip install "rfdetr[onnx]"`) model the second state.
  * No --ignore-installed anywhere (the app never passes it).
  * Each leg: `pip install --dry-run --report <file> [policy] <payload>`,
    300s timeout. A timeout is recorded as did-not-converge, never as failure.
  * Manifests: normalized sorted `name==version` (freeze base UNION report delta).
    Classification compares manifests, never bare exit-code pairs.

Usage:
  sweep.py build <tag>        # create UL_ORD/UL_BIN/RF_FRESH_* venvs + real installs
  sweep.py build-onnxpop      # 3.12 only: RF_ONNX_ORD/BIN + real rfdetr[onnx]
  sweep.py resolve <tag>      # dry-run sweep for one python tag
"""
import json
import os
import subprocess
import sys

WORK = "/private/tmp/h9-correct"
LOG = os.path.join(WORK, "logs")
REP = os.path.join(WORK, "reports")
MAN = os.path.join(WORK, "manifests")
os.makedirs(LOG, exist_ok=True)
os.makedirs(REP, exist_ok=True)
os.makedirs(MAN, exist_ok=True)

TIMEOUT = 300
ENV = dict(os.environ, PIP_CACHE_DIR=os.path.join(WORK, "cache"))

PYTHONS = {
    "py310": "/Users/aman/.local/bin/python3.10",
    "py311": "/Users/aman/.pyenv/versions/3.11.9/bin/python3.11",
    "py312": "/opt/homebrew/bin/python3.12",
    "py313": "/opt/homebrew/bin/python3.13",
}

# Native macOS payload groups (exact app install_package values; onnxslim excluded:
# optional -> install_package None, dropped by getInstallableMissingPackages).
UL_ROUTES = [
    ("ul_onnx", ["onnx"]),
    ("ul_openvino", ["openvino", "nncf"]),
    ("ul_coreml", ["coremltools"]),
    ("ul_ncnn", ["ncnn", "pnnx"]),
    ("ul_mnn", ["MNN", "onnx"]),
    ("ul_litert", ["litert-torch>=0.9.0", "ai-edge-litert>=2.1.4"]),
    ("ul_tfgraph", ["tensorflow", "onnx2tf", "onnx", "onnxruntime"]),
    ("ul_paddle", ["paddlepaddle", "x2paddle"]),
    ("ul_executorch", ["executorch"]),
]
# Fresh-stack RF routes native to macOS (rf_engine is Linux/Windows-gated: excluded
# from the native table; rf_tflite gated to Python 3.12 by stack python_requirement).
RF_ROUTES = [
    ("rf_onnx", ["rfdetr[onnx]"]),
    ("rf_coreml", ["rfdetr[coreml]"]),
    ("rf_tflite", ["rfdetr[tflite]>=1.9.4"]),
    ("rf_executorch", ["rfdetr[executorch]>=1.9.0", "torch>=2.13"]),
]


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
    return os.path.join(WORK, name, "bin", "python")


def ensure_venv(interp, name):
    py = venv_py(name)
    if not os.path.exists(py):
        subprocess.run([interp, "-m", "venv", os.path.join(WORK, name)], check=True, env=ENV)
    return py


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


def freeze(py):
    r = subprocess.run([py, "-m", "pip", "freeze", "--exclude-editable"],
                       capture_output=True, text=True, env=ENV)
    pkgs = {}
    for line in r.stdout.splitlines():
        if "==" in line:
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


def report_delta(rep_path):
    try:
        r = json.load(open(rep_path))
    except Exception:
        return None, None
    inst = r.get("install", [])
    pkgs = {}
    sdists = []
    for p in inst:
        n = norm(p["metadata"]["name"])
        pkgs[n] = p["metadata"]["version"]
        url = p.get("download_info", {}).get("url", "")
        if url.endswith((".tar.gz", ".zip")):
            sdists.append(f"{n}=={pkgs[n]}")
    return pkgs, sorted(sdists)


def write_manifest(path, header, pkgs):
    with open(path, "w") as f:
        f.write(header + "\n")
        for n in sorted(pkgs):
            f.write(f"{n}=={pkgs[n]}\n")


def build(tag):
    interp = PYTHONS[tag]
    meta = {"tag": tag, "interpreter": interp,
            "host": subprocess.run(["uname", "-a"], capture_output=True,
                                   text=True).stdout.strip()}
    # UL ordinary base: exact fresh-runtime command (bare name).
    ord_py = ensure_venv(interp, f"UL_ORD_{tag}")
    meta["UL_ORD"] = envmeta(ord_py)
    meta["UL_ORD"]["install_cmd"] = f"{ord_py} -m pip install ultralytics"
    meta["UL_ORD"]["install_rc"] = run(
        [ord_py, "-m", "pip", "install", "ultralytics"],
        os.path.join(LOG, f"UL_ORD_{tag}_base_install.log"), timeout=3600)
    meta["UL_ORD"]["freeze_count"] = len(freeze(ord_py))
    # UL binary base: same command under the proposed policy.
    bin_py = ensure_venv(interp, f"UL_BIN_{tag}")
    meta["UL_BIN"] = envmeta(bin_py)
    meta["UL_BIN"]["install_cmd"] = f"{bin_py} -m pip install --only-binary=:all: ultralytics"
    meta["UL_BIN"]["install_rc"] = run(
        [bin_py, "-m", "pip", "install", "--only-binary=:all:", "ultralytics"],
        os.path.join(LOG, f"UL_BIN_{tag}_base_install.log"), timeout=3600)
    meta["UL_BIN"]["freeze_count"] = len(freeze(bin_py))
    # RF fresh stacks: empty venvs (stacks start empty).
    for leg in ("ORD", "BIN"):
        rf = ensure_venv(interp, f"RF_FRESH_{leg}_{tag}")
        meta[f"RF_FRESH_{leg}"] = envmeta(rf)
    json.dump(meta, open(os.path.join(REP, f"envmeta_{tag}.json"), "w"), indent=2)
    print(json.dumps(meta, indent=2))


def build_onnxpop():
    interp = PYTHONS["py312"]
    meta = {}
    for leg, extra in (("ORD", []), ("BIN", ["--only-binary=:all:"])):
        name = f"RF_ONNX_{leg}_py312"
        py = ensure_venv(interp, name)
        meta[leg] = envmeta(py)
        cmd = [py, "-m", "pip", "install"] + extra + ["rfdetr[onnx]"]
        meta[leg]["install_cmd"] = " ".join(cmd)
        meta[leg]["install_rc"] = run(
            cmd, os.path.join(LOG, f"{name}_base_install.log"), timeout=3600)
        meta[leg]["freeze_count"] = len(freeze(py))
    json.dump(meta, open(os.path.join(REP, "envmeta_onnxpop_py312.json"), "w"), indent=2)
    print(json.dumps(meta, indent=2))


def resolve_leg(py, base_freeze, group, args, tag, policy, pre=False):
    leg = "ordinary" if policy == "ord" else "binary"
    rep = os.path.join(REP, f"{group}_{tag}_{leg}.json")
    logf = os.path.join(LOG, f"{group}_{tag}_{leg}.log")
    cmd = [py, "-m", "pip", "install", "--dry-run", "--report", rep]
    if pre:
        cmd.append("--pre")
    if policy == "bin":
        cmd.append("--only-binary=:all:")
    cmd += args
    rc = run(cmd, logf, timeout=TIMEOUT)
    delta, sdists = ({}, None)
    if rc == 0:
        delta, sdists = report_delta(rep)
        if delta is None:
            delta, sdists = {}, None
    full = dict(base_freeze)
    full.update(delta or {})
    man_path = os.path.join(MAN, f"{group}_{tag}_{leg}.txt")
    header = (f"# group={group} tag={tag} leg={leg} rc={rc}\n"
              f"# cmd: {' '.join(cmd)}\n"
              f"# base_freeze={len(base_freeze)} delta={len(delta or {})} full={len(full)}")
    write_manifest(man_path, header, full)
    return {"group": group, "rc": rc, "full_count": len(full),
            "delta_count": len(delta or {}),
            "sdists_in_delta": sdists if sdists is not None else "n/a",
            "manifest": os.path.basename(man_path)}


def resolve_all(tag, onnxpop=False):
    ord_py = venv_py(f"UL_ORD_{tag}")
    bin_py = venv_py(f"UL_BIN_{tag}")
    ord_base = freeze(ord_py)
    bin_base = freeze(bin_py)
    rows = []
    for group, args in UL_ROUTES:
        o = resolve_leg(ord_py, ord_base, group, args, tag, "ord")
        b = resolve_leg(bin_py, bin_base, group, args, tag, "bin")
        rows.append(classify(group, o, b))
        print("  ", rows[-1])
    rf_env = "RF_ONNX" if onnxpop else "RF_FRESH"
    ro_py = venv_py(f"{rf_env}_ORD_{tag}")
    rb_py = venv_py(f"{rf_env}_BIN_{tag}")
    ro_base = freeze(ro_py)
    rb_base = freeze(rb_py)
    for group, args in RF_ROUTES:
        if group == "rf_tflite" and tag != "py312":
            print(f"   {group}: skipped (app gates TFLite stack to Python >=3.12,<3.13)")
            rows.append({"group": group, "verdict": "gated-skipped",
                         "ord_rc": "skipped", "bin_rc": "skipped"})
            continue
        o = resolve_leg(ro_py, ro_base, group, args, tag, "ord")
        b = resolve_leg(rb_py, rb_base, group, args, tag, "bin")
        rows.append(classify(group, o, b))
        print("  ", rows[-1])
    # flatc prerelease stage (exact app second stage: `pip install --pre flatc`).
    fz = {} if not onnxpop else freeze(ro_py)
    o = resolve_leg(ro_py, ro_base, "rf_executorch_flatc_pre", ["flatc"], tag, "ord", pre=True)
    b = resolve_leg(rb_py, rb_base, "rf_executorch_flatc_pre", ["flatc"], tag, "bin", pre=True)
    rows.append(classify("rf_executorch_flatc_pre", o, b))
    print("  ", rows[-1])
    out = {"tag": tag, "stack_state": ("onnxpop" if onnxpop else "fresh"),
           "UL_ORD_freeze": len(ord_base), "UL_BIN_freeze": len(bin_base),
           "rows": rows}
    name = f"summary_{tag}{'_onnxpop' if onnxpop else ''}.json"
    json.dump(out, open(os.path.join(REP, name), "w"), indent=2)
    print(f"wrote {name}")


def classify(group, o, b):
    orc, brc = o["rc"], b["rc"]
    timed = isinstance(orc, str) or isinstance(brc, str)
    if isinstance(orc, str) or isinstance(brc, str):
        verdict = "timeout/non-convergence"
    elif orc != 0 and brc != 0:
        verdict = "unverified"
    elif orc != 0:
        verdict = "unverified"
    elif brc != 0:
        verdict = "binary failure"
    else:
        mo = open(os.path.join(MAN, o["manifest"])).read().splitlines()
        mb = open(os.path.join(MAN, b["manifest"])).read().splitlines()
        bo = sorted(l for l in mo if l and not l.startswith("#"))
        bb = sorted(l for l in mb if l and not l.startswith("#"))
        verdict = "identical" if bo == bb else "divergent"
    return {"group": group, "verdict": verdict,
            "ord_rc": orc, "bin_rc": brc,
            "ord_delta": o["delta_count"], "bin_delta": b["delta_count"],
            "ord_manifest": o["manifest"], "bin_manifest": b["manifest"],
            "sdists_in_ordinary_delta": o["sdists_in_delta"]}


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(sys.argv[2])
    elif sys.argv[1] == "build-onnxpop":
        build_onnxpop()
    elif sys.argv[1] == "resolve":
        resolve_all(sys.argv[2], onnxpop=(len(sys.argv) > 3 and sys.argv[3] == "onnxpop"))
    else:
        sys.exit("usage: sweep.py [build <tag> | build-onnxpop | resolve <tag> [onnxpop]]")