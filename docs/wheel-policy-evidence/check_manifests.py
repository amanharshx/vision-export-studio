#!/usr/bin/env python3
"""H9 wheel-policy audit: manifest/summary consistency assertions.

Validates the tracked evidence in this directory WITHOUT network or /private/tmp:
  * every manifest referenced by sweep-summaries.json exists;
  * `identical` rows have byte-equal, non-empty manifest bodies;
  * `divergent` rows differ in the stated direction;
  * decisive antlr/flatc facts hold in the manifests;
  * no native ordinary closure contains stringcase;
  * UL fresh-runtime base freezes are identical across policies;
  * envmeta install records show rc 0 for the fresh-runtime bases.

One annotation is honored: summary_py312.json -> "rf_rows_superseded_by", because
the py312 fresh-stack RF manifests were later re-resolved under the distinct
tag py312fresh (tracked in summary_py312fresh.json) while the py312 RF manifest
names now carry the ONNX-populated state (tracked in summary_py312_onnxpop.json).
The annotation is part of the tracked evidence, not hidden.

Usage: `python3 check_manifests.py`; exits nonzero on any mismatch.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MAN = os.path.join(HERE, "manifests")
FAILURES = []


def check(name, cond, detail=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")
    if not cond:
        FAILURES.append(name)


def body(path):
    with open(path) as f:
        return sorted(l for l in (x.strip() for x in f) if l and not l.startswith("#"))


def has(manifest_body, prefix):
    return any(l == prefix or l.startswith(prefix + " ") for l in manifest_body)


summaries = json.load(open(os.path.join(HERE, "sweep-summaries.json")))

for sname, s in sorted(summaries.items()):
    skip_rf = s.get("rf_rows_superseded_by", [])
    if skip_rf:
        print(f"[info] {sname}: RF rows superseded by {skip_rf}; validating UL rows only")
    for row in s["rows"]:
        g = row["group"]
        if g in ("rf_onnx", "rf_coreml", "rf_tflite", "rf_executorch",
                 "rf_executorch_flatc_pre") and skip_rf:
            continue
        if row.get("verdict") == "gated-skipped":
            continue
        for leg in ("ord_manifest", "bin_manifest"):
            p = os.path.join(MAN, row[leg])
            check(f"{sname}:{g}:{leg}-exists", os.path.exists(p), row[leg])
        if row["verdict"] == "identical":
            bo = body(os.path.join(MAN, row["ord_manifest"]))
            bb = body(os.path.join(MAN, row["bin_manifest"]))
            check(f"{sname}:{g}-identical-nonempty", len(bo) > 0, f"n={len(bo)}")
            check(f"{sname}:{g}-identical-equal", bo == bb,
                  "" if bo == bb else f"ord-only={sorted(set(bo) - set(bb))[:5]} "
                                      f"bin-only={sorted(set(bb) - set(bo))[:5]}")

# Decisive: ordinary executorch closures (fresh + onnxpop) contain the sdist-only pin.
for m in ["ul_executorch_py310_ordinary.txt", "ul_executorch_py311_ordinary.txt",
          "ul_executorch_py312_ordinary.txt", "ul_executorch_py313_ordinary.txt",
          "rf_executorch_py310_ordinary.txt", "rf_executorch_py311_ordinary.txt",
          "rf_executorch_py312_ordinary.txt", "rf_executorch_py313_ordinary.txt"]:
    p = os.path.join(MAN, m)
    if os.path.exists(p):
        check(f"antlr-in-{m}", has(body(p), "antlr4-python3-runtime==4.9.3"))

# Divergent ul_executorch (3.10-3.12): ordinary 1.4.1/torch-2.14 vs binary 0.6.0/torch-2.7, no antlr.
for t in ["py310", "py311", "py312"]:
    bo = body(os.path.join(MAN, f"ul_executorch_{t}_ordinary.txt"))
    bb = body(os.path.join(MAN, f"ul_executorch_{t}_binary.txt"))
    check(f"ul_executorch-{t}-ordinary-picks-1.4.1", has(bo, "executorch==1.4.1"))
    check(f"ul_executorch-{t}-binary-falls-back-0.6.0", has(bb, "executorch==0.6.0"))
    check(f"ul_executorch-{t}-binary-downgrades-torch", has(bb, "torch==2.7.0"))
    check(f"ul_executorch-{t}-binary-drops-antlr",
          not any(l.startswith("antlr4-python3-runtime==") for l in bb))

# No native ordinary closure may contain stringcase (it appeared only in the
# Linux-gated ul_imx closure of the prior draft, outside the native macOS path).
import glob as _glob
native_ord = [f for f in _glob.glob(os.path.join(MAN, "*_ordinary.txt"))
              if os.path.basename(f) != "rf_executorch_py312_ordinary.txt"
              or True]
sc_hit = [f for f in native_ord
          if any(l.startswith("stringcase==") for l in body(f))]
check("no-stringcase-in-native-ordinary-closures", sc_hit == [],
      f"hits={[os.path.basename(f) for f in sc_hit]}")

# flatc prerelease stage: single pinned wheel package, identical legs.
for t in ["py310", "py311", "py312", "py313"]:
    for leg in ["ordinary", "binary"]:
        m = f"rf_executorch_flatc_pre_{t}_{leg}.txt"
        check(f"flatc-{t}-{leg}-single-wheel", body(os.path.join(MAN, m)) == ["flatc==25.12.19rc0"], m)

# Fresh-runtime bases identical across policies.
for t in ["py310", "py311", "py312", "py313"]:
    a = body(os.path.join(MAN, f"UL-base-{t}-ORD.txt"))
    b = body(os.path.join(MAN, f"UL-base-{t}-BIN.txt"))
    check(f"UL-base-{t}-identical-across-policies", len(a) > 0 and a == b, f"n={len(a)}")

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
