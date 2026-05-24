# YOLO Export Studio

Desktop ML model export studio. Drop a model file, pick a target format, convert — locally, on your hardware, in your Python environment.

![Status](https://img.shields.io/badge/status-early%20development-orange)
![Python](https://img.shields.io/badge/python-3.11%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What It Does

YOLO Export Studio takes a source model file and converts it to a deployment format using the appropriate toolchain running **entirely on your machine**. No cloud, no uploads, no surprises.

```
source model → provider route → target format
```

Current source: Ultralytics `.pt` models (YOLO v5/v8/v9/v10/v11).

---

## Supported Formats

| Format | Type | One-way | Platform |
|---|---|---|---|
| TorchScript | intermediate | no | any |
| ONNX | intermediate | no | any |
| OpenVINO IR | intermediate | no | any |
| TensorRT `.engine` | runtime | **yes** | NVIDIA GPU |
| CoreML `.mlpackage` | runtime | **yes** | Apple only |
| TF SavedModel | intermediate | no | any |
| TFLite | runtime | **yes** | any |
| Edge TPU | vendor | **yes** | Linux x86_64 + Coral |
| TF.js | runtime | no | any |
| PaddlePaddle | intermediate | no | any |
| NCNN | runtime | no | any |
| MNN | runtime | no | any |
| RKNN | vendor | **yes** | any (chip-locked output) |
| Sony IMX500 | vendor | **yes** | Linux |
| ExecuTorch `.pte` | runtime | no | any |
| Axelera Metis `.axm` | vendor | **yes** | Linux |

---

## Architecture

```
PySide6 GUI Process (no ML imports)
  │
  ├── QThread — preflight dep checks (read-only, fast)
  │
  └── QProcess — spawns worker subprocess
        │
        args   → path to job.json
        stdout ← JSONL events (started, log, progress, artifact, finished)
        stderr ← raw diagnostics
        exit   → 0 success, non-zero failure
```

The worker process imports ML libraries (`torch`, `ultralytics`, etc.) and runs the actual export. If it crashes (segfault, CUDA OOM, TensorRT error), the GUI stays alive. GPU memory is fully released when the worker exits.

---

## Installation

```bash
# GUI dependencies only
pip install -e .

# ML dependencies go in whatever environment you point YOLO Export Studio at
pip install ultralytics  # for .pt → onnx/torchscript/openvino/etc.
pip install tensorrt     # for .pt → .engine (NVIDIA only)
# etc.
```

Requires Python 3.11+.

---

## Usage

```bash
yolo-export-studio
```

Or:

```bash
python -m yolo_export_studio.main
```

> **Note:** The GUI is not yet implemented (Phase 1 in progress). The data model, worker protocol, and fake provider for testing are complete.

---

## Project Structure

```
yolo_export_studio/
├── main.py                     # Entry point
├── core/
│   ├── formats.py              # FormatSpec — all 16+ formats
│   ├── routes.py               # Route dataclass (deps, platform, options)
│   ├── providers.py            # ExportProvider ABC + registry
│   ├── preflight.py            # Read-only dep checker (importlib-based)
│   ├── jobs.py                 # ExportJob JSON serialization
│   └── logs.py                 # JSONL event models + parser
├── providers/
│   └── fake.py                 # Fake provider (smoke tests, UI dev)
├── workers/
│   └── export_worker.py        # Standalone subprocess entry point
└── ui/
    ├── main_window.py          # Main window (stub)
    ├── drop_zone.py            # Drag-and-drop model file (stub)
    ├── format_grid.py          # Format card grid (stub)
    ├── format_card.py          # Per-format card (stub)
    ├── options_panel.py        # Conversion options (stub)
    ├── dependency_panel.py     # Dep checklist + install hints (stub)
    ├── process_controller.py   # QProcess lifecycle (stub)
    └── log_viewer.py           # Live JSONL log (stub)
```

---

## Roadmap

| Phase | Status | Description |
|---|---|---|
| 0 — Scaffold | ✅ Done | Core dataclasses, provider registry, fake provider, worker protocol |
| 1 — GUI Skeleton | 🔨 Next | Main window, drop zone, format grid, options panel, log viewer |
| 2 — Worker Protocol | — | Export worker CLI, JSONL events, cancel, crash handling |
| 3 — Ultralytics Routes | — | `.pt → onnx/torchscript/openvino` with real preflight |
| 4 — More Routes | — | CoreML, NCNN, MNN, TFLite, TensorRT, RKNN, ExecuTorch |
| 5 — Vendor Routes | — | EdgeTPU, IMX500, Axelera, TFJS, PaddlePaddle |
| 6 — Polish | — | Interpreter selector, multi-format queue, history |
| 7 — More Providers | — | ONNX as source, HuggingFace via Optimum |
| 8 — Distribution | — | PyInstaller, `.app`, `.exe` |

---

## Development

```bash
# Run fake worker smoke test
touch /tmp/test.pt
python -c "
from yolo_export_studio.core.jobs import ExportJob
from pathlib import Path
j = ExportJob.create('fake', 'fake.pt.onnx', Path('/tmp/test.pt'), Path('/tmp'), Path('python'), {})
j.write(Path('/tmp/job.json'))
"
python -m yolo_export_studio.workers.export_worker /tmp/job.json
```
