#!/usr/bin/env python3
"""H9 Step 4: decisive real RF-DETR ExecuTorch test on a native target.

Two disposable stack venvs from a real Python 3.12 interpreter (bundled pip;
the recorded audit used the machine's python3.12 — select with --interp).

Ordinary leg (RF_STEP4_ORD):
  1. exact stable payload:  pip install "rfdetr[executorch]>=1.9.0" "torch>=2.13"
  2. exact prerelease stage: pip install --pre flatc
  3. pip check
  4. app-equivalent readiness probes (importlib.util.find_spec for
     rfdetr / executorch.exir / torch + importlib.metadata version floors
     rfdetr>=1.9.0, torch>=2.13, mirroring RFDETR_MODULES_EXECUTORCH and
     RFDETR_EXECUTORCH_DISTRIBUTIONS in deps.rs; no heavy framework imports)

Binary leg (RF_STEP4_BIN): identical, with --only-binary=:all: applied to the
stable payload first; the --pre flatc stage runs with the flag only if the
stable stage succeeds. Same probes when installation succeeds.

Configuration (no source edits needed):
  * Work directory: `--work DIR` or `H9_WORK` (required; created if missing).
  * Interpreter: `--interp PATH` or `H9_INTERP`; otherwise `python3.12` is
    looked up on PATH, else a clear error is raised.
  * Per-stage pip timeout: `--timeout SEC` (default 3600).
  * Native target: auto-detected, or asserted with `--target`. A mismatch fails
    instead of silently turning the run into cross-platform simulation.

Captures: exact commands, exit codes, decisive excerpts, and final manifests
(pip freeze).

Canonical raw artifacts (under the work directory reports dir, copied verbatim
by sweep.py `consolidate`):
  step4-summary.json, RF-step4-ordinary-freeze.txt, RF-step4-binary-freeze.txt,
  step4-ordinary-antlr-build.txt, step4-binary-resolution-failure.txt.
Decisive excerpts are derived deterministically: the antlr excerpt keeps stable
log lines matching /antlr/i plus the final `Successfully installed` line (only
when the ordinary stable stage exits 0); the failure excerpt keeps the last 14
non-blank stable log lines plus a command pointer (only when the binary stable
stage exits nonzero). Absent excerpts are reported, never silently claimed.

Usage:
  step4.py --work DIR [--interp PATH] [--timeout SEC]
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys

WORK = None
LOG = None
REP = None
ENV = None
INTERP = None
TIMEOUT = 3600

PROBE = (
    "import importlib.util, importlib.metadata as m;"
    "mods={'rfdetr':'rfdetr','executorch.exir':'executorch.exir','torch':'torch'};"
    "[print(k, importlib.util.find_spec(v) is not None) for k, v in mods.items()];"
    "print('rfdetr-version', m.version('rfdetr'));"
    "print('torch-version', m.version('torch'));"
    "from packaging.version import Version;"
    "print('rfdetr-floor-ok', Version(m.version('rfdetr')) >= Version('1.9.0'));"
    "print('torch-floor-ok', Version(m.version('torch')) >= Version('2.13'))"
)


def configure(work, interp, timeout):
    global WORK, LOG, REP, ENV, INTERP, TIMEOUT
    WORK = work
    LOG = os.path.join(WORK, "logs")
    REP = os.path.join(WORK, "reports")
    os.makedirs(LOG, exist_ok=True)
    os.makedirs(REP, exist_ok=True)
    ENV = dict(os.environ, PIP_CACHE_DIR=os.path.join(WORK, "cache"))
    INTERP = interp
    TIMEOUT = timeout


def run(cmd, logname):
    path = os.path.join(LOG, logname)
    with open(path, "w") as f:
        f.write("$ " + " ".join(cmd) + "\n")
        try:
            r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT,
                               timeout=TIMEOUT, env=ENV)
            return r.returncode, path
        except subprocess.TimeoutExpired:
            f.write(f"\n[step4] killed after {TIMEOUT}s (did not converge)\n")
            return f"timeout({TIMEOUT}s)", path


def tail(path, n=25):
    lines = open(path, errors="replace").read().splitlines()
    return "\n".join(lines[-n:])


def write_artifact(name, header, body_lines):
    """Write one canonical excerpt artifact under the reports dir."""
    with open(os.path.join(REP, name), "w") as f:
        f.write(header + "\n")
        f.write("\n".join(body_lines) + "\n")


def native_target():
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else (
        "x86_64" if machine in ("x86_64", "amd64") else machine)
    os_name = {"darwin": "macos", "linux": "linux", "windows": "windows"}.get(
        system, system)
    return f"{os_name}-{arch}"


def leg(name, policy_extra):
    dest = os.path.join(WORK, name)
    if os.path.exists(dest):
        sys.exit(f"[step4] refusing to reuse existing {dest}; "
                 f"remove it for a fresh reproduction or use a new WORK dir")
    subprocess.run([INTERP, "-m", "venv", dest], check=True, env=ENV)
    scripts = "Scripts" if os.name == "nt" else "bin"
    executable = "python.exe" if os.name == "nt" else "python"
    py = os.path.join(dest, scripts, executable)
    rec = {"env": name, "policy": "binary" if policy_extra else "ordinary",
           "python": subprocess.run([py, "-V"], capture_output=True,
                                    text=True, env=ENV).stdout.strip(),
           "pip": subprocess.run([py, "-m", "pip", "--version"], capture_output=True,
                                 text=True, env=ENV).stdout.strip()}
    stable = [py, "-m", "pip", "install"] + policy_extra + \
        ["rfdetr[executorch]>=1.9.0", "torch>=2.13"]
    rec["stable_cmd"] = " ".join(stable)
    rec["stable_rc"], stable_log = run(stable, f"{name}_stable_install.log")
    rec["stable_log"] = os.path.basename(stable_log)
    if rec["stable_rc"] == 0:
        if rec["policy"] == "ordinary":
            log_lines = open(stable_log, errors="replace").read().splitlines()
            evidence = [l for l in log_lines if "antlr" in l.lower()
                        and not l.startswith("Successfully installed")]
            success = [l for l in log_lines if l.startswith("Successfully installed")]
            if evidence:
                write_artifact("step4-ordinary-antlr-build.txt",
                               "# RF_STEP4_ORD stable leg: antlr4 sdist build lines + "
                               "final success line (exact)",
                               evidence + (["...", success[-1]] if success else []))
                rec["excerpt"] = "step4-ordinary-antlr-build.txt"
            else:
                rec["excerpt"] = None
                rec["excerpt_missing"] = "no antlr build lines in ordinary stable log"
        pre = [py, "-m", "pip", "install", "--pre"] + policy_extra + ["flatc"]
        rec["pre_cmd"] = " ".join(pre)
        rec["pre_rc"], pre_log = run(pre, f"{name}_pre_flatc_install.log")
        rec["pre_log"] = os.path.basename(pre_log)
        chk = [py, "-m", "pip", "check"]
        rec["check_cmd"] = " ".join(chk)
        rec["check_rc"], chk_log = run(chk, f"{name}_pipcheck.log")
        rec["check_log"] = os.path.basename(chk_log)
        rec["check_tail"] = tail(chk_log, 10)
        pr = subprocess.run([py, "-c", PROBE], capture_output=True, text=True, env=ENV)
        rec["probe_rc"] = pr.returncode
        rec["probe_out"] = (pr.stdout + pr.stderr).strip()[-2000:]
    else:
        rec["stable_tail"] = tail(stable_log, 30)
        if rec["policy"] == "binary":
            log_lines = open(stable_log, errors="replace").read().splitlines()
            nonempty = [l for l in log_lines if l.strip()]
            write_artifact("step4-binary-resolution-failure.txt",
                           "# RF_STEP4_BIN stable leg with --only-binary=:all: "
                           f"(rc={rec['stable_rc']}): backtracking tail + "
                           "resolver verdict (exact)",
                           nonempty[-14:] + [
                               "# exact command: see step4-summary.json -> binary.stable_cmd "
                               f"(rc={rec['stable_rc']})"])
            rec["excerpt"] = "step4-binary-resolution-failure.txt"
    fr = subprocess.run([py, "-m", "pip", "freeze", "--exclude-editable"],
                        capture_output=True, text=True, env=ENV)
    rec["freeze_count"] = len([l for l in fr.stdout.splitlines() if "==" in l])
    rec["freeze_file"] = f"RF-step4-{rec['policy']}-freeze.txt"
    with open(os.path.join(REP, rec["freeze_file"]), "w") as f:
        f.write(f"# {' '.join(stable)} -> rc={rec['stable_rc']}\n")
        f.write(fr.stdout)
    return rec


def main(argv=None):
    p = argparse.ArgumentParser(
        description="H9 decisive RF-DETR ExecuTorch real-install test")
    p.add_argument("--work", default=os.environ.get("H9_WORK"),
                   help="work directory (or H9_WORK); created if missing")
    p.add_argument("--interp", default=os.environ.get("H9_INTERP"), metavar="PATH",
                   help="Python 3.12 interpreter (or H9_INTERP); "
                        "else python3.12 is looked up on PATH")
    p.add_argument("--timeout", type=int, default=3600,
                   help="per-stage pip timeout in seconds")
    p.add_argument("--target",
                   choices=["macos-arm64", "macos-x86_64", "linux-x86_64",
                            "windows-x86_64"],
                   help="assert the auto-detected native release target")
    args = p.parse_args(argv)
    if not args.work:
        p.error("no work directory: pass --work DIR or set H9_WORK")
    interp = args.interp or shutil.which("python3.12")
    if not interp:
        p.error("no interpreter: pass --interp PATH or set H9_INTERP "
                "(looked for python3.12 on PATH)")
    target = native_target()
    if args.target and args.target != target:
        p.error(f"--target asserted {args.target}, but the native interpreter "
                f"reports {target}; refusing cross-target simulation")
    configure(args.work, interp, args.timeout)
    out = {"host": f"{platform.system()} {platform.machine()}, real {interp}",
           "target": target}
    out["ordinary"] = leg("RF_STEP4_ORD", [])
    out["binary"] = leg("RF_STEP4_BIN", ["--only-binary=:all:"])
    json.dump(out, open(os.path.join(REP, "step4-summary.json"), "w"), indent=2)
    print(json.dumps({k: {kk: v for kk, v in leg.items() if kk != "probe_out"}
                      for k, leg in out.items() if isinstance(leg, dict)}, indent=2))
    for k in ("ordinary", "binary"):
        if "probe_out" in out[k]:
            print(f"--- {k} probe ---")
            print(out[k]["probe_out"])


if __name__ == "__main__":
    main()
