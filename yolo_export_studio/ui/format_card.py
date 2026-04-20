"""Format card — one selectable tile per export route."""
from __future__ import annotations

from typing import Literal

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import QLabel, QVBoxLayout, QWidget

from yolo_export_studio.core.formats import FormatSpec
from yolo_export_studio.core.routes import Route


class FormatCard(QWidget):
    """Clickable card showing one export route."""

    selected = Signal(object)  # Route

    _BORDER_NORMAL = "border: 1px solid #555; border-radius: 6px; padding: 8px;"
    _BORDER_SELECTED = "border: 2px solid #2980b9; border-radius: 6px; padding: 7px; background: #1a3a5c;"

    def __init__(
        self,
        route: Route,
        format_spec: FormatSpec,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._route = route
        self._state: Literal["available", "unavailable", "selected"] = "available"

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)

        # Name row
        self._name_label = QLabel(format_spec.name)
        self._name_label.setStyleSheet("font-weight: bold; font-size: 13px;")
        layout.addWidget(self._name_label)

        # Category badge
        self._cat_label = QLabel(format_spec.category.upper())
        self._cat_label.setStyleSheet(
            "font-size: 10px; color: #aaa; background: #333; "
            "border-radius: 3px; padding: 1px 4px;"
        )
        layout.addWidget(self._cat_label)

        # Route path
        path_label = QLabel(route.display_path)
        path_label.setStyleSheet(
            "font-family: monospace; background: #222; border-radius: 3px;"
            " padding: 2px 6px; color: #aaa;"
        )
        path_label.setWordWrap(True)
        layout.addWidget(path_label)

        # Flags row
        flags: list[str] = []
        if route.one_way or format_spec.one_way:
            flags.append("one-way")
        if route.lossy:
            flags.append("lossy")
        if format_spec.platform_locked or route.platform_lock:
            flags.append("platform-locked")
        if flags:
            flag_label = QLabel(" · ".join(flags))
            flag_label.setStyleSheet("font-size: 10px; color: #e67e22;")
            layout.addWidget(flag_label)

        self.setStyleSheet(self._BORDER_NORMAL)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedHeight(110)

    def set_state(
        self,
        state: Literal["available", "unavailable", "selected"],
        reason: str = "",
    ) -> None:
        self._state = state
        if state == "unavailable":
            self.setStyleSheet(
                "border: 1px solid #444; border-radius: 6px; padding: 8px;"
            )
            self.setEnabled(False)
            self.setToolTip(reason)
        elif state == "selected":
            self.setEnabled(True)
            self.setStyleSheet(self._BORDER_SELECTED)
            self.setToolTip("")
        else:
            self.setEnabled(True)
            self.setStyleSheet(self._BORDER_NORMAL)
            self.setToolTip("")

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if self._state != "unavailable":
            self.selected.emit(self._route)
        super().mousePressEvent(event)
