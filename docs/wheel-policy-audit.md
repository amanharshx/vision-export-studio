# Binary-wheel policy audit (issue #94)

Status: audit complete. The recommendation below is for user review only. This
document does not change installer behavior and does not authorize any comment
on issue #94.

- Audit date: 2026-09-03
- Repository commit audited: `3cbf09ddc7791756ae04627007144de7d58d1097` (`origin/main`, v0.1.13)
- Issue: https://github.com/amanharshx/vision-export-studio/issues/94
- Handoff: `MAINTENANCE_HANDOFFS.md` → Handoff 9

## Question

Issue #94 proposes passing `--only-binary=:all:` to every dependency install so
that unsupported installs fail fast instead of letting pip fall back to a slow
source build (motivating example: `torch` building for a long time before
failing). This audit asks whether that policy is safe across the supported
OS / architecture / Python / route matrix, and returns exactly one of three
recommendations.

## Recommendation

**Recommendation 1: reject a blanket `--only-binary=:all:` policy and close #94.**

A blanket binary-only policy **breaks the RF-DETR ExecuTorch route on every
supported Python version** and either **breaks or silently degrades the
Ultralytics ExecuTorch route**, because both routes pull (transitively, through
`executorch` → `hydra-core` → `omegaconf`) a hard pin on
`antlr4-python3-runtime==4.9.*`, and **no `4.9.x` wheel exists on PyPI for any
platform**. This is proven natively on macOS ARM64 (observed) and is
platform-independent for the decisive package (package-metadata fact).

The `torch` premise in #94 is more nuanced than a blanket flag can address:
`torch` publishes **no macOS x86_64 wheel at all** for any Python version since
2.2.2 (arm64-only from 2.3.0 onward), so on that one supported target modern
`torch` cannot be wheel-installed regardless of this flag. That is a narrow,
platform-scoped problem, not a reason to add a global flag that breaks
ExecuTorch everywhere. For every wheel-covered route the flag changes nothing
(no-op).

Recommendations 2 and 3 are **not endorsed** by this audit because the evidence
is native macOS ARM64 only; see *Limitations*. Adopting either would require
native CI on macOS x86_64, Linux x86_64, and Windows x86_64 first.

## What the app actually runs (installer contract, from `3cbf09d`)

Traced through `src-tauri/src/commands/deps.rs`,
`src-tauri/src/commands/stack_environments.rs`,
`src-tauri/src/commands/setup.rs`, and
`src/features/export/export-workspace.tsx`.

Install command — `build_pip_install_command` (`deps.rs:1572`):

```
python -m pip install [--pre] <packages...>
```

- **No** `--only-binary`, **no** `--ignore-installed`, **no** `--upgrade` today.
- pip is **never upgraded**: setup creates the venv with `python -m venv .venv`
  only (`create_runtime_venv`, `setup.rs`), so each interpreter's *bundled* pip
  is used.
- `--pre` is applied to the whole prerelease group in one invocation.
  `install_dependencies` (`deps.rs:1351`) splits packages into a stable stage
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

Consequences that correct the earlier draft:

- **Optional deps are never auto-installed.** `onnxslim` (the ONNX route's only
  optional dep) returns status `warning` with `install_package = None`
  (`check_pip_dep`, `deps.rs:1233`), so it is dropped by the frontend. The ONNX
  route's auto-install payload is `onnx` alone.
- **Axelera uses the bare name `axelera`.** `route_deps` sets `package_name =
  "axelera"` with hint `pip install axelera-devkit`; the hint is only surfaced
  for `missing_binary` system deps, so the pip dependency's `install_package` is
  `axelera`. The app would actually run `pip install axelera`, not
  `axelera-devkit`. (Reported as-is; the route is Linux-only and platform-gated
  off macOS.)
- **`flatc` is a real prerelease stage.** The RF-DETR ExecuTorch route
  (`rfdetr.pth.executorch`) yields three results: `rfdetr[executorch]>=1.9.0`
  and `torch>=2.13` (stable stage), plus `flatc` with `prerelease = Some(true)`
  (→ `pip install --pre flatc`).

### Environments

- **Ultralytics routes** share one managed environment
  (`ULTRALYTICS_MANAGED_KEY = "ultralytics-managed"`). Ultralytics is installed
  on demand (`check_ultralytics_dep` prepends `ultralytics>=8.4.80`, or
  `>=8.4.83` for LiteRT). `torch` arrives as an Ultralytics dependency. Route
  packages install into this already-populated environment.
- **RF-DETR routes** use four dedicated stack venvs
  (`stack_environments.rs`, `KNOWN_STACKS`), each created fresh from the selected
  interpreter:
  - `rfdetr-default` → `rfdetr.pth.onnx` **and** `rfdetr.pth.executorch` (**shared**)
  - `rfdetr-tensorrt` → `rfdetr.pth.engine`
  - `rfdetr-coreml` → `rfdetr.pth.coreml`
  - `rfdetr-tflite` → `rfdetr.pth.tflite` (Python `>=3.12,<3.13`)

### Routes vs. payloads

There are **21 export routes** (16 Ultralytics including `saved_model`+`pb`, and
5 RF-DETR). They collapse to fewer **distinct pip payloads**: `torchscript` has
no pip deps; `saved_model`, `pb`, and `edgetpu` share one payload; several
routes share `onnx`. The tables below label payload groups, not route counts.

Exact install_package payloads (missing-everything case):

| Group | Routes | Stable payload | Prerelease payload | Env | Platform gate |
| --- | --- | --- | --- | --- | --- |
| ul_torchscript | torchscript | *(none)* | — | ultralytics-managed | all |
| ul_onnx | onnx | `onnx` (onnxslim optional, excluded) | — | ultralytics-managed | all |
| ul_openvino | openvino | `openvino nncf` | — | ultralytics-managed | all |
| ul_coreml | coreml | `coremltools` | — | ultralytics-managed | macOS |
| ul_ncnn | ncnn | `ncnn pnnx` | — | ultralytics-managed | all |
| ul_mnn | mnn | `MNN onnx` | — | ultralytics-managed | all |
| ul_litert | litert | `litert-torch>=0.9.0 ai-edge-litert>=2.1.4` | — | ultralytics-managed | macOS/Linux x86_64 |
| ul_tfgraph | saved_model, pb, edgetpu | `tensorflow onnx2tf onnx onnxruntime` | — | ultralytics-managed | edgetpu Linux only |
| ul_paddle | paddle | `paddlepaddle x2paddle` | — | ultralytics-managed | all |
| ul_executorch | executorch | `executorch` | — | ultralytics-managed | all |
| ul_engine | engine | `tensorrt` | — | ultralytics-managed | Linux (NVIDIA) |
| ul_rknn | rknn | `rknn-toolkit2 onnx` | — | ultralytics-managed | Linux only |
| ul_imx | imx | `model-compression-toolkit sony-custom-layers imx500-converter` | — | ultralytics-managed | Linux only |
| ul_axelera | axelera | `axelera` | — | ultralytics-managed | Linux only |
| rf_onnx | rfdetr onnx | `rfdetr[onnx]` | — | rfdetr-default | all |
| rf_engine | rfdetr engine | `rfdetr[tensorrt]` | — | rfdetr-tensorrt | NVIDIA |
| rf_coreml | rfdetr coreml | `rfdetr[coreml]` | — | rfdetr-coreml | macOS |
| rf_tflite | rfdetr tflite | `rfdetr[tflite]>=1.9.4` | — | rfdetr-tflite | Python 3.12 |
| rf_executorch | rfdetr executorch | `rfdetr[executorch]>=1.9.0 torch>=2.13` | `flatc` (`--pre`) | rfdetr-default | macOS ARM64 / Linux x86_64 / Windows x86_64 |

## Supported matrix

Release targets (`.github/workflows/release.yml`): **macOS ARM64
(aarch64-apple-darwin), macOS x86_64, Linux x86_64 (ubuntu-22.04), Windows
x86_64**. There is **no Linux ARM64** release. Managed runtime supports Python
**3.10–3.13**, prefers 3.12; RF-DETR TFLite is gated to Python 3.12.

## Method

- Host: macOS 26.5.2, `arm64` (aarch64-apple-darwin).
- Real native interpreters, each with its **bundled** pip (never upgraded, as
  the app does):

  | Python | Path | Bundled pip |
  | --- | --- | --- |
  | 3.10.19 | `/Users/aman/.local/bin/python3.10` | 23.0.1 |
  | 3.11.9 | `~/.pyenv/versions/3.11.9/bin/python3.11` | 24.0 |
  | 3.12.14 | `/opt/homebrew/bin/python3.12` | 26.2.1 |
  | 3.13.7 | `/opt/homebrew/bin/python3.13` | 25.2 |

- Temporary venvs only, under `/private/tmp/h9-audit2`. The managed runtime at
  `~/.vision-export-studio` was never read, written, or touched.
- Two faithfulness rules, correcting the earlier draft: **no `--ignore-installed`**
  (the app never passes it) and **Ultralytics route packages resolved into a
  populated env** (real `pip install "ultralytics>=8.4.80"` first), because they
  install into the shared, already-populated `ultralytics-managed` environment.
  RF-DETR routes were resolved in fresh stack venvs (their stacks start empty).
- Each payload was resolved twice — ordinary and `--only-binary=:all:` — and, for
  the decisive route, installed for real. The binary policy was applied to both
  the stable and the `--pre flatc` stages.
- Resolution instrumentation: `pip install --dry-run --report`. `--dry-run`
  resolves the full closure from package metadata (PEP 658) without downloading
  wheels; source-only packages were identified from each resolved package's
  `download_info.url` (`.tar.gz`/`.zip` = sdist).
- Reproduction drivers (kept under `/private/tmp/h9-audit2`, not part of this
  commit): `audit.py` (populated-env sweep + real installs), `audit_fast2.py`
  (dry-run resolution sweep, Linux-only routes skipped, 300s cap per leg),
  `pypi_meta.py` (PyPI wheel-coverage checks).

## Results — resolution sweep (macOS ARM64)

`ord` / `bin` = exit status of the ordinary / `--only-binary=:all:` resolution.
`sdist` = source-only packages in the ordinary resolved closure. Empty cells for
`rf_tflite` on non-3.12 reflect the app's Python 3.12 gate.

| Group | 3.10 | 3.11 | 3.12 | 3.13 | sdist-only in closure | Verdict |
| --- | :--: | :--: | :--: | :--: | --- | --- |
| ul_onnx | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_openvino | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_coreml | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_ncnn | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_mnn | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_litert | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_tfgraph | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_paddle | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| ul_executorch | 0/**0*** | 0/**0*** | 0/**0*** | 0/**1** | `antlr4-python3-runtime==4.9.3` | binary-only diverges (3.10–3.12) / fails (3.13) |
| rf_onnx | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| rf_engine | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op (resolves; runs only with NVIDIA) |
| rf_coreml | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op |
| rf_tflite | — | — | 0/0 | — | none | no-op (Python 3.12 gate) |
| rf_executorch | 0/**1** | 0/**1** | 0/**1** | 0/**T** | `antlr4-python3-runtime==4.9.3` | **binary-only fails on every Python** |
| rf_executorch `--pre flatc` | 0/0 | 0/0 | 0/0 | 0/0 | none | no-op (wheel exists) |

`*` = `--only-binary` dry-run exits 0 but resolves a **different** package set
(see the real-install proof below); it is not an equivalent install.
`T` = did not converge within 300s (pip backtracking); recorded as a failure.

Binary-only failure modes for `rf_executorch`: `ResolutionImpossible` on 3.10 and
3.11, `resolution-too-deep` on 3.12, non-convergence (>300s) on 3.13 — every
supported Python fails, by one route or another.

**Linux-only routes** (`ul_engine`, `ul_rknn`, `ul_imx`, `ul_axelera`, and Edge
TPU via `ul_tfgraph`) are platform-gated off macOS by the app and were not
resolved natively. Note: on Python 3.10 (bundled pip 23.0.1), the `ul_imx`
payload under `--only-binary` backtracked for over 30 minutes without
terminating before being killed — a supplemental illustration that binary-only
can trigger pathological pip backtracking. Their real wheel coverage on Linux
x86_64 / Windows x86_64 is **unverified** (needs native CI) but does not change
the recommendation.

## Decisive findings

### 1. `antlr4-python3-runtime==4.9.*` is universally source-only and gates ExecuTorch

PyPI JSON API (platform-independent):

```
antlr4-python3-runtime==4.9.3 : packagetypes {'sdist': 1}, 0 wheels
  files: ['antlr4-python3-runtime-4.9.3.tar.gz']
  versions WITH a wheel: 4.11.0, 4.11.1, 4.12.0, 4.13.0, 4.13.1, 4.13.2
stringcase==1.2.0             : packagetypes {'sdist': 1}, 0 wheels
```

`hydra-core` (pulled transitively by `executorch`) pins
`antlr4-python3-runtime==4.9.*`, and the entire `4.9.x`/`4.10.x` line is
sdist-only. `--only-binary=:all:` therefore cannot satisfy it on **any** platform.
Root-cause excerpt, `rf_executorch` binary-only on Python 3.10 / 3.11
(identical on both):

```
ERROR: Cannot install executorch because these package versions have conflicting dependencies.
The conflict is caused by:
    hydra-core 1.3.6 depends on antlr4-python3-runtime==4.9.*
    hydra-core 1.3.5 depends on antlr4-python3-runtime==4.9.*
    ...
ERROR: ResolutionImpossible
```

On Python 3.12 the same payload instead ends in `error: resolution-too-deep`
(the resolver backtracks endlessly avoiding the sdist and gives up); on 3.13 it
did not converge within 300s.

### 2. Decisive real install — `ul_executorch`, Python 3.12, into the populated ultralytics env

Not a dry run. Fresh venv (bundled pip 26.2.1) → real
`pip install "ultralytics>=8.4.80"` (exit 0; brings `torch 2.14.0`) → real
`pip install executorch`.

Ordinary (exit 0):

```
executorch 1.4.1   coremltools 9.0   hydra-core 1.3.6   omegaconf 2.3.1
antlr4-python3-runtime 4.9.3 (built from sdist)   torch 2.14.0   torchvision 0.29.0
pip check: No broken requirements found.
readiness probe: import executorch, executorch.exir  -> OK (executorch 1.4.1)
```

`--only-binary=:all:` in a parallel fresh venv — real
`pip install --only-binary=:all: "ultralytics>=8.4.80"` (exit 0) then
`pip install --only-binary=:all: executorch` (exit 0):

```
executorch 0.6.0   coremltools 8.2   torch 2.7.0 (DOWNGRADED from 2.14.0)
torchvision 0.22.0 (from 0.29.0)   torchaudio 2.7.0 (added)
antlr4 / hydra-core / omegaconf : dropped
pip check: No broken requirements found.
readiness probe: executorch.exir present (executorch 0.6.0); ultralytics 8.4.138 still imports
```

Interpretation, stated precisely: `--only-binary` on Python 3.12 does **not**
hard-fail this route and does **not** produce a broken environment (`pip check`
is clean, `executorch.exir` imports, `ultralytics` imports). What it does is
**silently pick a different resolution** — `executorch 0.6.0` instead of the
current `1.4.1` — and, to do so, **downgrade `torch` from 2.14.0 to 2.7.0 in the
shared managed environment** that the Ultralytics runtime had just populated.
Because the Ultralytics ExecuTorch route declares **no** minimum `executorch`
version, this audit does **not** claim `0.6.0` is functionally broken; the
provable harm is a silent, unrequested mutation of a shared environment plus a
resolution that diverges from the ordinary one. On Python 3.13 this same route's
binary-only resolution instead hard-fails (`ResolutionImpossible`, same
`hydra-core`/`antlr4` cause).

The RF-DETR ExecuTorch route removes the ambiguity: it declares `torch>=2.13`,
which forbids the torch downgrade escape, so `--only-binary` cannot avoid the
source-only `antlr4` and **hard-fails on every supported Python** (finding 1).

### 3. The `flatc` prerelease stage

PyPI has exactly one `flatc` release, `25.12.19rc0` (a prerelease — this is why
the app uses `--pre`), shipping three wheels and no sdist:

```
flatc-25.12.19rc0-py3-none-macosx_11_0_arm64.whl
flatc-25.12.19rc0-py3-none-manylinux_2_24_x86_64.manylinux_2_28_x86_64.whl
flatc-25.12.19rc0-py3-none-win_amd64.whl
```

On macOS ARM64 both `pip install --pre flatc` and
`pip install --only-binary=:all: --pre flatc` succeed with the wheel (no-op).
There is **no macOS x86_64 flatc wheel and no sdist**, so on that target the
flatc stage would fail regardless of policy (**unverified** natively).

### 4. The `torch` premise in #94, re-examined

PyPI metadata for `torch`:

```
torch 2.14.0 / 2.13.0 / 2.12.x / 2.11.0 / 2.10.0:
    macOS_x86_64 wheels: NONE     macOS_arm64 wheels: cp310 cp311 cp312 cp313 cp314
ANY torch version with a macOS x86_64 cp313 wheel: NONE
torch versions with ANY macOS x86_64 wheel: 1.0.0 … 2.2.2   (none after 2.2.2)
```

This **refutes** the earlier draft's claim that `torch` is wheel-covered on every
supported platform. `torch` dropped macOS x86_64 wheels after 2.2.2; from 2.3.0
it is arm64-only on macOS. So on macOS x86_64 — a supported release target —
modern `torch` (and `torch>=2.13`, required by RF-DETR ExecuTorch) has **no
wheel at all**. The slow-build-then-fail scenario #94 describes is therefore real
on that one platform, independent of this flag. Its actual install/build
behavior on macOS x86_64 is **unverified** here (arm64 host); it is a
package-metadata availability fact only.

## Observed vs. inferred vs. unverified

- **Observed (native macOS ARM64):** the full resolution sweep above; the two
  real ExecuTorch installs on Python 3.12; the `flatc` stage no-op; bundled pip
  versions.
- **Package-metadata facts (platform-independent):** `antlr4-python3-runtime
  4.9.*` and `stringcase 1.2.0` have no wheels anywhere; `flatc` has only a
  prerelease with three named wheels and no macOS x86_64 wheel; `torch` has no
  macOS x86_64 wheel for any Python since 2.2.2.
- **Inferred:** because the decisive breakage is caused by a package with zero
  wheels on any platform, a blanket `--only-binary=:all:` would reject the
  ExecuTorch routes identically on macOS x86_64, Linux x86_64, and Windows
  x86_64. (Inference from platform-independent metadata, not a native run.)
- **Unverified (needs native CI):** actual resolution/build on macOS x86_64,
  Linux x86_64, Windows x86_64; wheel coverage of Linux-only routes
  (`engine`, `rknn`, `imx`, `axelera`, Edge TPU); the actual macOS x86_64
  behavior of `torch>=2.13` and `flatc`; and the safety of any *selective*
  binary-only policy (Recommendation 2 / 3).

## Limitations

- All native runs are macOS ARM64 only; one host cannot prove the other three
  release targets. The blanket-policy rejection nonetheless holds platform-wide
  for the decisive package because "no wheel exists anywhere" is
  platform-independent.
- The multi-Python sweep uses dry-run resolution (metadata-accurate) plus one
  decisive set of real installs on Python 3.12. Full real installs of every
  route across every Python (multi-GB `torch`/`tensorflow`/`executorch` stacks)
  were not performed.
- Linux-only and NVIDIA-only routes cannot run on this host and are recorded as
  platform-gated; their wheel coverage on their own platforms is unverified.

## Expected user impact

- **Recommendation 1 (reject / close #94):** no change. Every route keeps
  working exactly as today; ExecuTorch continues to install (pip builds the tiny
  pure-Python `antlr4` sdist into a wheel in well under a second and caches it).
- **If a blanket binary-only were adopted instead:** RF-DETR ExecuTorch would
  fail to install on every supported Python; Ultralytics ExecuTorch would fail
  on Python 3.13 and silently install an older `executorch` (downgrading shared
  `torch`) on 3.10–3.12; all wheel-covered routes would be unaffected.

## Proposed next action for #94 (for user review only)

Close #94 with **Recommendation 1** and this evidence. If fast failure for
`torch` on macOS x86_64 specifically is still wanted later, treat it as a narrow,
platform-scoped question — never a global `:all:` flag, and never applied to the
ExecuTorch routes — and validate it on native macOS x86_64 CI before shipping.
Do not post to #94 without user authorization.
