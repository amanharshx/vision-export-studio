"""Drop zone — drag-and-drop or browse for a .pt model file."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QDragEnterEvent, QDropEvent
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


class DropZone(QWidget):
    """Accepts a .pt file and emits source_changed(source_match, provider)."""

    source_changed = Signal(object, object)  # (SourceMatch, ExportProvider)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setAcceptDrops(True)
        self._setup_ui()

    def _setup_ui(self) -> None:
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)

        # Idle state container
        self._idle_widget = QWidget()
        idle_layout = QVBoxLayout(self._idle_widget)
        idle_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        prompt = QLabel("Drop a .pt model file here\nor")
        prompt.setAlignment(Qt.AlignmentFlag.AlignCenter)
        idle_layout.addWidget(prompt)

        browse_btn = QPushButton("Browse…")
        browse_btn.setFixedWidth(120)
        browse_btn.clicked.connect(self._browse)
        idle_layout.addWidget(browse_btn, alignment=Qt.AlignmentFlag.AlignCenter)

        self._idle_widget.setStyleSheet(
            "border: 2px dashed #888; border-radius: 6px; padding: 24px;"
        )

        # Loaded state container
        self._loaded_widget = QWidget()
        loaded_layout = QHBoxLayout(self._loaded_widget)

        self._file_label = QLabel()
        self._file_label.setWordWrap(True)
        loaded_layout.addWidget(self._file_label, stretch=1)

        change_btn = QPushButton("Change")
        change_btn.setFixedWidth(80)
        change_btn.clicked.connect(self._browse)
        loaded_layout.addWidget(change_btn)

        self._loaded_widget.hide()

        # Error label (shown below both states)
        self._error_label = QLabel()
        self._error_label.setStyleSheet("color: #c0392b;")
        self._error_label.hide()

        self._layout.addWidget(self._idle_widget)
        self._layout.addWidget(self._loaded_widget)
        self._layout.addWidget(self._error_label)

    def _browse(self) -> None:
        path_str, _ = QFileDialog.getOpenFileName(
            self,
            "Select PyTorch Model",
            "",
            "PyTorch Model (*.pt)",
        )
        if path_str:
            self._accept_path(Path(path_str))

    def _accept_path(self, path: Path) -> None:
        # Import providers here so register_provider() fires before detect_source
        import yolo_export_studio.providers  # noqa: F401
        from yolo_export_studio.core.providers import detect_source

        result = detect_source(path)
        if result is None:
            self._show_error(f"No provider recognised '{path.name}'. Is it a valid .pt file?")
            return

        source_match, provider = result
        self._show_loaded(path, provider.name)
        self._error_label.hide()
        self.source_changed.emit(source_match, provider)

    def _show_loaded(self, path: Path, provider_name: str) -> None:
        self._file_label.setText(f"{path.name}\n{provider_name}")
        self._idle_widget.hide()
        self._loaded_widget.show()

    def _show_error(self, message: str) -> None:
        self._error_label.setText(message)
        self._error_label.show()

    # ------------------------------------------------------------------
    # Drag-and-drop
    # ------------------------------------------------------------------

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            urls = event.mimeData().urls()
            if urls and urls[0].toLocalFile().lower().endswith(".pt"):
                event.acceptProposedAction()
                return
        event.ignore()

    def dropEvent(self, event: QDropEvent) -> None:
        urls = event.mimeData().urls()
        if urls:
            self._accept_path(Path(urls[0].toLocalFile()))
