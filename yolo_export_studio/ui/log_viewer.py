"""Log viewer — color-coded JSONL event display."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QTextCharFormat, QTextCursor
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.logs import (
    ArtifactEvent,
    FinishedEvent,
    LogEvent,
    ProgressEvent,
    StartedEvent,
    WorkerEvent,
)


def _fmt(color: str | None = None, bold: bool = False, italic: bool = False) -> QTextCharFormat:
    f = QTextCharFormat()
    if color:
        f.setForeground(QColor(color))
    if bold:
        f.setFontWeight(700)
    if italic:
        f.setFontItalic(True)
    return f


_FMT_DEFAULT = _fmt()
_FMT_WARNING = _fmt("#e67e22")
_FMT_ERROR = _fmt("#c0392b")
_FMT_PROGRESS = _fmt("#5dade2")
_FMT_ARTIFACT = _fmt("#27ae60")
_FMT_BOLD = _fmt(bold=True)
_FMT_STDERR = _fmt("#888888", italic=True)


class LogViewer(QWidget):
    """Read-only colored log output widget."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._setup_ui()

    def _setup_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(4)

        btn_bar = QHBoxLayout()
        btn_bar.addStretch()
        copy_btn = QPushButton("Copy Logs")
        copy_btn.setFixedWidth(90)
        copy_btn.clicked.connect(self._copy_logs)
        btn_bar.addWidget(copy_btn)
        outer.addLayout(btn_bar)

        self._edit = QPlainTextEdit()
        self._edit.setReadOnly(True)
        self._edit.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        font = self._edit.font()
        font.setFamily("Menlo, Consolas, monospace")
        font.setPointSize(11)
        self._edit.setFont(font)
        outer.addWidget(self._edit)

    def append_event(self, event: WorkerEvent) -> None:
        if isinstance(event, StartedEvent):
            self._append(f"[started] route={event.route}  job={event.job_id}", _FMT_BOLD)
        elif isinstance(event, LogEvent):
            fmt = {
                "info": _FMT_DEFAULT,
                "warning": _FMT_WARNING,
                "error": _FMT_ERROR,
            }.get(event.level, _FMT_DEFAULT)
            self._append(event.message, fmt)
        elif isinstance(event, ProgressEvent):
            msg = f"[progress] {event.value}%"
            if event.message:
                msg += f"  {event.message}"
            self._append(msg, _FMT_PROGRESS)
        elif isinstance(event, ArtifactEvent):
            size_kb = event.size_bytes // 1024
            self._append(f"[artifact] {event.path}  ({size_kb} KB)", _FMT_ARTIFACT)
        elif isinstance(event, FinishedEvent):
            if event.ok:
                self._append("[finished] ok", _FMT_BOLD)
            else:
                self._append(f"[finished] FAILED — {event.error}", _fmt("#c0392b", bold=True))

    def append_stderr(self, text: str) -> None:
        for line in text.splitlines():
            if line.strip():
                self._append(line, _FMT_STDERR)

    def clear(self) -> None:
        self._edit.clear()

    def _append(self, text: str, fmt: QTextCharFormat) -> None:
        cursor = self._edit.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.insertText(text + "\n", fmt)
        self._edit.setTextCursor(cursor)
        self._edit.ensureCursorVisible()

    def _copy_logs(self) -> None:
        QApplication.clipboard().setText(self._edit.toPlainText())
