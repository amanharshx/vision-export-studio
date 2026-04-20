"""Format grid — scrollable 3-column grid of FormatCard widgets."""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QGridLayout,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.formats import ALL_FORMATS
from yolo_export_studio.core.preflight import CheckResult
from yolo_export_studio.core.routes import Route
from yolo_export_studio.ui.format_card import FormatCard

_COLUMNS = 3


class FormatGrid(QWidget):
    """Scrollable grid of FormatCard widgets, one per route."""

    route_selected = Signal(object)  # Route

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._cards: list[FormatCard] = []
        self._setup_ui()

    def _setup_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)

        self._container = QWidget()
        self._grid = QGridLayout(self._container)
        self._grid.setSpacing(8)
        self._container.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred
        )

        scroll.setWidget(self._container)
        outer.addWidget(scroll)

    def set_routes(self, routes_with_checks: list[tuple[Route, list[CheckResult]]]) -> None:
        self.clear()
        for idx, (route, checks) in enumerate(routes_with_checks):
            format_spec = ALL_FORMATS.get(route.target_format)
            if format_spec is None:
                continue
            card = FormatCard(route, format_spec, self._container)

            failing = [c for c in checks if not c.ok]
            if failing:
                card.set_state("unavailable", failing[0].reason)
            else:
                card.set_state("available")

            card.selected.connect(self._on_card_selected)
            self._grid.addWidget(card, idx // _COLUMNS, idx % _COLUMNS)
            self._cards.append(card)

    def clear(self) -> None:
        for card in self._cards:
            self._grid.removeWidget(card)
            card.deleteLater()
        self._cards.clear()

    def _on_card_selected(self, route: Route) -> None:
        for card in self._cards:
            if card._route is route:
                card.set_state("selected")
            elif card._state != "unavailable":
                card.set_state("available")
        self.route_selected.emit(route)
