<div align="center">

# Vision Export Studio

Desktop studio for exporting Ultralytics YOLO `.pt` and Roboflow RF-DETR `.pth` models into deployment-ready formats.

[![Platforms](https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#installation)
[![Homebrew](https://img.shields.io/badge/Homebrew-tap-FBB040?logo=homebrew)](#installation)
[![Built with Tauri v2](https://img.shields.io/badge/Built%20with-Tauri%20v2-ffc131.svg)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-%23dea584.svg?logo=rust&logoColor=black)](#build-from-source)
[![TypeScript](https://img.shields.io/badge/TypeScript-%23007ACC.svg?logo=typescript&logoColor=white)](#build-from-source)

[![CI](https://github.com/amanharshx/vision-export-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/amanharshx/vision-export-studio/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/amanharshx/vision-export-studio)](https://github.com/amanharshx/vision-export-studio/releases)

<br>

<img src="assets/readme-demo.gif" width="720" alt="Vision Export Studio demo">

</div>
<br>

---

## Table of Contents

- [What it is](#what-it-is)
- [Installation](#installation)
- [First Run](#first-run)
- [Troubleshooting](#troubleshooting)
- [Export Reference](#export-reference)
- [Build From Source](#build-from-source)
- [Analytics](#analytics)
- [Privacy](#privacy)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What it is

Vision Export Studio is a desktop app for exporting Ultralytics YOLO `.pt` and Roboflow RF-DETR `.pth` weights. Work stays on your machine.

Two providers, each with a required source extension (mismatches are rejected):

- **Ultralytics YOLO (`.pt`)** - ONNX, TorchScript, OpenVINO, TensorRT, CoreML, LiteRT, TF SavedModel, TF GraphDef, Edge TPU, PaddlePaddle, NCNN, MNN, RKNN, Sony IMX500, Axelera, and ExecuTorch.
- **Roboflow RF-DETR (`.pth`)** - ONNX (recommended), TensorRT, experimental CoreML, experimental TFLite, and experimental ExecuTorch (XNNPACK).

You confirm you trust an RF-DETR `.pth`. Then the app reads detection vs segmentation, size, and native image size.

Per-route precision, platform limits, calibration, and runtime paths: [Export Reference](docs/export-reference.md).

---

## Installation

### Quick Install

**macOS (Homebrew):**

```bash
brew install --cask amanharshx/tap/vision-export-studio
```

**Linux (Homebrew):**

```bash
brew install amanharshx/tap/vision-export-studio
```

**Windows / macOS / Linux (GitHub Releases):**

Download the latest desktop build from [GitHub Releases](https://github.com/amanharshx/vision-export-studio/releases).

**Linux package note:**

Current Linux release assets include Homebrew tarball, `.AppImage`, `.deb`, and `.rpm` packages.

### In-App Updates

Released builds can check for updates from `About` inside the app.

Expected flow:

- open `About` and click `Check for Updates`
- if no update exists, app shows `Up to date`
- if update exists, app offers `Install and restart`

Updater metadata is served from GitHub Releases.

### Unsigned app notes

> **Note:** The app is not code-signed yet, so macOS and Windows may show security warnings.

<details>
<summary><b>macOS</b> - "App is damaged and can't be opened"</summary>

Run this command in Terminal after installing:

```bash
xattr -cr "/Applications/Vision Export Studio.app"
```

Then open the app again.

</details>

<details>
<summary><b>Windows</b> - "Windows protected your PC" (SmartScreen)</summary>

1. Click **More info**
2. Click **Run anyway**

Or: Right-click the `.exe` -> **Properties** -> Check **Unblock** -> **Apply**

</details>

---

## First Run

Python 3.10–3.13 is required to set up managed export environments (3.12 preferred). The app does not ship Python. Install Python 3, then restart the app.

Expected flow:

- open the app (no provider environment is needed to start)
- drop a `.pt` or `.pth` model and choose its provider (extension mismatches are rejected)
- press **Set up** for the selected export route only
- run the export after that route reports ready

Setup never starts an export. Each route reports missing packages or system binaries, with install hints, before you export.

You can pick an output folder. If you do not, artifacts go next to the source model.

Runtime locations:

- Ultralytics routes use `~/.vision-export-studio/.venv`, created on Set up for an Ultralytics route.
- RF-DETR routes use `~/.vision-export-studio/envs/<stack>/.venv`, created on Set up for the selected route:
  - `rfdetr-default` covers ONNX and ExecuTorch
  - `rfdetr-tensorrt` covers TensorRT
  - `rfdetr-coreml` covers CoreML
  - `rfdetr-tflite` covers TFLite and requires Python 3.12 (`>=3.12, <3.13`)

A Python override is used only to create the managed environment. Packages are never installed into it. Exports never run through it.

After `Remove` / `Reset runtime`, the loaded model stays in the workspace. The affected routes need Set up again before export.

Ultralytics exports require Ultralytics 8.4.80 or newer. LiteRT requires 8.4.83 or newer. The app reports incompatible versions before export and can update Ultralytics in-app.

---

## Troubleshooting

- **Unsigned app warnings:** macOS may report the app is damaged and Windows SmartScreen may block it. See the [unsigned app notes](#unsigned-app-notes) above.
- **No compatible Python:** install Python 3.10–3.13 (3.12 preferred), then restart Vision Export Studio. The RF-DETR TFLite stack needs Python 3.12.
- **Route not ready:** press **Set up** for that route and wait until it reports ready. Setup installs only that route's environment. Other routes still need their own Set up.

---

## Export Reference

Full route list, platform requirements, precision modes and defaults, calibration notes, RF-DETR experimental caveats, and runtime paths: [docs/export-reference.md](docs/export-reference.md).

---

## Build From Source

**Prerequisites:** [Rust](https://rustup.rs/), [Bun](https://bun.sh/), [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/amanharshx/vision-export-studio.git
cd vision-export-studio
bun install
bun run tauri dev      # development
bun run tauri build    # local production build
```

---

## Analytics

The app uses PostHog. Events are tied to this install, not to your name. See [PRIVACY.md](PRIVACY.md).

Current analytics covers:

- app launches
- environment setup results (`environment_setup_completed` with provider, environment key, route ID, success or failure, and setup duration)
- export started, completed, failed, and cancelled
- app and device metadata such as app version, OS, architecture, install channel, and route/event metadata

Collected analytics excludes:

- model files
- model paths or filenames
- checkpoint metadata
- dataset contents
- file contents
- export logs
- package logs
- local file paths
- Python paths or output paths
- raw error text
- personal identity such as email address or username

---

## Privacy

Exports run on your machine. Model files stay there. Analytics is product usage and app/device metadata only. See [PRIVACY.md](PRIVACY.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## Security

If you discover a security issue, do not open a public issue. Use GitHub private vulnerability reporting as described in [SECURITY.md](SECURITY.md).

---

## License

This project is licensed under the [MIT License](LICENSE).
