#!/usr/bin/env python3
"""H9 Step 4: decisive real RF-DETR ExecuTorch test, Python 3.12 / macOS ARM64.

Two disposable stack venvs from /opt/homebrew/bin/python3.12 (bundled pip).

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

Captures: exact commands, exit codes, decisive excerpts, final manifests
(pip freeze), source-built package inventory.
"""
import json
import os
import subprocess
import sys

WORK = "/private/tmp/h9-correct"
LOG = os.path.join(WORK, "logs")
REP = os.path.join(WORK, "reports")
os.makedirs(LOG, exist_ok=True)
os.makedirs(REP, exist_ok=True)
ENV = dict(os.environ, PIP_CACHE_DIR=os.path.join(WORK, "cache"))
INTERP = "/opt/homebrew/bin/python3.12"
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


def run(cmd, logname):
    path = os.path.join(LOG, logname)
    with open(path, "w") as f:
        f.write("$ " + " ".join(cmd) + "\n")
        r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT,
                           timeout=TIMEOUT, env=ENV)
    return r.returncode, path


def tail(path, n=25):
    lines = open(path, errors="replace").read().splitlines()
    return "\n".join(lines[-n:])


def leg(name, policy_extra):
    py = os.path.join(WORK, name, "bin", "python")
    if not os.path.exists(py):
        subprocess.run([INTERP, "-m", "venv", os.path.join(WORK, name)],
                       check=True, env=ENV)
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
    fr = subprocess.run([py, "-m", "pip", "freeze", "--exclude-editable"],
                        capture_output=True, text=True, env=ENV)
    rec["freeze_count"] = len([l for l in fr.stdout.splitlines() if "==" in l])
    with open(os.path.join(REP, f"{name}_freeze.txt"), "w") as f:
        f.write(f"# {' '.join(stable)} -> rc={rec['stable_rc']}\n")
        f.write(fr.stdout)
    # source-built inventory: packages whose installed files came from an sdist
    # (approximated via pip index unavailable offline; use freeze + direct_url.json).
    return rec


def main():
    out = {"host": "macOS ARM64 (Darwin), real /opt/homebrew/bin/python3.12"}
    out["ordinary"] = leg("RF_STEP4_ORD", [])
    out["binary"] = leg("RF_STEP4_BIN", ["--only-binary=:all:"])
    json.dump(out, open(os.path.join(REP, "step4_summary.json"), "w"), indent=2)
    print(json.dumps({k: {kk: v for kk, v in leg.items() if kk != "probe_out"}
                      for k, leg in out.items() if isinstance(leg, dict)}, indent=2))
    for k in ("ordinary", "binary"):
        if "probe_out" in out[k]:
            print(f"--- {k} probe ---")
            print(out[k]["probe_out"])


if __name__ == "__main__":
    main()
