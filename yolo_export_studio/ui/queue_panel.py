"""Queue panel — shows pending/active/done conversion jobs."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.routes import Route


@dataclass
class QueueEntry:
    source_path: Path
    route: Route
    options: dict


class QueuePanel(QWidget):
    run_requested = Signal(list)  # emits list[QueueEntry]

    def __init__(self, parent=None):
        super().__init__(parent)
        self._entries: list[QueueEntry] = []
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(QLabel("Conversion Queue"))
        self._list = QListWidget()
        layout.addWidget(self._list)
        btn_row = QHBoxLayout()
        self._run_btn = QPushButton("Run Queue")
        self._clear_btn = QPushButton("Clear")
        btn_row.addWidget(self._run_btn)
        btn_row.addWidget(self._clear_btn)
        layout.addLayout(btn_row)
        self._run_btn.clicked.connect(self._on_run)
        self._clear_btn.clicked.connect(self.clear)
        self.setVisible(False)

    def add_entry(self, entry: QueueEntry) -> None:
        self._entries.append(entry)
        label = f"{entry.source_path.name} -> {entry.route.target_format.upper()}"
        item = QListWidgetItem(f"[pending] {label}")
        self._list.addItem(item)
        self.setVisible(True)

    def mark_active(self, idx: int) -> None:
        if 0 <= idx < self._list.count():
            text = self._list.item(idx).text()
            self._list.item(idx).setText(text.replace("[pending]", "[running]", 1))

    def mark_done(self, idx: int, ok: bool) -> None:
        if 0 <= idx < self._list.count():
            text = self._list.item(idx).text()
            icon = "[done]" if ok else "[failed]"
            self._list.item(idx).setText(
                text.replace("[running]", icon, 1).replace("[pending]", icon, 1)
            )

    def clear(self) -> None:
        self._entries.clear()
        self._list.clear()
        self.setVisible(False)

    @property
    def entries(self) -> list[QueueEntry]:
        return list(self._entries)

    def _on_run(self) -> None:
        self.run_requested.emit(list(self._entries))
