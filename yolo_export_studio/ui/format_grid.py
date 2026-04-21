"""Format grid — wrapping flow of FormatChip widgets, one per route."""
from __future__ import annotations

from typing import Literal

from PySide6.QtCore import QEvent, QRect, QSize, Qt, Signal
from PySide6.QtGui import QEnterEvent, QMouseEvent
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLayout,
    QLayoutItem,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.formats import ALL_FORMATS, FormatSpec
from yolo_export_studio.core.preflight import CheckResult
from yolo_export_studio.core.routes import Route
from yolo_export_studio.ui.theme import (
    ACCENT,
    BORDER,
    BORDER_UNAVAIL_SEL,
    CARD_BG,
    CARD_UNAVAIL_SEL_BG,
    CAT_COLORS,
    CHIP_HOVER_BG,
    CHIP_SELECTED_BG,
    RED,
    TEXT,
    TEXT_MUTED,
)

_H_GAP = 8
_V_GAP = 8


class FlowLayout(QLayout):
    """Left-to-right wrapping layout with fixed horizontal and vertical gaps."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._items: list[QLayoutItem] = []

    def addItem(self, item: QLayoutItem) -> None:
        self._items.append(item)

    def count(self) -> int:
        return len(self._items)

    def itemAt(self, index: int) -> QLayoutItem | None:
        if 0 <= index < len(self._items):
            return self._items[index]
        return None

    def takeAt(self, index: int) -> QLayoutItem | None:
        if 0 <= index < len(self._items):
            return self._items.pop(index)
        return None

    def hasHeightForWidth(self) -> bool:
        return True

    def heightForWidth(self, width: int) -> int:
        return self._do_layout(QRect(0, 0, width, 0), dry_run=True)

    def setGeometry(self, rect: QRect) -> None:
        super().setGeometry(rect)
        self._do_layout(rect, dry_run=False)

    def sizeHint(self) -> QSize:
        return self.minimumSize()

    def minimumSize(self) -> QSize:
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        margins = self.contentsMargins()
        size += QSize(margins.left() + margins.right(), margins.top() + margins.bottom())
        return size

    def _do_layout(self, rect: QRect, dry_run: bool) -> int:
        margins = self.contentsMargins()
        x = rect.x() + margins.left()
        y = rect.y() + margins.top()
        row_height = 0
        right_limit = rect.right() - margins.right()

        for item in self._items:
            w = item.sizeHint().width()
            h = item.sizeHint().height()

            if x + w > right_limit and row_height > 0:
                x = rect.x() + margins.left()
                y += row_height + _V_GAP
                row_height = 0

            if not dry_run:
                item.setGeometry(QRect(x, y, w, h))

            x += w + _H_GAP
            row_height = max(row_height, h)

        return y + row_height - rect.y() + margins.bottom()


class FormatChip(QWidget):
    """Small pill widget representing one export route."""

    selected = Signal(object)  # Route

    def __init__(
        self,
        route: Route,
        format_spec: FormatSpec,
        platform_mismatch: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("fchip")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self._route = route
        self._state: Literal["available", "unavailable", "unavailable_selected", "selected"] = "available"
        self._unavailable_reason: str = ""
        self._cat_color = CAT_COLORS.get(format_spec.category.lower(), BORDER)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 6, 12, 6)
        layout.setSpacing(6)

        self._name_label = QLabel(format_spec.name)
        self._name_label.setStyleSheet(f"font-size: 13px; color: {TEXT};")
        layout.addWidget(self._name_label)

        if platform_mismatch:
            warn = QLabel("\u26a0")
            warn.setStyleSheet(f"font-size: 11px; color: {RED};")
            warn.setToolTip("This route requires a different platform")
            layout.addWidget(warn)

        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedHeight(36)
        self.setToolTip(route.display_path)
        self._apply_style()

    def _card_style(self, bg: str, border: str) -> str:
        return f"#fchip {{ background: {bg}; border: 2px solid {border}; border-radius: 8px; }}"

    def _apply_style(self) -> None:
        if self._state == "selected":
            self.setStyleSheet(self._card_style(CHIP_SELECTED_BG, ACCENT))
            self._name_label.setStyleSheet(f"font-size: 13px; color: {ACCENT};")
        elif self._state == "unavailable_selected":
            self.setStyleSheet(self._card_style(CARD_UNAVAIL_SEL_BG, BORDER_UNAVAIL_SEL))
            self._name_label.setStyleSheet(f"font-size: 13px; color: {TEXT};")
        elif self._state == "unavailable":
            self.setStyleSheet(self._card_style(CARD_BG, BORDER))
            self._name_label.setStyleSheet(f"font-size: 13px; color: {TEXT_MUTED};")
        else:
            self.setStyleSheet(self._card_style(CARD_BG, self._cat_color))
            self._name_label.setStyleSheet(f"font-size: 13px; color: {TEXT};")

    def set_state(
        self,
        state: Literal["available", "unavailable", "unavailable_selected", "selected"],
        reason: str = "",
    ) -> None:
        self._state = state
        if state in ("unavailable", "unavailable_selected"):
            if reason:
                self._unavailable_reason = reason
            self.setToolTip(self._unavailable_reason)
        else:
            self.setToolTip(self._route.display_path)
        self._apply_style()

    def enterEvent(self, event: QEnterEvent) -> None:
        if self._state in ("available", "unavailable"):
            border = self._cat_color if self._state == "available" else BORDER
            self.setStyleSheet(self._card_style(CHIP_HOVER_BG, border))
        super().enterEvent(event)

    def leaveEvent(self, event: QEvent) -> None:
        if self._state in ("available", "unavailable"):
            self._apply_style()
        super().leaveEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        self.selected.emit(self._route)
        super().mousePressEvent(event)


class FormatGrid(QWidget):
    """Scrollable flow of FormatChip widgets, one per route."""

    route_selected = Signal(object)  # Route

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._cards: list[FormatChip] = []
        self._setup_ui()

    def _setup_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)

        self._container = QWidget()
        self._flow = FlowLayout(self._container)
        self._flow.setContentsMargins(4, 4, 4, 4)
        self._container.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred
        )

        scroll.setWidget(self._container)
        outer.addWidget(scroll)

    def set_routes(self, routes_with_checks: list[tuple[Route, list[CheckResult]]]) -> None:
        self.clear()
        for route, checks in routes_with_checks:
            format_spec = ALL_FORMATS.get(route.target_format)
            if format_spec is None:
                continue
            platform_mismatch = any(c.status == "platform_unsupported" for c in checks)
            chip = FormatChip(route, format_spec, platform_mismatch, self._container)

            failing = [c for c in checks if not c.ok]
            if failing:
                chip.set_state("unavailable", failing[0].reason)
            else:
                chip.set_state("available")

            chip.selected.connect(self._on_card_selected)
            self._flow.addWidget(chip)
            self._cards.append(chip)

    def clear(self) -> None:
        while self._flow.count():
            item = self._flow.takeAt(0)
            if item and item.widget():
                item.widget().deleteLater()
        self._cards.clear()

    def _activate_card(self, card: FormatChip) -> None:
        """Set a chip to its selected variant, preserving unavailable state."""
        target = "unavailable_selected" if card._state in ("unavailable", "unavailable_selected") else "selected"
        card.set_state(target)

    def select_route_by_id(self, route_id: str) -> None:
        """Re-select a chip by route id without emitting route_selected."""
        for card in self._cards:
            if card._route.id == route_id:
                self._activate_card(card)

    def _on_card_selected(self, route: Route) -> None:
        for card in self._cards:
            if card._route is route:
                self._activate_card(card)
            elif card._state == "selected":
                card.set_state("available")
            elif card._state == "unavailable_selected":
                card.set_state("unavailable")
            # plain "unavailable" chips: no change needed
        self.route_selected.emit(route)
