"""Preflight and source-detection tests for UltralyticsProvider.

No ML dependencies required — all checks use importlib only.
"""
from __future__ import annotations

from pathlib import Path

from yolo_export_studio.providers.ultralytics import UltralyticsProvider

_provider = UltralyticsProvider()


# ---------------------------------------------------------------------------
# detect_source
# ---------------------------------------------------------------------------

def test_detect_source_accepts_pt(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    result = _provider.detect_source(pt)
    assert result is not None
    assert result.format_id == "pt"


def test_detect_source_rejects_onnx(tmp_path):
    onnx = tmp_path / "best.onnx"
    onnx.write_bytes(b"fake")
    result = _provider.detect_source(onnx)
    assert result is None


def test_detect_source_rejects_missing():
    result = _provider.detect_source(Path("/nonexistent/path/model.pt"))
    assert result is None


# ---------------------------------------------------------------------------
# routes_for
# ---------------------------------------------------------------------------

def test_routes_for_pt(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    assert len(routes) == 15
    ids = {r.id for r in routes}
    assert ids == {
        "ultralytics.pt.torchscript",
        "ultralytics.pt.onnx",
        "ultralytics.pt.openvino",
        "ultralytics.pt.coreml",
        "ultralytics.pt.ncnn",
        "ultralytics.pt.mnn",
        "ultralytics.pt.tflite",
        "ultralytics.pt.engine",
        "ultralytics.pt.rknn",
        "ultralytics.pt.executorch",
        "ultralytics.pt.edgetpu",
        "ultralytics.pt.tfjs",
        "ultralytics.pt.paddle",
        "ultralytics.pt.imx",
        "ultralytics.pt.axelera",
    }


# ---------------------------------------------------------------------------
# preflight — torchscript
# ---------------------------------------------------------------------------

def test_preflight_torchscript_checks_ultralytics_and_torch(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    ts_route = next(r for r in routes if r.id == "ultralytics.pt.torchscript")
    results = _provider.preflight(ts_route, {})
    items = {r.item for r in results}
    assert "ultralytics" in items
    assert "torch" in items


# ---------------------------------------------------------------------------
# preflight — onnx
# ---------------------------------------------------------------------------

def test_preflight_onnx_checks_onnx_package(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    onnx_route = next(r for r in routes if r.id == "ultralytics.pt.onnx")
    results = _provider.preflight(onnx_route, {})
    items = {r.item for r in results}
    assert "onnx" in items
    onnxslim_results = [r for r in results if r.item == "onnxslim"]
    for r in onnxslim_results:
        assert r.status == "warning", f"onnxslim status should be 'warning', got {r.status!r}"


# ---------------------------------------------------------------------------
# preflight — openvino
# ---------------------------------------------------------------------------

def test_preflight_openvino_no_nncf_without_int8(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    ov_route = next(r for r in routes if r.id == "ultralytics.pt.openvino")
    results = _provider.preflight(ov_route, {"int8": False})
    items = {r.item for r in results}
    assert "nncf" not in items


def test_preflight_openvino_nncf_required_with_int8(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    ov_route = next(r for r in routes if r.id == "ultralytics.pt.openvino")
    results = _provider.preflight(ov_route, {"int8": True})
    items = {r.item for r in results}
    assert "nncf" in items


# ---------------------------------------------------------------------------
# preflight — coreml
# ---------------------------------------------------------------------------

def test_preflight_coreml_checks_platform_and_coremltools(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.coreml")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "platform" in items
    assert "coremltools" in items


# ---------------------------------------------------------------------------
# preflight — ncnn
# ---------------------------------------------------------------------------

def test_preflight_ncnn_checks_ncnn_and_pnnx(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.ncnn")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "ncnn" in items
    assert "pnnx" in items


# ---------------------------------------------------------------------------
# preflight — mnn
# ---------------------------------------------------------------------------

def test_preflight_mnn_checks_mnn_and_onnx(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.mnn")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "MNN" in items
    assert "onnx" in items


# ---------------------------------------------------------------------------
# preflight — tflite
# ---------------------------------------------------------------------------

def test_preflight_tflite_checks_all_deps(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.tflite")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "tensorflow" in items
    assert "onnx2tf" in items
    assert "onnx" in items
    assert "onnxruntime" in items


# ---------------------------------------------------------------------------
# preflight — engine (TensorRT)
# ---------------------------------------------------------------------------

def test_preflight_engine_checks_tensorrt_and_cuda_warning(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.engine")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "tensorrt" in items
    assert "cuda_gpu" in items
    cuda_result = next(r for r in results if r.item == "cuda_gpu")
    assert cuda_result.status == "warning"


def test_preflight_engine_int8_adds_calibration_result(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.engine")
    results = _provider.preflight(route, {"int8": True})
    items = {r.item for r in results}
    assert "calibration_data" in items
    cal_result = next(r for r in results if r.item == "calibration_data")
    assert cal_result.status == "calibration_required"


# ---------------------------------------------------------------------------
# preflight — rknn
# ---------------------------------------------------------------------------

def test_preflight_rknn_checks_rknn_toolkit_and_onnx(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.rknn")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "rknn-toolkit2" in items
    assert "onnx" in items


def test_preflight_rknn_warns_without_chip_name(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.rknn")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "chip_name" in items
    chip_result = next(r for r in results if r.item == "chip_name")
    assert chip_result.status == "warning"


def test_preflight_rknn_no_chip_warning_when_name_provided(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.rknn")
    results = _provider.preflight(route, {"name": "rk3588"})
    items = {r.item for r in results}
    assert "chip_name" not in items


# ---------------------------------------------------------------------------
# preflight — executorch
# ---------------------------------------------------------------------------

def test_preflight_executorch_checks_executorch_and_torch_version_warning(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.executorch")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "executorch" in items
    assert "torch_version" in items
    tv_result = next(r for r in results if r.item == "torch_version")
    assert tv_result.status == "warning"


# ---------------------------------------------------------------------------
# preflight — edgetpu
# ---------------------------------------------------------------------------

def test_preflight_edgetpu_checks_platform_tf_stack_and_binary(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.edgetpu")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "platform" in items
    assert "tensorflow" in items
    assert "onnx2tf" in items
    assert "onnx" in items
    assert "onnxruntime" in items
    assert "edgetpu_compiler" in items


# ---------------------------------------------------------------------------
# preflight — tfjs
# ---------------------------------------------------------------------------

def test_preflight_tfjs_checks_tf_stack_tensorflowjs_and_binary(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.tfjs")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "tensorflow" in items
    assert "onnx2tf" in items
    assert "onnx" in items
    assert "onnxruntime" in items
    assert "tensorflowjs" in items
    assert "tensorflowjs_converter" in items


# ---------------------------------------------------------------------------
# preflight — paddle
# ---------------------------------------------------------------------------

def test_preflight_paddle_checks_paddlepaddle_and_x2paddle(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.paddle")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "paddlepaddle" in items
    assert "x2paddle" in items


# ---------------------------------------------------------------------------
# preflight — imx
# ---------------------------------------------------------------------------

def test_preflight_imx_checks_platform_deps_and_calibration(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.imx")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "platform" in items
    assert "model-compression-toolkit" in items
    assert "sony-custom-layers" in items
    assert "imx500-converter" in items
    assert "imxconv-pt" in items
    assert "java" in items
    assert "calibration_data" in items
    cal_result = next(r for r in results if r.item == "calibration_data")
    assert cal_result.status == "calibration_required"


# ---------------------------------------------------------------------------
# preflight — axelera
# ---------------------------------------------------------------------------

def test_preflight_axelera_checks_platform_devkit_and_calibration(tmp_path):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"fake")
    source = _provider.detect_source(pt)
    assert source is not None
    routes = _provider.routes_for(source)
    route = next(r for r in routes if r.id == "ultralytics.pt.axelera")
    results = _provider.preflight(route, {})
    items = {r.item for r in results}
    assert "platform" in items
    assert "axelera-devkit" in items
    assert "torch_version" in items
    tv_result = next(r for r in results if r.item == "torch_version")
    assert tv_result.status == "warning"
    assert "calibration_data" in items
    cal_result = next(r for r in results if r.item == "calibration_data")
    assert cal_result.status == "calibration_required"
