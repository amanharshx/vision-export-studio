# YOLO Export Studio

Desktop ML model export studio. Drop a model file, pick a target format, convert locally through the user's Python environment.

Status: early v2 scaffold.

## Product Boundary

YOLO Export Studio is a model export studio, not a universal all-to-all converter.

```text
source format -> supported route -> target format
```

Current source focus: Ultralytics-compatible `.pt` weights.

YOLO Export Studio must not imply compiled/runtime outputs are reversible. TensorRT, RKNN, IMX, Edge TPU, Axelera, TFLite, and some CoreML outputs are one-way or platform-locked deployment artifacts.

## Stack

```text
React + TypeScript + Tailwind + shadcn
Tauri v2 desktop shell
Rust command layer for process control
Ultralytics `yolo export` CLI as export engine
Bun for all JavaScript package tasks
```

Python remains in this branch only for route metadata and legacy worker reference while v2 reaches parity.

## Architecture

```text
React UI
  -> Tauri invoke/listen
Rust command layer
  -> validates paths/options
  -> finds selected Python and yolo CLI
  -> spawns yolo export with argv, not shell strings
  -> streams stdout/stderr events
  -> owns cancel/kill
Ultralytics CLI
  -> runs export in user's Python environment
```

React must not spawn shell commands directly. The Rust layer owns subprocess handles, quoting, cancel, and event streaming.

## Supported Initial Routes

Route metadata is migrated from `yolo_export_studio/providers/ultralytics.py` into `src/lib/routes.ts`.

| Target | Notes |
|---|---|
| TorchScript | Intermediate |
| ONNX | Portable intermediate |
| OpenVINO | Intel deployment |
| TensorRT | NVIDIA GPU, one-way |
| CoreML | Apple target, one-way |
| TFLite | Mobile/runtime, often one-way |
| Edge TPU | Coral, Linux x86_64, one-way |
| TF.js | Browser/Node deployment |
| PaddlePaddle | Intermediate/runtime |
| NCNN | Mobile/embedded |
| MNN | Mobile runtime, one-way |
| RKNN | Rockchip NPU, chip-locked |
| Sony IMX500 | Linux, calibration required |
| ExecuTorch | On-device runtime |
| Axelera Metis | Linux, calibration required |

## Development

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

## Project Structure

```text
src/
  components/ui/          shadcn components
  features/export/        export workspace UI
  features/environment/   Python/yolo status UI
  lib/routes.ts           temporary TS route metadata
  lib/types.ts            shared frontend types
src-tauri/
  src/                    Tauri v2 Rust entry and future commands
yolo_export_studio/
  core/                   legacy route/preflight/job models, temporary reference
  providers/              legacy Ultralytics metadata, temporary reference
  workers/                legacy worker, temporary reference
```
