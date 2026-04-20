"""Ultralytics provider — real model export via ultralytics.YOLO.export()."""
from __future__ import annotations

import contextlib
import importlib.util
import sys
import traceback
from pathlib import Path

from yolo_export_studio.core.jobs import ExportJob
from yolo_export_studio.core.logs import (
    ArtifactEvent,
    FinishedEvent,
    LogEvent,
    ProgressEvent,
    StartedEvent,
)
from yolo_export_studio.core.preflight import CheckResult, check_binary, check_package, check_platform
from yolo_export_studio.core.providers import ExportProvider, SourceMatch, register_provider
from yolo_export_studio.core.routes import Route


TORCHSCRIPT_ROUTE = Route(
    id="ultralytics.pt.torchscript",
    provider_id="ultralytics",
    source_format="pt",
    target_format="torchscript",
    display_path="model.pt → model.torchscript",
    pip_deps=(),
    supports_half=True,
    supports_dynamic=True,
    notes="Uses torch.jit.trace with strict=False.",
)

ONNX_ROUTE = Route(
    id="ultralytics.pt.onnx",
    provider_id="ultralytics",
    source_format="pt",
    target_format="onnx",
    display_path="model.pt → model.onnx",
    pip_deps=(
        ("onnx", "pip install onnx"),
        ("onnxslim", "pip install onnxslim"),
    ),
    supports_half=True,
    supports_dynamic=True,
    notes="Most portable format. onnxslim optional.",
)

OPENVINO_ROUTE = Route(
    id="ultralytics.pt.openvino",
    provider_id="ultralytics",
    source_format="pt",
    target_format="openvino",
    display_path="model.pt → model_openvino_model/",
    pip_deps=(
        ("openvino", "pip install openvino"),
        ("nncf", "pip install nncf"),
    ),
    supports_half=True,
    supports_int8=True,
    supports_dynamic=True,
    notes="Direct PyTorch → OpenVINO IR. INT8 requires nncf + calibration data.",
)

COREML_ROUTE = Route(
    id="ultralytics.pt.coreml",
    provider_id="ultralytics",
    source_format="pt",
    target_format="coreml",
    display_path="model.pt → model.torchscript → model.mlpackage",
    pip_deps=(("coremltools", "pip install coremltools"),),
    platform_lock="not_windows",
    intermediates=("torchscript",),
    supports_half=True,
    supports_int8=True,
    one_way=True,
    lossy=True,
    notes="macOS/Linux only. Intermediate TorchScript is discarded. One-way.",
)

NCNN_ROUTE = Route(
    id="ultralytics.pt.ncnn",
    provider_id="ultralytics",
    source_format="pt",
    target_format="ncnn",
    display_path="model.pt → model_ncnn_model/",
    pip_deps=(
        ("ncnn", "pip install ncnn"),
        ("pnnx", "pip install pnnx"),
    ),
    supports_half=True,
    notes="Lightweight mobile/embedded inference. Requires ncnn and pnnx.",
)

MNN_ROUTE = Route(
    id="ultralytics.pt.mnn",
    provider_id="ultralytics",
    source_format="pt",
    target_format="mnn",
    display_path="model.pt → model.onnx → model.mnn",
    pip_deps=(
        ("MNN", "pip install MNN"),
        ("onnx", "pip install onnx"),
    ),
    intermediates=("onnx",),
    supports_half=True,
    supports_int8=True,
    one_way=True,
    notes="MNN mobile inference. Intermediate ONNX is discarded. One-way.",
)

TFLITE_ROUTE = Route(
    id="ultralytics.pt.tflite",
    provider_id="ultralytics",
    source_format="pt",
    target_format="tflite",
    display_path="model.pt → model.onnx → saved_model/ → model.tflite",
    pip_deps=(
        ("tensorflow", "pip install tensorflow"),
        ("onnx2tf", "pip install onnx2tf"),
        ("onnx", "pip install onnx"),
        ("onnxruntime", "pip install onnxruntime"),
    ),
    intermediates=("onnx", "saved_model"),
    supports_half=True,
    supports_int8=True,
    one_way=True,
    lossy=True,
    needs_calibration=True,
    notes="EdgeTPU / mobile deployment. Multi-step pipeline. One-way, lossy. INT8 requires calibration data.",
)

ENGINE_ROUTE = Route(
    id="ultralytics.pt.engine",
    provider_id="ultralytics",
    source_format="pt",
    target_format="engine",
    display_path="model.pt → model.onnx → model.engine",
    pip_deps=(("tensorrt", "pip install tensorrt"),),
    intermediates=("onnx",),
    requires_gpu=True,
    supports_half=True,
    supports_int8=True,
    one_way=True,
    lossy=True,
    needs_calibration=True,
    notes="TensorRT engine. NVIDIA GPU required. One-way, platform-locked at runtime. INT8 requires calibration dataset.",
)

RKNN_ROUTE = Route(
    id="ultralytics.pt.rknn",
    provider_id="ultralytics",
    source_format="pt",
    target_format="rknn",
    display_path="model.pt → _rknn_model/{stem}-{chip}.rknn",
    pip_deps=(
        ("rknn-toolkit2", "pip install rknn-toolkit2"),
        ("onnx", "pip install onnx"),
    ),
    intermediates=("onnx",),
    one_way=True,
    lossy=True,
    notes="Rockchip NPU deployment. Requires target chip name (name= option). Lossy: discards FP precision.",
)

EXECUTORCH_ROUTE = Route(
    id="ultralytics.pt.executorch",
    provider_id="ultralytics",
    source_format="pt",
    target_format="executorch",
    display_path="model.pt → model.pte",
    pip_deps=(("executorch", "pip install executorch"),),
    one_way=True,
    notes="PyTorch ExecuTorch on-device inference. Requires torch >= 2.9. One-way.",
)

EDGETPU_ROUTE = Route(
    id="ultralytics.pt.edgetpu",
    provider_id="ultralytics",
    source_format="pt",
    target_format="edgetpu",
    display_path="model.pt → model.onnx → saved_model/ → model.tflite → edgetpu_compiler → model_edgetpu.tflite",
    pip_deps=(
        ("tensorflow", "pip install tensorflow"),
        ("onnx2tf", "pip install onnx2tf"),
        ("onnx", "pip install onnx"),
        ("onnxruntime", "pip install onnxruntime"),
    ),
    sys_deps=(("edgetpu_compiler", "Download from https://coral.ai/docs/edgetpu/compiler/#download"),),
    platform_lock="linux_x86_64",
    intermediates=("onnx", "saved_model", "tflite"),
    one_way=True,
    lossy=True,
    needs_calibration=True,
    notes="Google Coral hardware only. Full-integer quantisation forced. Linux x86_64 and edgetpu_compiler binary required.",
)

TFJS_ROUTE = Route(
    id="ultralytics.pt.tfjs",
    provider_id="ultralytics",
    source_format="pt",
    target_format="tfjs",
    display_path="model.pt → model.onnx → saved_model/ → model.pb → tensorflowjs_converter → model_web_model/",
    pip_deps=(
        ("tensorflow", "pip install tensorflow"),
        ("onnx2tf", "pip install onnx2tf"),
        ("onnx", "pip install onnx"),
        ("onnxruntime", "pip install onnxruntime"),
        ("tensorflowjs", "pip install tensorflowjs"),
    ),
    sys_deps=(("tensorflowjs_converter", "pip install tensorflowjs"),),
    intermediates=("onnx", "saved_model", "pb"),
    supports_half=True,
    supports_int8=True,
    notes="Browser/Node.js deployment. tensorflowjs_converter binary installed via pip install tensorflowjs.",
)

PADDLE_ROUTE = Route(
    id="ultralytics.pt.paddle",
    provider_id="ultralytics",
    source_format="pt",
    target_format="paddle",
    display_path="model.pt → model_paddle_model/",
    pip_deps=(
        ("paddlepaddle", "pip install paddlepaddle"),
        ("x2paddle", "pip install x2paddle"),
    ),
    notes="PaddlePaddle via x2paddle jit.trace. Direct PyTorch → Paddle.",
)

IMX_ROUTE = Route(
    id="ultralytics.pt.imx",
    provider_id="ultralytics",
    source_format="pt",
    target_format="imx",
    display_path="model.pt → FXModel → MCT INT8 → model_imx.onnx → imxconv-pt → model_imx_model/",
    pip_deps=(
        ("model-compression-toolkit", "pip install model-compression-toolkit"),
        ("sony-custom-layers", "pip install sony-custom-layers"),
        ("imx500-converter", "pip install imx500-converter"),
    ),
    sys_deps=(
        ("imxconv-pt", "pip install imx500-converter"),
        ("java", "Install Java >= 17: https://adoptium.net/"),
    ),
    platform_lock="linux",
    intermediates=("onnx",),
    supports_int8=True,
    one_way=True,
    lossy=True,
    needs_calibration=True,
    notes="Sony IMX500 AI sensor. Linux only. int8 forced True. Java >= 17 required. Calibration always required.",
)

AXELERA_ROUTE = Route(
    id="ultralytics.pt.axelera",
    provider_id="ultralytics",
    source_format="pt",
    target_format="axelera",
    display_path="model.pt → axelera.quantize → axelera.compile → model_axelera_model/",
    pip_deps=(("axelera", "pip install axelera-devkit"),),
    platform_lock="linux",
    supports_int8=True,
    one_way=True,
    lossy=True,
    needs_calibration=True,
    notes="Axelera Metis AIPU binary. Linux only. Calibration required. Requires torch >= 2.8.",
)


def _check_tf_stack(results: list) -> None:
    results.append(check_package("tensorflow", "pip install tensorflow"))
    results.append(check_package("onnx2tf", "pip install onnx2tf"))
    results.append(check_package("onnx", "pip install onnx"))
    results.append(check_package("onnxruntime", "pip install onnxruntime"))


def _get_size(path: str | Path) -> int:
    p = Path(str(path))
    if p.is_file():
        return p.stat().st_size
    if p.is_dir():
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return 0


_ROUTES_BY_ID: dict[str, Route] = {
    r.id: r
    for r in (
        TORCHSCRIPT_ROUTE,
        ONNX_ROUTE,
        OPENVINO_ROUTE,
        COREML_ROUTE,
        NCNN_ROUTE,
        MNN_ROUTE,
        TFLITE_ROUTE,
        ENGINE_ROUTE,
        RKNN_ROUTE,
        EXECUTORCH_ROUTE,
        EDGETPU_ROUTE,
        TFJS_ROUTE,
        PADDLE_ROUTE,
        IMX_ROUTE,
        AXELERA_ROUTE,
    )
}


class UltralyticsProvider(ExportProvider):
    """
    Ultralytics export provider. Accepts .pt model files.
    GUI-side: detect_source, routes_for, preflight, build_job — no ML imports.
    Worker-side: run() — imports ultralytics and torch here only.
    """

    @property
    def id(self) -> str:
        return "ultralytics"

    @property
    def name(self) -> str:
        return "Ultralytics"

    def detect_source(self, path: Path) -> SourceMatch | None:
        if path.suffix.lower() == ".pt" and path.exists() and path.is_file():
            return SourceMatch(
                provider_id="ultralytics",
                format_id="pt",
                path=path,
                display_name=f"{path.name} (Ultralytics YOLO)",
            )
        return None

    def routes_for(self, source: SourceMatch) -> list[Route]:
        if source.format_id == "pt":
            return [
                TORCHSCRIPT_ROUTE,
                ONNX_ROUTE,
                OPENVINO_ROUTE,
                COREML_ROUTE,
                NCNN_ROUTE,
                MNN_ROUTE,
                TFLITE_ROUTE,
                ENGINE_ROUTE,
                RKNN_ROUTE,
                EXECUTORCH_ROUTE,
                EDGETPU_ROUTE,
                TFJS_ROUTE,
                PADDLE_ROUTE,
                IMX_ROUTE,
                AXELERA_ROUTE,
            ]
        return []

    def preflight(self, route: Route, options: dict) -> list[CheckResult]:
        results: list[CheckResult] = [
            check_package("ultralytics", "pip install ultralytics"),
            check_package("torch", "pip install torch"),
        ]

        if route.id == "ultralytics.pt.onnx":
            results.append(check_package("onnx", "pip install onnx"))
            if importlib.util.find_spec("onnxslim") is None:
                results.append(CheckResult(
                    item="onnxslim",
                    status="warning",
                    reason=(
                        "onnxslim not installed; ONNX graph will not be simplified. "
                        "Install: pip install onnxslim"
                    ),
                    install_hint="pip install onnxslim",
                ))

        elif route.id == "ultralytics.pt.openvino":
            results.append(check_package("openvino", "pip install openvino"))
            if options.get("int8"):
                results.append(check_package("nncf", "pip install nncf"))

        elif route.id == "ultralytics.pt.coreml":
            results.append(check_platform("not_windows"))
            results.append(check_package("coremltools", "pip install coremltools"))

        elif route.id == "ultralytics.pt.ncnn":
            results.append(check_package("ncnn", "pip install ncnn"))
            results.append(check_package("pnnx", "pip install pnnx"))

        elif route.id == "ultralytics.pt.mnn":
            results.append(check_package("MNN", "pip install MNN"))
            results.append(check_package("onnx", "pip install onnx"))

        elif route.id == "ultralytics.pt.tflite":
            _check_tf_stack(results)

        elif route.id == "ultralytics.pt.engine":
            results.append(check_package("tensorrt", "pip install tensorrt"))
            results.append(CheckResult(
                item="cuda_gpu",
                status="warning",
                reason=(
                    "TensorRT requires an NVIDIA CUDA GPU. "
                    "CUDA availability cannot be verified without importing torch. "
                    "Ensure an NVIDIA GPU with the CUDA toolkit is installed."
                ),
                install_hint="Install CUDA toolkit: https://developer.nvidia.com/cuda-downloads",
            ))
            if options.get("int8"):
                results.append(CheckResult(
                    item="calibration_data",
                    status="calibration_required",
                    reason="INT8 TensorRT export requires a calibration dataset.",
                    install_hint="Pass data='path/to/data.yaml' in options.",
                ))

        elif route.id == "ultralytics.pt.rknn":
            # rknn-toolkit2 pip name differs from importable name 'rknn'; cannot use check_package directly
            _rknn_spec = importlib.util.find_spec("rknn")
            if _rknn_spec is None:
                results.append(CheckResult(
                    item="rknn-toolkit2",
                    status="missing_package",
                    reason="Package 'rknn-toolkit2' is not installed.",
                    install_hint="pip install rknn-toolkit2",
                ))
            else:
                results.append(CheckResult(item="rknn-toolkit2", status="ready"))
            results.append(check_package("onnx", "pip install onnx"))
            if not options.get("name"):
                results.append(CheckResult(
                    item="chip_name",
                    status="warning",
                    reason=(
                        "No target chip specified (name= option). "
                        "RKNN requires a chip name, e.g. rk3588, rk3576, rv1106."
                    ),
                    install_hint="Pass name='rk3588' (or your chip) in options.",
                ))

        elif route.id == "ultralytics.pt.executorch":
            results.append(check_package("executorch", "pip install executorch"))
            results.append(CheckResult(
                item="torch_version",
                status="warning",
                reason=(
                    "ExecuTorch requires torch >= 2.9. "
                    "Torch version cannot be verified without importing torch. "
                    "Ensure your environment has torch >= 2.9 installed."
                ),
                install_hint="pip install 'torch>=2.9'",
            ))

        elif route.id == "ultralytics.pt.edgetpu":
            results.append(check_platform("linux_x86_64"))
            _check_tf_stack(results)
            results.append(check_binary(
                "edgetpu_compiler",
                "Download from https://coral.ai/docs/edgetpu/compiler/#download",
                docs_url="https://coral.ai/docs/edgetpu/compiler/",
            ))

        elif route.id == "ultralytics.pt.tfjs":
            _check_tf_stack(results)
            results.append(check_package("tensorflowjs", "pip install tensorflowjs"))
            results.append(check_binary(
                "tensorflowjs_converter",
                "pip install tensorflowjs",
                docs_url="https://github.com/tensorflow/tfjs/tree/master/tfjs-converter",
            ))

        elif route.id == "ultralytics.pt.paddle":
            results.append(check_package("paddlepaddle", "pip install paddlepaddle"))
            results.append(check_package("x2paddle", "pip install x2paddle"))

        elif route.id == "ultralytics.pt.imx":
            results.append(check_platform("linux"))
            _mct_spec = importlib.util.find_spec("model_compression_toolkit")
            if _mct_spec is None:
                results.append(CheckResult(
                    item="model-compression-toolkit",
                    status="missing_package",
                    reason="Package 'model-compression-toolkit' is not installed.",
                    install_hint="pip install model-compression-toolkit",
                ))
            else:
                results.append(CheckResult(item="model-compression-toolkit", status="ready"))
            _scl_spec = importlib.util.find_spec("sony_custom_layers")
            if _scl_spec is None:
                results.append(CheckResult(
                    item="sony-custom-layers",
                    status="missing_package",
                    reason="Package 'sony-custom-layers' is not installed.",
                    install_hint="pip install sony-custom-layers",
                ))
            else:
                results.append(CheckResult(item="sony-custom-layers", status="ready"))
            _imxconv_spec = importlib.util.find_spec("imx500_converter")
            if _imxconv_spec is None:
                results.append(CheckResult(
                    item="imx500-converter",
                    status="missing_package",
                    reason="Package 'imx500-converter' is not installed.",
                    install_hint="pip install imx500-converter",
                ))
            else:
                results.append(CheckResult(item="imx500-converter", status="ready"))
            results.append(check_binary(
                "imxconv-pt",
                "pip install imx500-converter  # installs imxconv-pt binary",
                docs_url="https://developer.aitrios.sony-semicon.com/en/raspberrypi-ai-camera/",
            ))
            _java_check = check_binary("java", "Install Java >= 17: https://adoptium.net/", docs_url="https://adoptium.net/")
            if _java_check.status == "ready":
                results.append(CheckResult(
                    item="java",
                    status="warning",
                    reason="java binary found on PATH. Ensure version is >= 17 (run: java -version).",
                    install_hint="Install Java >= 17: https://adoptium.net/",
                ))
            else:
                results.append(_java_check)
            results.append(CheckResult(
                item="calibration_data",
                status="calibration_required",
                reason="IMX500 always requires a calibration dataset (MCT quantisation).",
                install_hint="Pass data='path/to/data.yaml' in options.",
            ))

        elif route.id == "ultralytics.pt.axelera":
            results.append(check_platform("linux"))
            # pip package is 'axelera-devkit'; expected importable top-level namespace is 'axelera'
            _axelera_spec = importlib.util.find_spec("axelera")
            if _axelera_spec is None:
                results.append(CheckResult(
                    item="axelera-devkit",
                    status="missing_package",
                    reason="Package 'axelera-devkit' is not installed.",
                    install_hint="pip install axelera-devkit",
                ))
            else:
                results.append(CheckResult(item="axelera-devkit", status="ready"))
            results.append(CheckResult(
                item="torch_version",
                status="warning",
                reason=(
                    "Axelera requires torch >= 2.8. "
                    "Torch version cannot be verified without importing torch. "
                    "Ensure your environment has torch >= 2.8 installed."
                ),
                install_hint="pip install 'torch>=2.8'",
            ))
            results.append(CheckResult(
                item="calibration_data",
                status="calibration_required",
                reason="Axelera compilation requires a calibration dataset.",
                install_hint="Pass data='path/to/data.yaml' in options.",
            ))

        return results

    def build_job(
        self,
        source: Path,
        route: Route,
        options: dict,
        output_dir: Path,
    ) -> ExportJob:
        return ExportJob.create(
            provider=self.id,
            route=route.id,
            source_path=source,
            output_dir=output_dir,
            python_executable=Path(sys.executable),
            options=options,
        )

    def run(self, job: ExportJob) -> None:
        """Worker-side execution. Called from export_worker inside the subprocess."""

        def emit(event) -> None:
            print(event.to_jsonl(), flush=True)

        try:
            emit(StartedEvent(job_id=job.job_id, route=job.route))

            route = _ROUTES_BY_ID.get(job.route)
            if route is None:
                emit(FinishedEvent(ok=False, error=f"Unknown route: {job.route!r}"))
                sys.exit(1)

            emit(LogEvent(level="info", message=f"Loading model: {job.source_path}"))

            with contextlib.redirect_stdout(sys.stderr):
                from ultralytics import YOLO  # noqa: PLC0415
                model = YOLO(job.source_path)

            emit(ProgressEvent(value=25, message="Model loaded"))

            target_format = route.target_format

            kwargs = {k: v for k, v in job.options.items() if v is not None}
            if kwargs.get("opset") == 0:
                del kwargs["opset"]

            emit(LogEvent(level="info", message=f"Exporting to {target_format}..."))
            emit(ProgressEvent(value=50, message="Exporting"))

            with contextlib.redirect_stdout(sys.stderr):
                artifact = model.export(format=target_format, **kwargs)

            if not artifact or not Path(str(artifact)).exists():
                emit(FinishedEvent(ok=False, error="Export returned no artifact path"))
                sys.exit(1)

            emit(ProgressEvent(value=90, message="Finalising"))
            emit(ArtifactEvent(
                path=str(artifact),
                size_bytes=_get_size(artifact),
                format_id=target_format,
            ))
            emit(FinishedEvent(ok=True))

        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            emit(FinishedEvent(ok=False, error=str(exc)))
            sys.exit(1)


register_provider(UltralyticsProvider())
