# Binary-wheel policy audit (issue #94)

Status: **partial audit — Recommendation 1 stands on decisive native evidence;
full-matrix coverage is pending native CI.** This document does not change
installer behavior and does not authorize any comment on issue #94.

- Audit date: 2026-09-03 (correction of `60d0460`)
- Repository commit audited: `3cbf09ddc7791756ae04627007144de7d58d1097` (`origin/main`, v0.1.13)
- Audit commits: `60d0460` (superseded draft) → this correction (follow-up, no amend)
- `origin/main` verified unmoved relative to `3cbf09d` at correction time
  (`git rev-parse origin/main` == `3cbf09d`, worktree clean, HEAD contains `60d0460`)
- Issue: https://github.com/amanharshx/vision-export-studio/issues/94
- Handoff: `MAINTENANCE_HANDOFFS.md` → Handoff 9
- Evidence: `docs/wheel-policy-evidence/` (tracked; self-sufficient — no `/private/tmp` access needed)

## Question

Issue #94 proposes passing `--only-binary=:all:` to every dependency install so
that unsupported installs fail fast instead of letting pip fall back to a slow
source build (motivating example: `torch` building for a long time before
failing). This audit asks whether that policy is safe across the supported
OS / architecture / Python / route matrix, and returns exactly one of three
recommendations.

## Recommendation

**Recommendation 1: reject a blanket `--only-binary=:all:` policy and close #94
with evidence.**

One supported, installable route is sufficient to reject a *global* policy, and
this audit produces it natively: on Python 3.12 / macOS ARM64, the exact
RF-DETR ExecuTorch payload installs cleanly today (observed: `rfdetr 1.9.4`,
`executorch 1.4.1`, `torch 2.14.0`, `pip check` clean, readiness probes pass),
while the identical payload with `--only-binary=:all:` fails in the real
installer path (`error: resolution-too-deep`, exit 1, nothing installed). The
root cause is platform-independent package metadata — `hydra-core` (pulled via
`executorch`) pins `antlr4-python3-runtime==4.9.*`, and no `4.9.x` wheel exists
on PyPI for any platform — so the rejection generalizes beyond the tested host
(inferred, from metadata; native runs on other targets remain pending CI).

Recommendations 2 and 3 are **not endorsed**: selective or allowlisted
binary-only policies were not tested, and non-ARM64 targets have no native runs
yet. See *Limitations and remaining CI work*.

## What the app actually runs (installer contract, from `3cbf09d`)

Traced through `src-tauri/src/commands/deps.rs`,
`src-tauri/src/commands/stack_environments.rs`,
`src-tauri/src/commands/setup.rs`,
`src-tauri/src/commands/provider_registry.rs`, and
`src/features/export/export-workspace.tsx`.

Install command — `build_pip_install_command` (`deps.rs:1572`):

```
python -m pip install [--pre] <packages...>
```

- **No** `--only-binary`, **no** `--ignore-installed`, **no** `--upgrade` today.
- pip is **never upgraded**: setup creates the venv with `python -m venv .venv`
  only (`create_runtime_venv`, `setup.rs`), so each interpreter's *bundled* pip
  is used (observed: 23.0.1 / 24.0 / 26.2.1 / 25.2 for Python 3.10–3.13).
- `--pre` is applied to the whole prerelease group in one invocation.
  `install_dependencies` (`deps.rs:1418`) splits packages into a stable stage
  and a prerelease stage via `partition_install_packages`; the stable stage runs
  first, then the prerelease stage with `--pre` (if the stable set is empty the
  prerelease stage runs first).
- The proposed #94 flag would live in `build_pip_install_command`, so it would
  apply to **every** stage: the Ultralytics runtime install, each route install,
  and both the RF-DETR stable and `--pre flatc` stages.

Frontend package collection — `getInstallableMissingPackages`
(`export-workspace.tsx:499`): a dependency result is sent to the installer only
if it carries an `install_package` (→ `{package, prerelease: result.prerelease
=== true}`), or if it is a `missing_binary` whose hint starts with `pip install `.
Everything else is skipped, then results are de-duplicated by package name.

Two Ultralytics install states (corrected — the `60d0460` draft described only
the second):

1. **Fresh runtime setup** (`handleInstallUltralyticsRuntime`,
   `export-workspace.tsx:1496`) sends the **bare** name:
   `pip install ultralytics` (no version floor).
2. **Route dependency remedy** (`check_ultralytics_dep`, `deps.rs:1210`): when
   Ultralytics is absent, or present but below the route floor, the result
   carries `ultralytics>=8.4.80` (or `>=8.4.83` for LiteRT). This is the
   `missing_package` / `version_too_old` remedy, not the fresh-setup command.

Consequences:

- **Optional deps are never auto-installed.** `onnxslim` (the ONNX route's only
  optional dep) returns status `warning` with `install_package = None`
  (`check_pip_dep`, `deps.rs:1263`), so it is dropped by the frontend. The ONNX
  route's auto-install payload is `onnx` alone.
- **Axelera uses the bare name `axelera`.** `route_deps` sets `package_name =
  "axelera"` with hint `pip install axelera-devkit` (`deps.rs:445`); the pip
  remedy installs `install_package` (`axelera`), not the hint text. (Reported
  as-is; the route is Linux-only and platform-gated off macOS.)
- **`flatc` is a real prerelease stage.** A fresh RF-DETR ExecuTorch stack
  (`missing_stack_results`, `deps.rs:1168`) yields three results:
  `rfdetr[executorch]>=1.9.0` and `torch>=2.13` (stable stage), plus `flatc`
  with `prerelease = Some(true)` (→ `pip install --pre flatc`).

### Environments

- **Ultralytics routes** share one managed environment
  (`ULTRALYTICS_MANAGED_KEY = "ultralytics-managed"`,
  `managed_environments.rs:17`), rooted at `<runtime_dir>/.venv`. Route
  packages install into this already-populated environment, so route payloads
  were resolved in populated envs in this audit.
- **RF-DETR routes** use four dedicated stack venvs (`stack_environments.rs`,
  `KNOWN_STACKS`), each at `<runtime_dir>/envs/<key>/.venv`, created fresh from
  the selected interpreter:
  - `rfdetr-default` → `rfdetr.pth.onnx` **and** `rfdetr.pth.executorch` (**shared**)
  - `rfdetr-tensorrt` → `rfdetr.pth.engine`
  - `rfdetr-coreml` → `rfdetr.pth.coreml`
  - `rfdetr-tflite` → `rfdetr.pth.tflite` (stack `python_requirement >=3.12, <3.13`)
- Because `rfdetr-default` is shared, the ExecuTorch payload was tested in **two
  stack states** on Python 3.12: fresh (empty stack venv) and ONNX-populated
  (stack venv with a real `rfdetr[onnx]` install). ONNX-populated states on
  other Pythons are unverified.

### Routes vs. payloads

There are **21 export routes** (16 Ultralytics including `saved_model`+`pb`, and
5 RF-DETR). They collapse to fewer **distinct pip payloads**: `torchscript` has
no pip deps; `saved_model` and `pb` share one payload (`edgetpu` shares the pip
payload but adds a Linux-only sys binary and gate); several routes share `onnx`.
The tables below label payload groups, not route counts.

Exact install_package payloads (missing-everything case), with platform gates
from `route_platform_lock` (`provider_registry.rs:94`) and Python gates from
`deps.rs` / `stack_environments.rs`:

| Group | Routes | Stable payload | Prerelease payload | Env | Platform gate |
| --- | --- | --- | --- | --- | --- |
| ul_torchscript | torchscript | *(none — no installer call)* | — | ultralytics-managed | all |
| ul_onnx | onnx | `onnx` (onnxslim optional, excluded) | — | ultralytics-managed | all |
| ul_openvino | openvino | `openvino nncf` | — | ultralytics-managed | all |
| ul_coreml | coreml | `coremltools` | — | ultralytics-managed | macOS and Linux |
| ul_ncnn | ncnn | `ncnn pnnx` | — | ultralytics-managed | all |
| ul_mnn | mnn | `MNN onnx` | — | ultralytics-managed | all |
| ul_litert | litert | `litert-torch>=0.9.0 ai-edge-litert>=2.1.4` | — | ultralytics-managed | macOS (any arch) + Linux x86_64; Python ≥3.10 |
| ul_tfgraph | saved_model, pb (+ edgetpu pip part) | `tensorflow onnx2tf onnx onnxruntime` | — | ultralytics-managed | saved_model/pb: all; edgetpu route: Linux x86_64 + `edgetpu_compiler` sys binary |
| ul_paddle | paddle | `paddlepaddle x2paddle` | — | ultralytics-managed | all |
| ul_executorch | executorch | `executorch` | — | ultralytics-managed | all |
| ul_engine | engine | `tensorrt` | — | ultralytics-managed | Linux and Windows (NVIDIA GPU required) |
| ul_rknn | rknn | `rknn-toolkit2 onnx` | — | ultralytics-managed | Linux |
| ul_imx | imx | `model-compression-toolkit sony-custom-layers imx500-converter` | — | ultralytics-managed | Linux |
| ul_axelera | axelera | `axelera` | — | ultralytics-managed | Linux |
| rf_onnx | rfdetr onnx | `rfdetr[onnx]` | — | rfdetr-default | all |
| rf_engine | rfdetr engine | `rfdetr[tensorrt]` | — | rfdetr-tensorrt | Linux and Windows (NVIDIA GPU required) |
| rf_coreml | rfdetr coreml | `rfdetr[coreml]` | — | rfdetr-coreml | macOS |
| rf_tflite | rfdetr tflite | `rfdetr[tflite]>=1.9.4` | — | rfdetr-tflite | all platforms; Python ≥3.12, <3.13 |
| rf_executorch | rfdetr executorch | `rfdetr[executorch]>=1.9.0 torch>=2.13` | `flatc` (`--pre`) | rfdetr-default | macOS ARM64 14+ / Linux x86_64 / Windows x86_64 (macOS x86_64 excluded) |

Corrections vs the `60d0460` draft: Ultralytics CoreML is macOS **and** Linux
(not macOS-only); both TensorRT gates are Linux **and** Windows (not bare
"NVIDIA"); RF-DETR ExecuTorch excludes macOS x86_64 and needs macOS 14+ on
ARM64; LiteRT is macOS (any arch) + Linux x86_64; Edge TPU is Linux x86_64; the
fresh runtime installs bare `ultralytics`.

## Supported matrix

Release targets (`.github/workflows/release.yml`): **macOS ARM64
(aarch64-apple-darwin), macOS x86_64, Linux x86_64 (ubuntu-22.04), Windows
x86_64**. There is **no Linux ARM64** release. Managed runtime supports Python
**3.10–3.13** (`setup.rs:299`, verify script `(3,10) <= v <= (3,13)`); RF-DETR
TFLite is gated to Python ≥3.12, <3.13; LiteRT needs Python ≥3.10.

## Method

- Host: macOS 26.5.2, `arm64`.
- Real native interpreters, each with its **bundled** venv pip (never upgraded,
  as the app does). Interpreter identity and pip versions are observed in
  `docs/wheel-policy-evidence/envmeta.json`:

  | Python | Interpreter path | Version | Arch | Venv pip |
  | --- | --- | --- | --- | --- |
  | 3.10 | `/Users/aman/.local/bin/python3.10` | 3.10.19 | arm64 | 23.0.1 |
  | 3.11 | `/Users/aman/.pyenv/versions/3.11.9/bin/python3.11` | 3.11.9 | arm64 | 24.0 |
  | 3.12 | `/opt/homebrew/bin/python3.12` | 3.12.14 | arm64 | 26.2.1 |
  | 3.13 | `/opt/homebrew/bin/python3.13` | 3.13.7 | arm64 | 25.2 |

- Temporary venvs only, under `/private/tmp/h9-correct` (drivers
  `docs/wheel-policy-evidence/sweep.py` and `step4.py`; shared pip cache, since
  removed from evidence). The managed runtime at `~/.vision-export-studio` was
  never read, written, or touched.
- Faithfulness rules: **no `--ignore-installed`** (the app never passes it);
  **separate ordinary-policy and binary-policy base envs per interpreter** —
  `UL_ORD_<py>` built with the exact fresh-runtime command
  `pip install ultralytics` (bare), `UL_BIN_<py>` with
  `pip install --only-binary=:all: ultralytics`. Both base installs exited 0 on
  all four interpreters with byte-identical freezes
  (`manifests/UL-base-<py>-<ORD|BIN>.txt`: ultralytics 8.4.138, torch 2.14.0) —
  so the proposed policy would not break the fresh runtime itself.
  Ultralytics route payloads resolved in these populated envs; RF-DETR payloads
  in fresh stack venvs (`RF_FRESH_ORD|BIN_<py>`), plus ONNX-populated stack venvs
  on 3.12 (`RF_ONNX_ORD|BIN_py312`, real `rfdetr[onnx]` install, exit 0 both legs).
- Each payload was resolved twice — ordinary and `--only-binary=:all:` — via
  `pip install --dry-run --report <file>` with a 300s cap per leg, and, for the
  decisive route, installed for real. The binary policy was applied to both the
  stable and the `--pre flatc` stages.
- Manifests: normalized sorted `name==version` (lowercased, `base freeze UNION
  report delta`), one file per cell
  (`docs/wheel-policy-evidence/manifests/<group>_<py>_<ordinary|binary>.txt`,
  exact command in each header). Classification compares manifests, never bare
  exit-code pairs:
  - `identical`: both succeed with identical manifests;
  - `divergent`: both succeed with different manifests;
  - `binary failure`: ordinary succeeds, binary leg exits nonzero;
  - `timeout/non-convergence`: a leg did not converge within 300s (recorded as
    such — never as an unsatisfiability result);
  - `unverified` / `gated-skipped`: not tested or excluded by an app gate.
- Platform-gated routes (`ul_engine`, `ul_rknn`, `ul_imx`, `ul_axelera`,
  Edge TPU, `rf_engine`) are **excluded from the native macOS table**: the app
  rejects them via `validate_route_platform` before the installer ever runs, so
  resolving them on macOS would be a simulation outside the app's native
  execution path. Their wheel coverage on their own platforms is unverified
  (needs native CI).
- Validation: `check_pypi.py` (PyPI availability assertions, exit 0) and
  `check_manifests.py` (290 evidence-consistency assertions over the tracked
  manifests/summaries/envmeta, exit 0). `pypi-availability.txt` is the captured
  output of the former.
- Note on `summary_py312.json`: its RF rows describe the original fresh-stack
  runs whose manifest files were later overwritten by the ONNX-populated rerun
  (same filenames, headers record the `RF_ONNX_*` env). The tracked copy is
  annotated (`rf_rows_superseded_by`): fresh-stack py312 RF evidence lives in
  `summary_py312fresh.json` + `manifests/*_py312fresh_*.txt`, ONNX-populated
  evidence in `summary_py312_onnxpop.json` + `manifests/rf_*_py312_*.txt`
  (headers confirm the env). UL rows of `summary_py312.json` are unaffected.

## Results — resolution sweep (macOS ARM64, native app path only)

`ord` / `bin` = exit status of the ordinary / `--only-binary=:all:` dry-run
leg. `Δ` = packages the leg would newly install. Manifests linked per cell;
verdicts computed by manifest comparison (`sweep-summaries.json`).

| Group | 3.10 | 3.11 | 3.12 (fresh stack) | 3.12 (ONNX-populated) | 3.13 | Verdict |
| --- | :--: | :--: | :--: | :--: | :--: | --- |
| ul_onnx | identical | identical | identical | — | identical | no-op (manifests equal) |
| ul_openvino | identical | identical | identical | — | identical | no-op |
| ul_coreml | identical | identical | identical | — | identical | no-op |
| ul_ncnn | identical | identical | identical | — | identical | no-op |
| ul_mnn | identical | identical | identical | — | identical | no-op |
| ul_litert | identical | identical | identical | — | identical | no-op |
| ul_tfgraph (saved_model, pb) | identical | identical | identical | — | identical | no-op |
| ul_paddle | identical | identical | identical | — | identical | no-op |
| ul_torchscript | identical¹ | identical¹ | identical¹ | — | identical¹ | no installer call |
| ul_executorch | divergent | divergent | divergent | — | **binary failure** | policy changes resolution (3.10–3.12) / rejects (3.13) |
| rf_onnx | identical | identical | identical | identical | identical | no-op |
| rf_coreml | identical | identical | identical | identical | identical | no-op |
| rf_tflite | —² | —² | identical | identical | —² | no-op (Python 3.12 gate) |
| rf_executorch | **binary failure** | **binary failure** | timeout | timeout | timeout | **policy rejects on every Python** |
| rf_executorch `--pre flatc` | identical | identical | identical | identical | identical | no-op (wheel exists) |

¹ `torchscript` declares no pip deps, so the installer is never invoked for it;
`identical` is structural, not a pip observation.
² App Python gate (`>=3.12, <3.13`): not installable off 3.12, so no native cell.

Binary-only failure modes for `rf_executorch`: `ResolutionImpossible` (exit 1)
on 3.10 and 3.11 with the `hydra-core → antlr4==4.9.*` conflict quoted verbatim
(`binary-failure-rf_executorch-py310.txt`,
`binary-failure-rf_executorch-py311.txt`); did-not-converge within 300s on 3.12
(fresh and ONNX-populated) and 3.13. `ul_executorch` binary leg fails with
`ResolutionImpossible` (same cause) on 3
(`binary-failure-rf_executorch-py310.txt`,
`binary-failure-rf_executorch-py311.txt`); did-not-converge within 300s on 3.12
(fresh and ONNX-populated) and 3.13. `ul_executorch` binary leg fails with
`ResolutionImpossible` (same cause) on 3.13 (`binary-failure-ul_executorch-py313.txt`).

## Decisive findings

### 1. `antlr4-python3-runtime==4.9.*` is source-only everywhere and gates ExecuTorch

PyPI JSON API, asserted by `check_pypi.py` (platform-independent):

```
antlr4-python3-runtime==4.9.3 : exactly 1 file, sdist, 0 wheels
  files: ['antlr4-python3-runtime-4.9.3.tar.gz']   (117 kB, 57 .py files, no compiled extensions)
  4.9.* versions WITH a wheel: NONE
  versions WITH a wheel: 4.11.0, 4.11.1, 4.12.0, 4.13.0, 4.13.1, 4.13.2
```

`executorch` → `hydra-core` pins `antlr4-python3-runtime==4.9.*` (observed in
the Step-4 install log:
`Collecting antlr4-python3-runtime==4.9.* (from hydra-core>=1.3.0->executorch<2.0,>=1.3->rfdetr[executorch]>=1.9.0)`),
and the entire `4.9.*` line is sdist-only. `--only-binary=:all:` therefore
cannot satisfy it on **any** platform. Classification: observed (native
resolution failures) + package-metadata fact (platform-independent).

### 2. Decisive real install — RF-DETR ExecuTorch, Python 3.12, macOS ARM64

Step-4 protocol (`docs/wheel-policy-evidence/step4.py`), two disposable stack
venvs from `/opt/homebrew/bin/python3.12` (bundled pip 26.2.1). Full record:
`step4-summary.json`.

Ordinary leg — every command exit 0:

| Stage | Exact command | Exit |
| --- | --- | ---: |
| stable | `pip install "rfdetr[executorch]>=1.9.0" "torch>=2.13"` | 0 |
| prerelease | `pip install --pre flatc` | 0 |
| check | `pip check` | 0 (`No broken requirements found.`) |
| probes | find_spec `rfdetr` / `executorch.exir` / `torch` + `rfdetr>=1.9.0`, `torch>=2.13` floors | 0 (all True) |

Resolved: `rfdetr 1.9.4`, `executorch 1.4.1`, `torch 2.14.0`,
`antlr4-python3-runtime 4.9.3` (built from sdist — see
`step4-ordinary-antlr-build.txt`), `flatc 25.12.19rc0`; final freeze 85
packages (`manifests/RF-step4-ordinary-freeze.txt`).

Binary leg — `pip install --only-binary=:all: "rfdetr[executorch]>=1.9.0"
"torch>=2.13"` → **exit 1**, `error: resolution-too-deep` ("Pip cannot resolve
the current dependencies..."), nothing installed (freeze 0 packages,
`manifests/RF-step4-binary-freeze.txt`). The backtracking tail (ancient
`pyparsing`/`packaging` metadata crawls) is captured in
`step4-binary-resolution-failure.txt`. Because the stable stage failed, the
`--pre flatc` stage never ran — matching the installer's own sequencing.

This directly proves an otherwise installable, supported route is rejected by
the proposed policy. Classification: observed.

### 3. Ultralytics ExecuTorch diverges silently on 3.10–3.12, fails on 3.13

Manifest comparison (populated shared env, both legs exit 0 on 3.10–3.12):

- ordinary: `executorch 1.4.1`, `torch 2.14.0`, `coremltools 9.0`,
  `antlr4-python3-runtime 4.9.3` (+ hydra-core/omegaconf);
- binary: `executorch 0.6.0`, `torch 2.7.0` (**downgrade of the shared
  environment's torch from 2.14.0**), `coremltools 8.2`, `torchaudio` added,
  antlr/hydra/omegaconf dropped.

Scoped to observed combinations only: Python 3.10, 3.11, 3.12, macOS ARM64,
populated `ultralytics-managed` starting from bare-`ultralytics` 8.4.138 /
torch 2.14.0. On 3.13 the same route's binary leg hard-fails with
`ResolutionImpossible` (pip failure output, same antlr cause). Because the
Ultralytics ExecuTorch route declares no minimum `executorch` version, this
audit does **not** claim 0.6.0 is functionally broken; the provable harm is an
unrequested silent mutation of a shared environment (3.10–3.12) or a hard
rejection (3.13). The RF-DETR ExecuTorch route removes the ambiguity: its
`torch>=2.13` floor forbids the downgrade escape, so the policy hard-fails
there on every tested Python. Classification: observed.

### 4. The `flatc` prerelease stage is a no-op under the policy

PyPI has exactly one `flatc` release, `25.12.19rc0` (a prerelease — why the app
uses `--pre`), shipping three wheels and no sdist (`check_pypi.py`):

```
flatc-25.12.19rc0-py3-none-macosx_11_0_arm64.whl
flatc-25.12.19rc0-py3-none-manylinux_2_24_x86_64.manylinux_2_28_x86_64.whl
flatc-25.12.19rc0-py3-none-win_amd64.whl
```

On macOS ARM64 all four interpreters resolve `flatc==25.12.19rc0` identically
under both policies (single-entry manifests), and the Step-4 ordinary leg
installed the wheel. There is **no macOS x86_64 flatc wheel and no sdist**, so
on that target the flatc stage would fail regardless of policy — unverified
natively, package-metadata fact only.

### 5. The `torch` premise in #94, re-examined

PyPI metadata for `torch` (`check_pypi.py`, all PASS):

```
torch 2.10.0 / 2.11.0 / 2.12.x / 2.13.0 / 2.14.0:
    macOS_x86_64 wheels: NONE     macOS_arm64 wheels: cp310 cp311 cp312 cp313 cp314
torch 2.13.0 / 2.14.0 packagetypes: wheels only (24 each), NO sdist
ANY torch version with a macOS x86_64 cp313 wheel: NONE
torch versions with ANY macOS x86_64 wheel: 1.0.0 … 2.2.2   (none after 2.2.2)
```

`torch` dropped macOS x86_64 wheels after 2.2.2; from 2.3.0 it is arm64-only on
macOS. On macOS x86_64 — a supported release target — modern `torch`
(`torch>=2.13`, required by RF-DETR ExecuTorch) has **no wheel and no sdist at
all**: pip already fails fast there with "no matching distribution", with no
slow source build possible from PyPI. The blanket flag therefore buys no
fast-failure for the payload the app actually installs — it only breaks the
ExecuTorch routes that install fine elsewhere. Classification:
package-metadata fact; macOS x86_64 install behavior itself unverified natively.

## Observed vs. inferred vs. unverified

- **Observed (native macOS ARM64, real interpreters 3.10–3.13):** the full
  manifest-compared sweep (fresh UL bases under both policies; fresh and, on
  3.12, ONNX-populated RF stacks); the Step-4 real installs with `pip check`
  and readiness probes; the `flatc` no-op; bundled pip versions; base-freeze
  identity across policies.
- **Package-metadata facts (platform-independent, asserted):**
  `antlr4-python3-runtime 4.9.*` has no wheels anywhere;
  `flatc 25.12.19rc0` is the only release (three named wheels, no sdist, no
  macOS x86_64 wheel); modern `torch` has no macOS x86_64 wheel and no sdist.
- **Inferred:** because the decisive breakage is caused by a package with zero
  wheels on any platform, a blanket `--only-binary=:all:` would reject the
  ExecuTorch payloads identically on macOS x86_64, Linux x86_64, and Windows
  x86_64. (Inference from platform-independent metadata, not a native run.)
- **Unverified (needs native CI):** actual resolution/installation on macOS
  x86_64, Linux x86_64, Windows x86_64; wheel coverage of Linux/Windows-gated
  routes (`engine`, `rknn`, `imx`, `axelera`, Edge TPU, `rf_engine`) on their
  own platforms; ONNX-populated ExecuTorch states off 3.12; the safety of any
  *selective* binary-only policy (Recommendations 2 / 3).

## Platform-gated routes (not in the native table)

`ul_engine`, `ul_rknn`, `ul_imx`, `ul_axelera`, the Edge TPU configuration, and
`rf_engine` never reach the installer on macOS — `validate_route_platform`
rejects them first. Resolving them on this host would be a simulation outside
the app's native execution path, so they carry no native verdict here. Note on
a prior-draft artifact: `stringcase 1.2.0` (sdist-only) appeared only inside the
`ul_imx` closure, a Linux-gated route; it is not part of any natively supported
route closure (asserted: `no-stringcase-in-native-ordinary-closures`) and was
removed from the decisive findings.

## Expected user impact

- **Recommendation 1 (reject / close #94):** no change. Installer behavior is
  exactly today's: every route installs as it currently does, including the
  ExecuTorch routes (pip builds the 117 kB pure-Python `antlr4` sdist; observed
  to build and install successfully in the Step-4 ordinary leg).
- **If a blanket binary-only were adopted instead (not recommended):** on the
  natively tested target, RF-DETR ExecuTorch would fail to install on every
  supported Python (observed: exit-1 ResolutionImpossible on 3.10/3.11,
  non-convergence within 300s on 3.12/3.13, real-install resolution-too-deep on
  3.12); Ultralytics ExecuTorch would fail on 3.13 and silently resolve to an
  older `executorch` with a shared-`torch` downgrade on 3.10–3.12 (observed).
  Effects on other targets are unverified, not claimed.

## Limitations and remaining CI work

- All native runs are macOS ARM64 only; one host cannot prove the other three
  release targets. The blanket-policy rejection nonetheless holds
  platform-wide for the decisive package because "no wheel exists anywhere" is
  platform-independent (inference, labeled as such).
- The multi-Python sweep uses dry-run resolution (metadata-accurate, both
  manifests compared) plus one decisive set of real installs on Python 3.12.
  Full real installs of every route on every Python (multi-GB
  `torch`/`tensorflow`/`executorch` stacks) were not performed.
- Linux-only, Windows-including, and NVIDIA-only routes have no verdict on
  their own platforms.

To finish the matrix natively (no authorization exercised here — no CI was
started, no workflow modified), run on each target with a real interpreter,
adapting `docs/wheel-policy-evidence/sweep.py` (`WORK` constant) and `step4.py`:

```bash
# Per target (macOS x86_64, Linux x86_64 ubuntu-22.04, Windows x86_64),
# per Python 3.10–3.13 (TFLite: 3.12 only):
python3.X -m venv /tmp/h9base && /tmp/h9base/bin/python -m pip install ultralytics  # bare, app-exact
/tmp/h9base/bin/python -m pip install --dry-run --report ord.json <payload>
/tmp/h9base/bin/python -m pip install --dry-run --report bin.json --only-binary=:all: <payload>
# then compare normalized name==version manifests; run check_manifests.py equivalents.
# Linux x86_64 additionally: ul_engine/ul_rknn/ul_imx/ul_axelera payloads + rf_engine.
# Windows x86_64 additionally: ul_engine payload + rf_engine + flatc --pre stage.
```

## Evidence ledger (claim → environment → command → result → artifact → class)

| # | Claim | Environment | Exact command | Result | Durable artifact | Class |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Fresh runtime installs bare `ultralytics` | app source | — (code ref) | `export-workspace.tsx:1496` | code | observed (code) |
| E2 | Route remedy pins `ultralytics>=8.4.80` (8.4.83 LiteRT) | app source | — (code ref) | `deps.rs:1210` | code | observed (code) |
| E3 | Fresh UL bases install under both policies, identical | macOS ARM64, py 3.10–3.13, empty venvs | `pip install ultralytics` / `pip install --only-binary=:all: ultralytics` | rc 0 ×8, freezes byte-identical (34/39/40/40 pkgs) | `envmeta.json`, `manifests/UL-base-*.txt` | observed |
| E4 | 8 UL + 3 RF payload groups are policy no-ops | populated UL envs / fresh RF stacks, 3.10–3.13 | `pip install --dry-run --report … [policy] <payload>` | rc 0/0, manifests byte-equal | `manifests/<group>_<py>_<leg>.txt`, `sweep-summaries.json` | observed |
| E5 | RF-DETR ExecuTorch installs cleanly today (3.12/ARM64) | disposable stack venv, brew py3.12.14, pip 26.2.1 | stable payload, `--pre flatc`, `pip check`, find_spec+floor probes | rc 0 ×4; rfdetr 1.9.4, executorch 1.4.1, torch 2.14.0, antlr 4.9.3 sdist-built | `step4-summary.json`, `manifests/RF-step4-ordinary-freeze.txt`, `step4-ordinary-antlr-build.txt` | observed |
| E6 | Same payload rejected with the flag (3.12/ARM64) | disposable stack venv, same interpreter | stable payload + `--only-binary=:all:` | rc 1, `resolution-too-deep`, 0 pkgs installed, `--pre` stage never ran | `step4-summary.json`, `manifests/RF-step4-binary-freeze.txt`, `step4-binary-resolution-failure.txt` | observed |
| E7 | antlr4 4.9.* has no wheel anywhere; flatc/torch facts | PyPI JSON API | `python3 check_pypi.py` | all assertions pass | `check_pypi.py`, `pypi-availability.txt` | metadata fact |
| E8 | ul_executorch diverges (3.10–3.12) / fails (3.13) | populated UL envs | dry-run legs both policies | manifests differ (1.4.1+torch2.14 vs 0.6.0+torch2.7); 3.13 rc 1 ResolutionImpossible | `manifests/ul_executorch_*`, `binary-failure-ul_executorch-py313.txt` | observed |
| E9 | rf_executorch rejected on all Pythons | fresh stacks (all), ONNX-pop stack (3.12) | dry-run legs both policies | rc 1 ResolutionImpossible (3.10/3.11); 300s non-convergence (3.12/3.13) | `manifests/rf_executorch_*`, `binary-failure-rf_executorch-py310.txt`, `-py311.txt` | observed |
| E10 | `flatc --pre` stage unaffected (ARM64) | fresh + ONNX-pop stacks | `pip install [--only-binary=:all:] --pre flatc` | rc 0/0, single-entry manifests | `manifests/rf_executorch_flatc_pre_*` | observed |
| E11 | Cross-platform rejection | inference from E7 | — | no 4.9.* wheel on any platform | `pypi-availability.txt` | inferred |
| E12 | Other targets' native behavior; gated-route coverage; selective policies | — | — (CI commands above) | none collected | — | unverified |

## Claims corrected or removed vs `60d0460`

1. Fresh runtime installs **bare `ultralytics`** (E1); the draft described only
   the versioned route remedy (E2). Both states now documented.
2. Route/platform gates corrected: Ultralytics CoreML = macOS+Linux; TensorRT =
   Linux+Windows; RF-DETR ExecuTorch = macOS ARM64 14+ / Linux x86_64 / Windows
   x86_64; LiteRT = macOS + Linux x86_64; Edge TPU = Linux x86_64.
3. `rfdetr-default` sharing now tested in **two stack states** (fresh +
   ONNX-populated on 3.12); other Pythons' ONNX-populated states unverified.
4. Every native cell now rests on **manifest comparison**, not exit-code pairs;
   `rf_engine` removed from the native table (platform-gated; unverified).
5. Timeouts recorded as did-not-converge (E9), never as unsatisfiability.
6. 3.13 "hard-fail" retained **only** where pip returned failure
   (`ul_executorch`, ResolutionImpossible); `rf_executorch` on 3.12/3.13 stays
   timeout/non-convergence.
7. Torch downgrade scoped to observed 3.10–3.12 populated-env combinations (E8).
8. "Every wheel-covered route unaffected" replaced by the enumerated
   identical-manifest groups (E4); "every route keeps working" replaced by
   "Recommendation 1 leaves installer behavior unchanged".
9. ANTLR timing claim removed; replaced by sdist composition (117 kB,
   pure-Python) + observed successful build (E5).
10. `stringcase` removed from decisive findings (gated-route-only artifact).
11. Status corrected from "audit complete" to partial (E12); CI commands provided.
12. Torch premise corrected: modern torch has **no sdist either**, so pip already
    fails fast on macOS x86_64 — the flag buys nothing there (E7).

## Proposed next action for #94 (for user review only)

Close #94 with **Recommendation 1** and this evidence. If scoped fast-failure
is ever wanted for a specific package/route, treat it as a narrow,
per-package question with native CI on every release target first — never a
global `:all:` flag. Do not post to #94 without user authorization.