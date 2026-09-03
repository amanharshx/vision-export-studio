#!/usr/bin/env python3
"""H9 wheel-policy audit: PyPI distribution-availability assertions.

Queries the PyPI JSON API and ASSERTS the platform-independent metadata facts
the audit relies on. Prints observed values, exits nonzero on any mismatch.

Cited by docs/wheel-policy-audit.md. Re-run: `python3 check_pypi.py`.
"""
import json
import re
import sys
import urllib.request

FAILURES = []


def check(name, cond, detail):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}: {detail}")
    if not cond:
        FAILURES.append(name)


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def files(name, version):
    return get(f"https://pypi.org/pypi/{name}/{version}/json")["urls"]


def releases(name):
    return get(f"https://pypi.org/pypi/{name}/json")["releases"]


# 1. antlr4-python3-runtime==4.9.3 is sdist-only; the whole 4.9.* line has no wheel.
a493 = files("antlr4-python3-runtime", "4.9.3")
a493_types = sorted({f["packagetype"] for f in a493})
check("antlr-4.9.3-sdist-only",
      len(a493) == 1 and a493_types == ["sdist"],
      f"files={[f['filename'] for f in a493]}")
rel = releases("antlr4-python3-runtime")
wheeled_49 = sorted(v for v, fs in rel.items()
                    if v.startswith("4.9.") and any(f["packagetype"] == "bdist_wheel" for f in fs))
check("antlr-no-4.9-wheel-anywhere", wheeled_49 == [], f"4.9.* with wheel: {wheeled_49}")
wheeled = sorted(v for v, fs in rel.items() if any(f["packagetype"] == "bdist_wheel" for f in fs))
print(f"  [info] antlr versions WITH a wheel: {wheeled}")

# 2. flatc prerelease stage: only 25.12.19rc0; 3 wheels, no sdist, no macOS x86_64.
frel = releases("flatc")
print(f"  [info] flatc releases: {sorted(frel)}")
frc = frel.get("25.12.19rc0", [])
fnames = sorted(f["filename"] for f in frc)
ftypes = sorted({f["packagetype"] for f in frc})
check("flatc-single-prerelease", sorted(frel) == ["25.12.19rc0"], f"releases={sorted(frel)}")
check("flatc-no-sdist", "sdist" not in ftypes, f"packagetypes={ftypes}")
check("flatc-three-wheels", len(frc) == 3, f"files={fnames}")
check("flatc-no-macosx-x86_64",
      not any("macosx" in n and "x86_64" in n for n in fnames), f"files={fnames}")
check("flatc-has-arm64-linux-win",
      any("macosx_11_0_arm64" in n for n in fnames)
      and any("manylinux" in n and "x86_64" in n for n in fnames)
      and any("win_amd64" in n for n in fnames), f"files={fnames}")

# 3. torch: no macOS x86_64 wheel for modern versions; no cp313 x86_64 wheel anywhere.
trel = releases("torch")
stable = [v for v in trel if re.fullmatch(r"\d+\.\d+\.\d+", v)]
stable.sort(key=lambda s: [int(x) for x in re.findall(r"\d+", s)][:3])
recent = [v for v in stable if [int(x) for x in re.findall(r"\d+", v)][:2] >= [2, 10]]
print(f"  [info] recent stable torch: {recent}")
modern_x86 = {}
for v in recent:
    hits = [f["filename"] for f in trel.get(v, [])
            if f["filename"].endswith(".whl") and "macosx" in f["filename"]
            and "x86_64" in f["filename"]]
    modern_x86[v] = hits
check("torch-no-modern-macosx-x86_64",
      all(h == [] for h in modern_x86.values()),
      f"macosx-x86_64 wheels in {recent}: { {k: v for k, v in modern_x86.items() if v} }")
cp313_x86 = sorted({v for v, fs in trel.items() for f in fs
                    if f["filename"].endswith(".whl") and "macosx" in f["filename"]
                    and "x86_64" in f["filename"] and "cp313" in f["filename"]})
check("torch-no-cp313-macosx-x86_64-anywhere", cp313_x86 == [], f"versions={cp313_x86}")
for v in ["2.13.0", "2.14.0"]:
    ttypes = sorted({f["packagetype"] for f in trel.get(v, [])})
    check(f"torch-{v}-wheels-only-no-sdist", ttypes == ["bdist_wheel"],
          f"packagetypes={ttypes} (no sdist: nothing to slow-build on macOS x86_64)")
last_x86 = sorted({v for v, fs in trel.items() for f in fs
                   if f["filename"].endswith(".whl") and "macosx" in f["filename"]
                   and "x86_64" in f["filename"]},
                  key=lambda s: [int(x) for x in re.findall(r"\d+", s)][:3])
print(f"  [info] torch versions with ANY macosx x86_64 wheel: first={last_x86[:3]} last={last_x86[-3:]}")
check("torch-x86_64-line-ends-at-2.2.x",
      all([int(x) for x in re.findall(r"\d+", v)][:2] <= [2, 2] for v in last_x86),
      f"count={len(last_x86)}")

# 4. stringcase 1.2.0 availability (informational: the audit ties relevance to
# route closures, not to this fact alone).
sc = files("stringcase", "1.2.0")
print(f"  [info] stringcase 1.2.0 files: {[f['filename'] for f in sc]}")

if FAILURES:
    print(f"\n{len(FAILURES)} ASSERTION(S) FAILED: {FAILURES}")
    sys.exit(1)
print("\nall PyPI assertions passed")
