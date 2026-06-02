<div align="center">

# YOLO Export Studio

Desktop studio for exporting Ultralytics YOLO `.pt` models into deployment-ready formats.

[![Platforms](https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#installation)
[![Homebrew](https://img.shields.io/badge/Homebrew-tap-FBB040?logo=homebrew)](#installation)
[![Built with Tauri v2](https://img.shields.io/badge/Built%20with-Tauri%20v2-ffc131.svg)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-%23dea584.svg?logo=rust&logoColor=black)](#build-from-source)
[![TypeScript](https://img.shields.io/badge/TypeScript-%23007ACC.svg?logo=typescript&logoColor=white)](#build-from-source)

</div>

> [!IMPORTANT]
> **This project is currently under active development.** Some features may be incomplete or subject to change. Bug reports and feature requests are appreciated!

<br>

<div align="center">
  <img src="assets/readme-demo.gif" width="720" alt="YOLO Export Studio demo">
</div>

<br>

> [**YOLO Export Studio**](https://github.com/amanharshx/yolo-export-studio) is a desktop app that exports [Ultralytics](https://www.ultralytics.com/) YOLO `.pt` weights into deployment-ready formats like ONNX, TensorRT, CoreML, TFLite, and more. Select your model, pick a target, and generate the export locally - model files stay on your machine.

---

## Table of Contents

- [Supported Formats](#supported-formats)
- [Target Caveats](#target-caveats)
- [Installation](#installation)
- [Build From Source](#build-from-source)
- [Architecture](#architecture)
- [Status](#status)

---

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

---

## Why YOLO Export Studio

- Local-first. Model files stay on your machine.
- Managed runtime by default. YOLO Export Studio creates `~/.yolo-export-studio/.venv` for its Python tooling.
- Optional override. Power users can point app at a different Python interpreter.
- Route-aware installs. Dependencies install only when selected export path needs them.
- Rust process layer. Export commands run through Tauri/Rust, not direct shell strings from React.

---

## Supported Formats

Current source format:

| Format | Status | Notes |
| --- | :---: | --- |
| `.pt` | ✅ | Ultralytics-compatible weights only. |

Current target formats:

| Format | Status | Notes |
| --- | :---: | --- |
| `.pt -> onnx` | ✅ | Most portable intermediate. |
| `.pt -> torchscript` | ✅ | Traced TorchScript module. |
| `.pt -> openvino` | ✅ | Optimised for Intel CPUs, iGPUs, and VPUs. |
| `.pt -> engine` | ✅ | TensorRT. NVIDIA GPU and supported stack required. |
| `.pt -> coreml` | ✅ | macOS-only. |
| `.pt -> saved_model` | ✅ | TensorFlow SavedModel output. |
| `.pt -> pb` | ✅ | TensorFlow GraphDef output. |
| `.pt -> tflite` | ✅ | One-way runtime artifact. |
| `.pt -> edgetpu` | ✅ | Linux `x86_64` and `edgetpu_compiler` required. |
| `.pt -> tfjs` | ✅ | Web deployment output. |
| `.pt -> paddle` | ✅ | PaddlePaddle export path. |
| `.pt -> ncnn` | ✅ | Mobile-friendly runtime output. |
| `.pt -> mnn` | ✅ | One-way runtime artifact. |
| `.pt -> rknn` | ✅ | Linux-only. Target chip required. |
| `.pt -> imx` | ✅ | Linux-only. Java `>= 17` required. |
| `.pt -> axelera` | ✅ | Linux-only. |
| `.pt -> executorch` | ✅ | Edge runtime output. |

Route metadata source of truth:

- [`src/lib/routes.ts`](src/lib/routes.ts)

---

## Target Caveats

Some targets are one-way deployment artifacts or platform-locked:

- `engine` requires NVIDIA GPU and supported TensorRT stack. No macOS support.
- `coreml` export is macOS-only.
- `edgetpu` export requires Linux `x86_64` and `edgetpu_compiler`.
- `rknn` export is Linux-only and requires target chip selection.
- `imx` export is Linux-only and requires Java `>= 17`.
- `axelera` export is Linux-only.
- `tflite`, `engine`, `mnn`, `rknn`, `imx`, `axelera`, `edgetpu`, and some `coreml` outputs should be treated as one-way deployment outputs.

---

## Installation

### Quick Install

**macOS (Homebrew):**

```bash
brew tap amanharshx/tap
brew install --cask yolo-export-studio
```

**Windows / macOS / Linux (GitHub Releases):**

Download the latest desktop build from [GitHub Releases](https://github.com/amanharshx/yolo-export-studio/releases).

### Troubleshooting

> **Note:** The app is not code-signed yet, so macOS and Windows may show security warnings.

<details>
<summary><b>macOS</b> - "App is damaged and can't be opened"</summary>

Run this command in Terminal after installing:

```bash
xattr -cr "/Applications/YOLO Export Studio.app"
```

Then open the app again.

</details>

<details>
<summary><b>Windows</b> - "Windows protected your PC" (SmartScreen)</summary>

1. Click **More info**
2. Click **Run anyway**

Or: Right-click the `.exe` -> **Properties** -> Check **Unblock** -> **Apply**

</details>

### First Launch Runtime Setup

Expected flow:

- install app
- let YOLO Export Studio prepare runtime on first launch
- pick export route
- install route dependencies only when needed

YOLO Export Studio now defaults to managed runtime in:

```text
~/.yolo-export-studio/.venv
```

YOLO Export Studio creates this environment automatically and installs `ultralytics` there.

Current bootstrap limitation:

- first-time runtime creation still depends on working `python`/`python3` already available on host machine
- bundled Python is not implemented yet

---

## Build From Source

**Prerequisites:** [Rust](https://rustup.rs/), [Bun](https://bun.sh/), [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/amanharshx/yolo-export-studio.git
cd yolo-export-studio
bun install
bun run tauri dev      # development
bun run tauri build    # local production build
```

---

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

---

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

---

## Status

YOLO Export Studio is in public alpha shape, not polished final release.

Expect:

- rough edges in setup and platform-specific export paths
- dependency/toolchain issues on some routes
- UI and wording changes while product direction settles
