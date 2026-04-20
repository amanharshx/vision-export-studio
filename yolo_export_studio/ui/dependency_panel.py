"""Dependency panel — shows preflight check results per route."""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.preflight import CheckResult


class DependencyPanel(QWidget):
    """Displays a list of preflight CheckResult rows."""

    recheck_requested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._setup_ui()

    def _setup_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(4)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        self._rows_widget = QWidget()
        self._rows_layout = QVBoxLayout(self._rows_widget)
        self._rows_layout.setContentsMargins(0, 0, 0, 0)
        self._rows_layout.setSpacing(4)
        self._rows_layout.addStretch()

        scroll.setWidget(self._rows_widget)
        outer.addWidget(scroll, stretch=1)

        recheck_btn = QPushButton("Recheck Dependencies")
        recheck_btn.clicked.connect(self.recheck_requested)
        outer.addWidget(recheck_btn)

    def set_checks(self, checks: list[CheckResult]) -> None:
        self.clear()
        # Insert rows before the stretch at end
        stretch_item = self._rows_layout.takeAt(self._rows_layout.count() - 1)
        for check in checks:
            self._rows_layout.addWidget(_CheckRow(check))
        self._rows_layout.addStretch()

    def set_loading(self) -> None:
        self.clear()
        stretch_item = self._rows_layout.takeAt(self._rows_layout.count() - 1)
        label = QLabel("Checking dependencies…")
        label.setStyleSheet("color: #888; font-style: italic;")
        self._rows_layout.addWidget(label)
        self._rows_layout.addStretch()

    def clear(self) -> None:
        while self._rows_layout.count() > 1:
            item = self._rows_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()


class _CheckRow(QWidget):
    """One row in the dependency panel."""

    _ICON = {"ready": ("[OK]", "#27ae60"), "warning": ("[!]", "#f39c12")}

    def __init__(self, check: CheckResult, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        if check.ok:
            icon_text, icon_color = "[OK]", "#27ae60"
        elif check.status == "warning":
            icon_text, icon_color = "[!]", "#f39c12"
        else:
            icon_text, icon_color = "[x]", "#c0392b"

        icon_label = QLabel(icon_text)
        icon_label.setStyleSheet(f"color: {icon_color}; font-weight: bold; min-width: 32px;")
        layout.addWidget(icon_label)

        text = check.item
        if check.reason:
            text = f"{check.item} — {check.reason}"
        item_label = QLabel(text)
        item_label.setWordWrap(True)
        layout.addWidget(item_label, stretch=1)

        if check.install_hint:
            copy_btn = QPushButton("Copy hint")
            copy_btn.setFixedWidth(80)
            hint = check.install_hint
            copy_btn.clicked.connect(lambda: QApplication.clipboard().setText(hint))
            layout.addWidget(copy_btn)
