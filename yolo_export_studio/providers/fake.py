"""Fake provider — for smoke testing and UI development without ML deps."""
from __future__ import annotations

import sys
import time
from pathlib import Path

from yolo_export_studio.core.jobs import ExportJob
from yolo_export_studio.core.logs import (
    ArtifactEvent,
    FinishedEvent,
    LogEvent,
    ProgressEvent,
    StartedEvent,
)
from yolo_export_studio.core.preflight import CheckResult
from yolo_export_studio.core.providers import ExportProvider, SourceMatch, register_provider
from yolo_export_studio.core.routes import Route


FAKE_ROUTES: list[Route] = [
    Route(
        id="fake.pt.torchscript",
        provider_id="fake",
        source_format="pt",
        target_format="torchscript",
        display_path="model.pt → model.torchscript",
        supports_half=True,
        supports_dynamic=True,
        notes="Fake route for testing.",
    ),
    Route(
        id="fake.pt.onnx",
        provider_id="fake",
        source_format="pt",
        target_format="onnx",
        display_path="model.pt → model.onnx",
        pip_deps=(("onnx", "pip install onnx>=1.12"),),
        supports_half=True,
        supports_dynamic=True,
        notes="Fake route for testing.",
    ),
    Route(
        id="fake.pt.openvino",
        provider_id="fake",
        source_format="pt",
        target_format="openvino",
        display_path="model.pt → model_openvino_model/",
        pip_deps=(("openvino", "pip install openvino>=2024.0"),),
        supports_half=True,
        supports_int8=True,
        supports_dynamic=True,
        notes="Fake route for testing.",
    ),
]


class FakeProvider(ExportProvider):
    """
    Fake export provider. Accepts any .pt file. All preflight passes.
    Worker side emits realistic JSONL events with simulated delay.
    """

    @property
    def id(self) -> str:
        return "fake"

    @property
    def name(self) -> str:
        return "Fake Provider (testing)"

    def detect_source(self, path: Path) -> SourceMatch | None:
        if path.suffix.lower() == ".pt" and path.exists():
            return SourceMatch(
                provider_id="fake",
                format_id="pt",
                path=path,
                display_name=f"{path.name} (Fake/testing)",
            )
        return None

    def routes_for(self, source: SourceMatch) -> list[Route]:
        if source.format_id == "pt":
            return list(FAKE_ROUTES)
        return []

    def preflight(self, route: Route, options: dict) -> list[CheckResult]:
        return [CheckResult(item="fake", status="ready", reason="Fake provider — no real checks.")]

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

        emit(StartedEvent(job_id=job.job_id, route=job.route))
        emit(LogEvent(level="info", message=f"[fake] Loading model: {job.source_path}"))
        time.sleep(0.3)

        emit(ProgressEvent(value=25, message="Preparing export"))
        emit(LogEvent(level="info", message=f"[fake] Exporting to {job.route}"))
        time.sleep(0.3)

        emit(ProgressEvent(value=75, message="Finalising"))
        time.sleep(0.2)

        source = Path(job.source_path)
        target_map = {
            "fake.pt.torchscript": source.stem + ".torchscript",
            "fake.pt.onnx": source.stem + ".onnx",
            "fake.pt.openvino": source.stem + "_openvino_model",
        }
        artifact_name = target_map.get(job.route, "output")
        artifact_path = str(Path(job.output_dir) / artifact_name)

        emit(ArtifactEvent(path=artifact_path, size_bytes=0, format_id=job.route.split(".")[-1]))
        emit(ProgressEvent(value=100, message="Done"))
        emit(FinishedEvent(ok=True))


register_provider(FakeProvider())
