#!/usr/bin/env python3
"""H9 wheel-policy audit: manifest/summary consistency assertions.

Validates the tracked evidence in this directory WITHOUT network or /private/tmp.

Evidence layout (deduplicated): each route manifest stores only the DELTA
(packages the leg would newly install, overrides included); the shared base
environment lives once per interpreter/policy in UL-base-*/RF-*-base-* files
(referenced by the manifest's `# base:` header). Full manifest = base with
delta applied as overrides (delta wins on version conflicts). Route
classification compares reconstructed full manifests, never bare exit codes.

Usage: `python3 check_manifests.py`; exits nonzero on any mismatch.
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MAN = os.path.join(HERE, "manifests")
FAILURES = []


def check(name, cond, detail=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")
    if not cond:
        FAILURES.append(name)


def norm(name):
    s = "".join(ch if ch.isalnum() else "-" for ch in name.lower())
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")


def splitv(line):
    n, v = line.split("==", 1)
    return norm(n), v.strip()


def lines(path):
    with open(path) as f:
        return [l.strip() for l in f if l.strip() and not l.startswith("#")]


def base_of(manifest_name):
    for line in open(os.path.join(MAN, manifest_name)):
        if line.startswith("# base:"):
            return line.split("manifests/")[1].split()[0].strip()
    raise AssertionError(f"no # base header in {manifest_name}")


def full(manifest_name):
    """Reconstructed full manifest: base dict with delta applied as overrides."""
    based = {}
    for line in lines(os.path.join(MAN, base_of(manifest_name))):
        n, v = splitv(line)
        based[n] = v
    for line in lines(os.path.join(MAN, manifest_name)):
        n, v = splitv(line)
        based[n] = v
    return based


def has(manifest_name, prefix):
    return any(f"{n}=={v}" == prefix for n, v in full(manifest_name).items())


summaries = json.load(open(os.path.join(HERE, "sweep-summaries.json")))

for sname, s in sorted(summaries.items()):
    for row in s["rows"]:
        g = row["group"]
        if row.get("verdict") == "gated-skipped":
            continue
        for leg in ("ord_manifest", "bin_manifest"):
            p = os.path.join(MAN, row[leg])
            check(f"{sname}:{g}:{leg}-exists", os.path.exists(p), row[leg])
            if os.path.exists(p) and row["verdict"] not in ("binary failure",
                                                             "timeout/non-convergence"):
                try:
                    base_of(row[leg])
                    ok = True
                except AssertionError:
                    ok = False
                check(f"{sname}:{g}:{leg}-has-base", ok, row[leg])
        if row["verdict"] == "identical":
            fo, fb = full(row["ord_manifest"]), full(row["bin_manifest"])
            check(f"{sname}:{g}-identical-nonempty", len(fo) > 0, f"n={len(fo)}")
            check(f"{sname}:{g}-identical-equal", fo == fb,
                  "" if fo == fb else
                  f"ord-only={sorted(set(fo.items()) - set(fb.items()))[:4]} "
                  f"bin-only={sorted(set(fb.items()) - set(fo.items()))[:4]}")

# Decisive: ordinary executorch closures (fresh + onnxpop) contain the sdist-only pin.
for m in ["ul_executorch_py310_ordinary.txt", "ul_executorch_py311_ordinary.txt",
          "ul_executorch_py312_ordinary.txt", "ul_executorch_py313_ordinary.txt",
          "rf_executorch_py310_ordinary.txt", "rf_executorch_py311_ordinary.txt",
          "rf_executorch_py312_fresh_ordinary.txt", "rf_executorch_py312_onnxpop_ordinary.txt",
          "rf_executorch_py313_ordinary.txt"]:
    check(f"antlr-in-{m}", has(m, "antlr4-python3-runtime==4.9.3"))

# Divergent ul_executorch (3.10-3.12): ordinary 1.4.1/torch-2.14 vs binary 0.6.0/torch-2.7, no antlr.
for t in ["py310", "py311", "py312"]:
    check(f"ul_executorch-{t}-ordinary-picks-1.4.1",
          has(f"ul_executorch_{t}_ordinary.txt", "executorch==1.4.1"))
    check(f"ul_executorch-{t}-binary-falls-back-0.6.0",
          has(f"ul_executorch_{t}_binary.txt", "executorch==0.6.0"))
    check(f"ul_executorch-{t}-binary-downgrades-torch",
          has(f"ul_executorch_{t}_binary.txt", "torch==2.7.0"))
    check(f"ul_executorch-{t}-binary-drops-antlr",
          not any(n == "antlr4-python3-runtime" for n in full(f"ul_executorch_{t}_binary.txt")))

# No native ordinary closure may contain stringcase (it appeared only in the
# Linux-gated ul_imx closure of the prior draft, outside the native macOS path).
sc_hit = [os.path.basename(f) for f in glob.glob(os.path.join(MAN, "*_ordinary.txt"))
          if any(n == "stringcase" for n in full(os.path.basename(f)))]
check("no-stringcase-in-native-ordinary-closures", sc_hit == [], f"hits={sc_hit}")

# flatc prerelease stage: single pinned wheel package, identical legs.
for m in ["rf_executorch_flatc_pre_py310", "rf_executorch_flatc_pre_py311",
          "rf_executorch_flatc_pre_py312_fresh", "rf_executorch_flatc_pre_py312_onnxpop",
          "rf_executorch_flatc_pre_py313"]:
    for leg in ["ordinary", "binary"]:
        check(f"flatc-{m}-{leg}-single-wheel",
              lines(os.path.join(MAN, f"{m}_{leg}.txt")) == ["flatc==25.12.19rc0"],
              f"{m}_{leg}.txt")

# Fresh-runtime bases identical across policies (byte-identical pairs).
for t in ["py310", "py311", "py312", "py313"]:
    a = open(os.path.join(MAN, f"UL-base-{t}-ORD.txt"), "rb").read()
    b = open(os.path.join(MAN, f"UL-base-{t}-BIN.txt"), "rb").read()
    check(f"UL-base-{t}-identical-across-policies", len(a) > 0 and a == b,
          f"bytes={len(a)}")
# RF fresh bases are empty; ONNX-populated bases identical across policies.
check("RF-fresh-base-empty",
      lines(os.path.join(MAN, "RF-fresh-base-empty.txt")) == [])
ao = open(os.path.join(MAN, "RF-onnx-base-py312-ORD.txt"), "rb").read()
ab = open(os.path.join(MAN, "RF-onnx-base-py312-BIN.txt"), "rb").read()
check("RF-onnx-base-identical-across-policies",
      lines(os.path.join(MAN, "RF-onnx-base-py312-ORD.txt")) ==
      lines(os.path.join(MAN, "RF-onnx-base-py312-BIN.txt")))

# envmeta: fresh-runtime base installs exited 0 on all interpreters.
env = json.load(open(os.path.join(HERE, "envmeta.json")))
for t in ["py310", "py311", "py312", "py313"]:
    for leg in ["UL_ORD", "UL_BIN"]:
        check(f"envmeta-{t}-{leg}-rc0", env[t][leg]["install_rc"] == 0,
              env[t][leg]["install_cmd"].split("/bin/python")[-1])
check("envmeta-onnxpop-both-rc0",
      env["onnxpop_py312"]["ORD"]["install_rc"] == 0
      and env["onnxpop_py312"]["BIN"]["install_rc"] == 0)

if FAILURES:
    print(f"\n{len(FAILURES)} ASSERTION(S) FAILED: {FAILURES}")
    raise SystemExit(1)
print("\nall manifest assertions passed")
