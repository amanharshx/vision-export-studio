# Export Reference

Detailed route, precision, platform, and runtime reference for Vision Export Studio.
For install and first-run steps, see [README.md](../README.md).

Sources of truth are `src/lib/providers/ultralytics.ts`, `src/lib/providers/rfdetr.ts`,
`src-tauri/src/commands/stack_environments.rs` (`KNOWN_STACKS`),
`src-tauri/src/commands/environment.rs`, and `src-tauri/src/commands/deps.rs`.
If this document disagrees with those files, the code wins.

## Runtimes and Python

- Host Python 3.10–3.13 is required to create managed environments. Discovery prefers
  3.12, then 3.13, 3.11, 3.10. There is no bundled Python; install Python 3 first and
  restart the app.
- A chosen/override Python is bootstrap only: the app uses it to create the managed
  environment. Packages are never installed into it and exports never run through it.
- Ultralytics managed environment: `~/.vision-export-studio/.venv`.
- RF-DETR stack environments: `~/.vision-export-studio/envs/<stack-key>/.venv`:

| Stack key | Routes | Python requirement |
| --- | --- | --- |
| `rfdetr-default` | `rfdetr.pth.onnx`, `rfdetr.pth.executorch` | 3.10–3.13 (prefers 3.12) |
| `rfdetr-tensorrt` | `rfdetr.pth.engine` | 3.10–3.13 (prefers 3.12) |
| `rfdetr-coreml` | `rfdetr.pth.coreml` | 3.10–3.13 (prefers 3.12) |
| `rfdetr-tflite` | `rfdetr.pth.tflite` | `>=3.12, <3.13` (Python 3.12 only) |

- Set up is per route and explicit. Setting up one route does not set up other routes,
  and setup never starts an export.
- After `Remove` / `Reset runtime`, the loaded model stays in the workspace; the
  affected routes need Set up again before export.

## Dependency floors

- Ultralytics exports require `ultralytics>=8.4.80`.
- The Ultralytics LiteRT route requires `ultralytics>=8.4.83`.
- RF-DETR TFLite requires `rfdetr[tflite]>=1.9.4`.
- RF-DETR ExecuTorch requires `rfdetr[executorch]>=1.9.0` plus `torch>=2.13` and a
  FlatBuffers compiler (`flatc`, installed with `--pre` when taken from PyPI).

## Ultralytics YOLO (`.pt`) routes

Source: Ultralytics-compatible `.pt` weights only. Extension mismatches are rejected
when you pick a provider.

| Target | Route ID | Export path | Run on | Precision modes | Default |
| --- | --- | --- | --- | --- | --- |
| ONNX | `ultralytics.pt.onnx` | `model.pt → model.onnx` | Any OS | FP16, FP32, INT8 | FP16 |
| TorchScript | `ultralytics.pt.torchscript` | `model.pt → model.torchscript` | Any OS | FP32 (fixed) | FP32 |
| OpenVINO | `ultralytics.pt.openvino` | `model.pt → model_openvino_model/` | Any OS | FP16, FP32, INT8 | FP16 |
| TensorRT | `ultralytics.pt.engine` | `model.pt → model.onnx → model.engine` | Linux, Windows (NVIDIA GPU required; no macOS) | FP16, FP32, INT8 | FP16 |
| CoreML | `ultralytics.pt.coreml` | `model.pt → model.torchscript → model.mlpackage` | macOS, Linux (Windows unsupported) | FP16, FP32, INT8, W8A16 | FP16 |
| LiteRT | `ultralytics.pt.litert` | `model.pt → model.tflite` | macOS, Linux `x86_64` (Windows and Linux ARM64 unsupported) | FP32, INT8, W8A16, W8A32 | FP32 |
| TF SavedModel | `ultralytics.pt.saved_model` | `model.pt → model.onnx → model_saved_model/` | Any OS | FP32, INT8 | FP32 |
| TF GraphDef | `ultralytics.pt.pb` | `model.pt → model.onnx → saved_model/ → model.pb` | Any OS | FP32 (fixed) | FP32 |
| TF Edge TPU | `ultralytics.pt.edgetpu` | `model.pt → model.onnx → saved_model/ → model.tflite → edgetpu_compiler → model_edgetpu.tflite` | Linux `x86_64` plus `edgetpu_compiler` binary | INT8 (fixed) | INT8 |
| PaddlePaddle | `ultralytics.pt.paddle` | `model.pt → model_paddle_model/` | Any OS | FP32 (fixed) | FP32 |
| NCNN | `ultralytics.pt.ncnn` | `model.pt → model_ncnn_model/` | Any OS | FP16, FP32 | FP16 |
| MNN | `ultralytics.pt.mnn` | `model.pt → model.onnx → model.mnn` | Any OS | FP16, FP32, INT8 | FP16 |
| RKNN | `ultralytics.pt.rknn` | `model.pt → _rknn_model/{stem}-{chip}.rknn` | Linux only, target chip required | FP16, INT8 | FP16 |
| Sony IMX500 | `ultralytics.pt.imx` | `model.pt → FXModel → MCT INT8 → model_imx.onnx → imxconv-pt → model_imx_model/` | Linux only, Java `>= 17` required | INT8, W8A16 | INT8 |
| Axelera | `ultralytics.pt.axelera` | `model.pt → axelera.quantize → axelera.compile → model_axelera_model/` | Linux only | INT8 (fixed) | INT8 |
| ExecuTorch | `ultralytics.pt.executorch` | `model.pt → model.pte` | Any OS | FP32 (fixed) | FP32 |

Notes:

- Export commands pass an explicit canonical `quantize=` argument (`32`, `16`, `8`,
  `w8a16`, `w8a32`) instead of legacy `half=` / `int8=` switches.
- TorchScript is FP32-only in this app. Ultralytics FP16 TorchScript export requires
  GPU `device=0`; this app does not expose export-device selection.
- RKNN precision depends on the selected chip: `rv1103`, `rv1106`, `rv1103b`, and
  `rv1106b` are INT8-only and fix Precision to INT8; all other Rockchip targets offer
  FP16 and INT8.
- Ultralytics CoreML INT8 and W8A16 produce the same palettized artifact (same
  8-bit `OpPalettizerConfig` path; observed byte-identical output). This is upstream
  behavior, not a Vision Export Studio bug.
- `engine`, `edgetpu`, `rknn`, `imx`, `axelera`, `mnn`, `litert`, and `coreml` outputs
  should be treated as one-way deployment artifacts.
- Deferred Ultralytics targets (DEEPX, QNN, Hailo, Ascend) are unsupported and not
  listed as shipping routes.

## RF-DETR (`.pth`) routes

Source: Roboflow RF-DETR `.pth` checkpoints. Checkpoint trust is explicit, session-only,
and resets when the file changes.

| Target | Route ID | Export path | Run on | Precision | Default |
| --- | --- | --- | --- | --- | --- |
| ONNX | `rfdetr.pth.onnx` | `checkpoint.pth -> inference_model.onnx` | Any OS | FP32 (fixed) | FP32 |
| TensorRT via ONNX | `rfdetr.pth.engine` | `checkpoint.pth -> model.trt` | Linux, Windows (NVIDIA GPU required; no macOS) | FP32 (fixed) | FP32 |
| CoreML | `rfdetr.pth.coreml` | `checkpoint.pth -> rfdetr-small.mlpackage` | macOS only | FP32, FP16 | FP32 |
| TFLite | `rfdetr.pth.tflite` | `checkpoint.pth -> multiple .tflite files` | Any OS (stack requires Python 3.12) | FP32, INT8 | FP32 |
| ExecuTorch (XNNPACK) | `rfdetr.pth.executorch` | `checkpoint.pth -> rfdetr-small.pte` | macOS ARM64 14+, Linux `x86_64`, or Windows `x86_64` | FP32 (fixed) | FP32 |

RF-DETR caveats:

- ONNX is the recommended target and primary validation path.
- CoreML is an experimental native export with fixed shapes; dynamic batch is
  unsupported.
- TFLite is an experimental ONNX → TensorFlow → TFLite route (`onnx2tf` output
  layouts can vary). Standard export always emits FP32 and FP16 files; INT8 adds a
  dynamic-range weight-quantized file and requires no calibration data. The
  `rfdetr-tflite` stack requires Python `>=3.12, <3.13`.
- ExecuTorch is an experimental XNNPACK CPU export. It expects fixed-shape,
  fixed-batch, ImageNet-normalized contiguous NCHW runtime input.

## Calibration data

INT8 calibration modes offer an optional dataset YAML picker for: ONNX / OpenVINO /
TensorRT / SavedModel INT8, LiteRT INT8 and W8A16, RKNN INT8, IMX INT8 and W8A16, and
Edge TPU and Axelera INT8.

The calibration dataset is optional. When omitted, the export still runs and
Ultralytics falls back to its default calibration dataset, so accuracy may differ.
Calibration YAML is stored per route and is never auto-reused across routes.
RF-DETR TFLite INT8 uses dynamic-range weight quantization and takes no calibration data.
