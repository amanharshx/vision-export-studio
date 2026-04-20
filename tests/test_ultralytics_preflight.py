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
    assert len(routes) == 3
    ids = {r.id for r in routes}
    assert ids == {
        "ultralytics.pt.torchscript",
        "ultralytics.pt.onnx",
        "ultralytics.pt.openvino",
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
