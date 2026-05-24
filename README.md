# YOLO Export Studio

Desktop studio for exporting Ultralytics YOLO `.pt` models into deployment-ready formats.

> [!IMPORTANT]
> **This project is currently under active development.** Some features may be incomplete or subject to change. Bug reports and feature requests are appreciated!

## What YOLO Export Studio Does

YOLO Export Studio gives `yolo export` a desktop UI.

- Drop supported `.pt` weights
- Pick target format
- Install route-specific dependencies when needed
- Export locally on your machine

YOLO Export Studio is **not** universal all-to-all model converter.

```text
source format -> supported route -> target format
```

Current source focus:

- Ultralytics-compatible `.pt` weights only
- Generic PyTorch checkpoints not supported
- Reverse conversion not supported

## Why YOLO Export Studio

- Local-first. Model files stay on your machine.
- Managed runtime by default. YOLO Export Studio creates `~/.yolo-export-studio/.venv` for its Python tooling.
- Optional override. Power users can point app at a different Python interpreter.
- Route-aware installs. Dependencies install only when selected export path needs them.
- Rust process layer. Export commands run through Tauri/Rust, not direct shell strings from React.

## Supported Conversions

Current source format:

- `.pt`

Current target formats:

- `.pt -> onnx`
- `.pt -> torchscript`
- `.pt -> openvino`
- `.pt -> engine` (TensorRT)
- `.pt -> coreml`
- `.pt -> saved_model`
- `.pt -> pb`
- `.pt -> tflite`
- `.pt -> edgetpu`
- `.pt -> tfjs`
- `.pt -> paddle`
- `.pt -> ncnn`
- `.pt -> mnn`
- `.pt -> rknn`
- `.pt -> imx`
- `.pt -> axelera`
- `.pt -> executorch`

Route metadata source of truth:

- [`src/lib/routes.ts`](src/lib/routes.ts)

## Target Caveats

Some targets are one-way deployment artifacts or platform-locked:

- `engine` requires NVIDIA GPU and supported TensorRT stack. No macOS support.
- `coreml` export is macOS-only.
- `edgetpu` export requires Linux `x86_64` and `edgetpu_compiler`.
- `rknn` export is Linux-only and requires target chip selection.
- `imx` export is Linux-only and requires Java `>= 17`.
- `axelera` export is Linux-only.
- `tflite`, `engine`, `mnn`, `rknn`, `imx`, `axelera`, `edgetpu`, and some `coreml` outputs should be treated as one-way deployment outputs.

## Installation

### Releases

Download latest desktop build from GitHub Releases.

Planned target experience:

- install app
- let YOLO Export Studio prepare runtime on first launch
- pick export route
- install route dependencies only when needed

### First Launch Runtime Setup

YOLO Export Studio now defaults to managed runtime in:

```text
~/.yolo-export-studio/.venv
```

YOLO Export Studio creates this environment automatically and installs `ultralytics` there.

Current bootstrap limitation:

- first-time runtime creation still depends on working `python`/`python3` already available on host machine
- bundled Python is not implemented yet

## Build From Source

Prerequisites:

```bash
bun --version
cargo --version
cargo tauri --version
```
Install frontend dependencies:

```bash
bun install
```

Run web shell:

```bash
bun run dev
```

Run desktop shell:

```bash
bun run tauri dev
```

Build frontend:

```bash
bun run build
```

## Architecture

```text
React UI
  -> Tauri invoke/listen
Rust command layer
  -> validates paths/options
  -> resolves managed Python or user override
  -> installs dependencies for selected route
  -> spawns yolo export with argv, not shell strings
  -> streams stdout/stderr events
  -> owns cancel/kill
Ultralytics CLI
  -> runs export in selected Python environment
```

React does not spawn export shell commands directly. Rust owns subprocess execution, path validation, and event streaming.

## Project Structure

```text
src/
  components/ui/          shadcn components
  features/export/        export workspace UI
  features/environment/   Python/yolo status UI
  features/setup/         first-run runtime bootstrap UI
  lib/routes.ts           route metadata
  lib/types.ts            shared frontend types
src-tauri/
  src/                    Tauri v2 Rust commands and process control
```
## Status

YOLO Export Studio is in public alpha shape, not polished final release.

Expect:

- rough edges in setup and platform-specific export paths
- dependency/toolchain issues on some routes
- UI and wording changes while product direction settles
