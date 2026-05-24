"""JSONL event models — shared between GUI (reader) and worker (writer)."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Literal


LogLevel = Literal["debug", "info", "warning", "error"]

EventType = Literal["started", "log", "progress", "artifact", "finished"]


@dataclass
class StartedEvent:
    type: Literal["started"] = "started"
    job_id: str = ""
    route: str = ""

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class LogEvent:
    type: Literal["log"] = "log"
    level: LogLevel = "info"
    message: str = ""

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class ProgressEvent:
    type: Literal["progress"] = "progress"
    value: int = 0
    message: str = ""

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class ArtifactEvent:
    type: Literal["artifact"] = "artifact"
    path: str = ""
    size_bytes: int = 0
    is_intermediate: bool = False
    format_id: str = ""

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class FinishedEvent:
    type: Literal["finished"] = "finished"
    ok: bool = True
    error: str = ""

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self))


# ---------------------------------------------------------------------------
# Parser — used by GUI when reading stdout lines
# ---------------------------------------------------------------------------

WorkerEvent = StartedEvent | LogEvent | ProgressEvent | ArtifactEvent | FinishedEvent


def parse_event(line: str) -> WorkerEvent | None:
    """
    Parse one JSONL line from worker stdout.
    Returns None if the line is malformed or has an unknown type.
    Never raises — malformed lines must not crash the GUI.
    """
    try:
        data = json.loads(line.strip())
    except json.JSONDecodeError:
        return None

    t = data.get("type")
    try:
        match t:
            case "started":
                return StartedEvent(
                    job_id=data.get("job_id", ""),
                    route=data.get("route", ""),
                )
            case "log":
                return LogEvent(
                    level=data.get("level", "info"),
                    message=data.get("message", ""),
                )
            case "progress":
                return ProgressEvent(
                    value=int(data.get("value", 0)),
                    message=data.get("message", ""),
                )
            case "artifact":
                return ArtifactEvent(
                    path=data.get("path", ""),
                    size_bytes=int(data.get("size_bytes", 0)),
                    is_intermediate=bool(data.get("is_intermediate", False)),
                    format_id=data.get("format_id", ""),
                )
            case "finished":
                return FinishedEvent(
                    ok=bool(data.get("ok", False)),
                    error=data.get("error", ""),
                )
            case _:
                return None
    except (KeyError, TypeError, ValueError):
        return None
