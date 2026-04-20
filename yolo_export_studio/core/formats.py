"""Format catalogue — all recognized model formats in YOLO Export Studio."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


FormatCategory = Literal["source", "intermediate", "runtime", "vendor"]


@dataclass(frozen=True)
class FormatSpec:
    """Describes one model file/directory format."""

    id: str
    name: str
    suffixes: tuple[str, ...]
    category: FormatCategory
    can_be_source: bool
    can_be_target: bool
    one_way: bool
    platform_locked: bool
    notes: str = ""


# ---------------------------------------------------------------------------
# Format catalogue
# ---------------------------------------------------------------------------

PT = FormatSpec(
    id="pt",
    name="PyTorch Weights",
    suffixes=(".pt",),
    category="source",
    can_be_source=True,
    can_be_target=False,
    one_way=False,
    platform_locked=False,
    notes="Ultralytics YOLO .pt files only. Generic PyTorch checkpoints are not supported.",
)

TORCHSCRIPT = FormatSpec(
    id="torchscript",
    name="TorchScript",
    suffixes=(".torchscript",),
    category="intermediate",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="Traced TorchScript module. Easiest target after ONNX.",
)

ONNX = FormatSpec(
    id="onnx",
    name="ONNX",
    suffixes=(".onnx",),
    category="intermediate",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="Most portable intermediate. Common starting point for downstream conversions.",
)

OPENVINO = FormatSpec(
    id="openvino",
    name="OpenVINO IR",
    suffixes=("_openvino_model/",),
    category="intermediate",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="Optimised for Intel CPUs, iGPUs, and VPUs. Outputs model.xml + model.bin + metadata.yaml.",
)

ENGINE = FormatSpec(
    id="engine",
    name="TensorRT Engine",
    suffixes=(".engine",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=True,
    notes="GPU-architecture and TensorRT-version locked. Cannot be used on a different GPU or TRT version.",
)

COREML = FormatSpec(
    id="coreml",
    name="CoreML",
    suffixes=(".mlpackage",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=True,
    notes="Apple ecosystem only. Cannot be built on Windows.",
)

SAVED_MODEL = FormatSpec(
    id="saved_model",
    name="TF SavedModel",
    suffixes=("_saved_model/",),
    category="intermediate",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="TensorFlow SavedModel directory. Also generates .tflite variants alongside.",
)

PB = FormatSpec(
    id="pb",
    name="TF GraphDef",
    suffixes=(".pb",),
    category="intermediate",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="Frozen TensorFlow graph. Used as intermediate for TFJS conversion.",
)

TFLITE = FormatSpec(
    id="tflite",
    name="TFLite",
    suffixes=(".tflite",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=False,
    notes="TensorFlow Lite flatbuffer. INT8 variant requires calibration data.",
)

EDGETPU = FormatSpec(
    id="edgetpu",
    name="Edge TPU",
    suffixes=("_edgetpu.tflite",),
    category="vendor",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=True,
    notes="Google Coral hardware only. Requires edgetpu_compiler system binary. Linux x86_64 export only.",
)

TFJS = FormatSpec(
    id="tfjs",
    name="TensorFlow.js",
    suffixes=("_web_model/",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="Browser/Node.js deployment. Requires tensorflowjs_converter binary.",
)

PADDLE = FormatSpec(
    id="paddle",
    name="PaddlePaddle",
    suffixes=("_paddle_model/",),
    category="intermediate",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
)

NCNN = FormatSpec(
    id="ncnn",
    name="NCNN",
    suffixes=("_ncnn_model/",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="Optimised for ARM/Android. Outputs .param + .bin pair.",
)

MNN = FormatSpec(
    id="mnn",
    name="MNN",
    suffixes=(".mnn",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
)

RKNN = FormatSpec(
    id="rknn",
    name="RKNN",
    suffixes=("_rknn_model/",),
    category="vendor",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=True,
    notes="Rockchip NPU binary. Target chip must be specified (e.g. rk3588).",
)

IMX = FormatSpec(
    id="imx",
    name="Sony IMX500",
    suffixes=("_imx_model/",),
    category="vendor",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=True,
    notes="Sony IMX500 AI sensor. Linux only. Requires Java 17+, imxconv-pt, and calibration data.",
)

EXECUTORCH = FormatSpec(
    id="executorch",
    name="ExecuTorch",
    suffixes=(".pte",),
    category="runtime",
    can_be_source=False,
    can_be_target=True,
    one_way=False,
    platform_locked=False,
    notes="XNNPACK-optimised on-device inference. Requires torch >= 2.9.",
)

AXELERA = FormatSpec(
    id="axelera",
    name="Axelera Metis",
    suffixes=("_axelera_model/",),
    category="vendor",
    can_be_source=False,
    can_be_target=True,
    one_way=True,
    platform_locked=True,
    notes="Axelera AIPU binary. Linux only. Requires calibration data and torch >= 2.8.",
)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

ALL_FORMATS: dict[str, FormatSpec] = {
    f.id: f
    for f in [
        PT, TORCHSCRIPT, ONNX, OPENVINO, ENGINE, COREML,
        SAVED_MODEL, PB, TFLITE, EDGETPU, TFJS, PADDLE,
        NCNN, MNN, RKNN, IMX, EXECUTORCH, AXELERA,
    ]
}
