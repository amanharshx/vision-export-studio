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
from yolo_export_studio.core.preflight import CheckResult, check_package
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


def _get_size(path: str | Path) -> int:
    p = Path(str(path))
    if p.is_file():
        return p.stat().st_size
    if p.is_dir():
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return 0


_ROUTES_BY_ID: dict[str, Route] = {
    r.id: r for r in (TORCHSCRIPT_ROUTE, ONNX_ROUTE, OPENVINO_ROUTE)
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
            return [TORCHSCRIPT_ROUTE, ONNX_ROUTE, OPENVINO_ROUTE]
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
