"""ExportJob — the job descriptor passed from GUI to worker via JSON file."""
from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


def _make_job_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    short = uuid.uuid4().hex[:8]
    return f"{ts}-{short}"


@dataclass
class ExportJob:
    """
    Complete descriptor for one export operation.
    Written by the GUI to a temp file; read by the worker subprocess.
    """

    job_id: str
    provider: str
    route: str
    source_path: str
    output_dir: str
    python_executable: str
    options: dict

    @staticmethod
    def create(
        provider: str,
        route: str,
        source_path: Path,
        output_dir: Path,
        python_executable: Path,
        options: dict,
    ) -> "ExportJob":
        return ExportJob(
            job_id=_make_job_id(),
            provider=provider,
            route=route,
            source_path=str(source_path),
            output_dir=str(output_dir),
            python_executable=str(python_executable),
            options=options,
        )

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)

    @staticmethod
    def from_json(text: str) -> "ExportJob":
        data = json.loads(text)
        return ExportJob(**data)

    def write(self, path: Path) -> None:
        path.write_text(self.to_json(), encoding="utf-8")

    @staticmethod
    def read(path: Path) -> "ExportJob":
        return ExportJob.from_json(path.read_text(encoding="utf-8"))
