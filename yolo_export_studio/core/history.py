"""Recent file history — read/write ~/.yolo-export-studio/history.json."""
from __future__ import annotations

import json
from pathlib import Path

_MAX = 10


def _history_file() -> Path:
    return Path.home() / ".yolo-export-studio" / "history.json"


def load_history() -> list[Path]:
    f = _history_file()
    if not f.exists():
        return []
    try:
        paths = json.loads(f.read_text())
        return [Path(p) for p in paths if Path(p).exists()]
    except Exception:
        return []


def record_path(path: Path) -> None:
    existing = [str(p) for p in load_history() if p != path]
    entries = [str(path)] + existing
    entries = entries[:_MAX]
    d = _history_file().parent
    d.mkdir(exist_ok=True)
    tmp = _history_file().with_suffix(".tmp")
    tmp.write_text(json.dumps(entries))
    tmp.replace(_history_file())
