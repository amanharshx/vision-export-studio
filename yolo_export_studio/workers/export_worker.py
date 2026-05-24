"""
YOLO Export Studio export worker — standalone subprocess.

Usage:
    python -m yolo_export_studio.workers.export_worker /path/to/job.json

stdout  — JSONL events (started, log, progress, artifact, finished)
stderr  — raw diagnostic output from third-party libraries
exit 0  — success
exit 1  — failure
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path


def _emit(event_dict: dict) -> None:
    print(json.dumps(event_dict), flush=True)


def _fail(error: str) -> None:
    _emit({"type": "finished", "ok": False, "error": error})
    sys.exit(1)


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--help":
        print("Usage: python -m yolo_export_studio.workers.export_worker <job.json>")
        sys.exit(0)

    if len(sys.argv) != 2:
        _fail("Expected exactly one argument: path to job JSON file.")

    job_path = Path(sys.argv[1])
    if not job_path.exists():
        _fail(f"Job file not found: {job_path}")

    try:
        from yolo_export_studio.core.jobs import ExportJob
        job = ExportJob.read(job_path)
    except Exception as exc:
        _fail(f"Failed to parse job file: {exc}")
        return

    try:
        import yolo_export_studio.providers  # noqa: F401 — triggers register_provider()
        from yolo_export_studio.core.providers import get_provider
        provider = get_provider(job.provider)
    except KeyError:
        _fail(f"Unknown provider: '{job.provider}'")
        return
    except Exception as exc:
        _fail(f"Failed to load provider '{job.provider}': {exc}")
        return

    try:
        provider.run(job)
    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr, flush=True)
        _fail(f"Export failed: {exc}")


if __name__ == "__main__":
    main()
