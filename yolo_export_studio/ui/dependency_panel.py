"""Dependency panel — shows preflight check results per route."""
from __future__ import annotations

import shlex

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


def _is_pip_install(hint: str) -> bool:
    try:
        parts = shlex.split(hint)
    except ValueError:
        return False
    if len(parts) != 3:
        return False
    if parts[0] != "pip" or parts[1] != "install":
        return False
    spec = parts[2]
    if not spec or spec.startswith(("-", ".", "/")):
        return False
    if spec.startswith(("http://", "https://", "git+", "ftp://", "~")):
        return False
    # Block Windows absolute paths (C:\, D:\, etc.)
    if len(spec) >= 2 and spec[1] == ":":
        return False
    return True


class DependencyPanel(QWidget):
    """Displays a list of preflight CheckResult rows."""

    recheck_requested = Signal()
    install_requested = Signal(str, str)  # (install_hint, item)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._rows: list[_CheckRow] = []
        self._setup_ui()

    def _setup_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(4)

        self._platform_banner = QLabel()
        self._platform_banner.setWordWrap(True)
        self._platform_banner.setStyleSheet(
            "background: #fff3e0; color: #b45309; border: 1px solid #e67e22; "
            "border-radius: 4px; padding: 6px 8px; font-size: 12px;"
        )
        self._platform_banner.setVisible(False)
        outer.addWidget(self._platform_banner)

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
        platform_check = next(
            (c for c in checks if c.status == "platform_unsupported"), None
        )
        if platform_check:
            self._platform_banner.setText(f"\u26a0  {platform_check.reason}")
            self._platform_banner.setVisible(True)
        else:
            self._platform_banner.setVisible(False)
        for check in checks:
            row = _CheckRow(check)
            row.install_clicked.connect(
                lambda hint, item: self.install_requested.emit(hint, item)
            )
            self._rows_layout.addWidget(row)
            self._rows.append(row)
        self._rows_layout.addStretch()

    def clear(self) -> None:
        self._platform_banner.setVisible(False)
        while self._rows_layout.count() > 0:
            item = self._rows_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self._rows.clear()

    def set_installing(self, installing: bool) -> None:
        for row in self._rows:
            row.set_installing(installing)


class _CheckRow(QWidget):
    """One row in the dependency panel."""

    install_clicked = Signal(str, str)  # (hint, item)

    def __init__(self, check: CheckResult, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        if check.ok:
            icon_text, icon_color = "●", "#27ae60"
        elif check.status == "warning":
            icon_text, icon_color = "●", "#f39c12"
        else:
            icon_text, icon_color = "●", "#c0392b"

        icon_label = QLabel(icon_text)
        icon_label.setStyleSheet(f"color: {icon_color}; font-size: 14px; min-width: 16px;")
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

            # NOTE: version_incompatible — install button intentionally excluded; upgrading
            # an existing package is higher-risk and requires different UX (confirm version).
            if check.status == "missing_package" and _is_pip_install(check.install_hint):
                self._install_btn: QPushButton | None = QPushButton("Install")
                self._install_btn.setFixedWidth(60)
                _hint = check.install_hint
                _item = check.item
                self._install_btn.clicked.connect(lambda: self.install_clicked.emit(_hint, _item))
                layout.addWidget(self._install_btn)
            else:
                self._install_btn = None
        else:
            self._install_btn = None

    def set_installing(self, installing: bool) -> None:
        if self._install_btn is not None:
            self._install_btn.setEnabled(not installing)
