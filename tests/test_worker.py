"""Smoke tests for the export worker subprocess interface.

All tests invoke the worker via subprocess.run — no ML libraries, no Qt imports.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _run_worker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "yolo_export_studio.workers.export_worker", *args],
        capture_output=True,
        text=True,
    )


def _parse_events(stdout: str) -> list[dict]:
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


def _finished_event(events: list[dict]) -> dict | None:
    for e in events:
        if e.get("type") == "finished":
            return e
    return None


def test_help():
    result = _run_worker("--help")
    assert result.returncode == 0
    assert result.stdout.strip() != ""


def test_no_args():
    result = _run_worker()
    assert result.returncode != 0
    events = _parse_events(result.stdout)
    finished = _finished_event(events)
    assert finished is not None
    assert finished["ok"] is False


def test_missing_job_file(tmp_path):
    nonexistent = str(tmp_path / "does_not_exist.json")
    result = _run_worker(nonexistent)
    assert result.returncode != 0
    events = _parse_events(result.stdout)
    finished = _finished_event(events)
    assert finished is not None
    assert finished["ok"] is False


def test_invalid_json(tmp_path):
    bad_json = tmp_path / "bad.json"
    bad_json.write_text("{bad json}", encoding="utf-8")
    result = _run_worker(str(bad_json))
    assert result.returncode != 0
    events = _parse_events(result.stdout)
    finished = _finished_event(events)
    assert finished is not None
    assert finished["ok"] is False


def test_missing_required_field(tmp_path):
    job_file = tmp_path / "job.json"
    # Missing "provider" field
    job_file.write_text(
        json.dumps({
            "job_id": "test-001",
            "route": "fake.pt.onnx",
            "source_path": str(tmp_path / "model.pt"),
            "output_dir": str(tmp_path / "exports"),
            "python_executable": sys.executable,
            "options": {},
        }),
        encoding="utf-8",
    )
    result = _run_worker(str(job_file))
    assert result.returncode != 0
    events = _parse_events(result.stdout)
    finished = _finished_event(events)
    assert finished is not None
    assert finished["ok"] is False


def test_source_not_found(tmp_path):
    job_file = tmp_path / "job.json"
    job_file.write_text(
        json.dumps({
            "job_id": "test-002",
            "provider": "fake",
            "route": "fake.pt.onnx",
            "source_path": str(tmp_path / "missing_model.pt"),
            "output_dir": str(tmp_path / "exports"),
            "python_executable": sys.executable,
            "options": {},
        }),
        encoding="utf-8",
    )
    result = _run_worker(str(job_file))
    assert result.returncode != 0
    events = _parse_events(result.stdout)
    finished = _finished_event(events)
    assert finished is not None
    assert finished["ok"] is False


def test_fake_provider_success(tmp_path):
    pt = tmp_path / "model.pt"
    pt.write_bytes(b"fake")
    job_file = tmp_path / "job.json"
    job_file.write_text(
        json.dumps({
            "job_id": "test-003",
            "provider": "fake",
            "route": "fake.pt.onnx",
            "source_path": str(pt),
            "output_dir": str(tmp_path / "exports"),
            "python_executable": sys.executable,
            "options": {},
        }),
        encoding="utf-8",
    )
    result = _run_worker(str(job_file))
    assert result.returncode == 0
    events = _parse_events(result.stdout)
    types = [e.get("type") for e in events]
    assert "started" in types
    finished = _finished_event(events)
    assert finished is not None
    assert finished["ok"] is True


def test_fake_provider_event_order(tmp_path):
    pt = tmp_path / "model.pt"
    pt.write_bytes(b"fake")
    job_file = tmp_path / "job.json"
    job_file.write_text(
        json.dumps({
            "job_id": "test-004",
            "provider": "fake",
            "route": "fake.pt.onnx",
            "source_path": str(pt),
            "output_dir": str(tmp_path / "exports"),
            "python_executable": sys.executable,
            "options": {},
        }),
        encoding="utf-8",
    )
    result = _run_worker(str(job_file))
    assert result.returncode == 0
    events = _parse_events(result.stdout)
    assert len(events) >= 2
    assert events[0].get("type") == "started"
    assert events[-1].get("type") == "finished"
