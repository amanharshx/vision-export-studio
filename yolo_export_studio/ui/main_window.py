"""Main window stub — Phase 1 will implement this."""
from __future__ import annotations

from PySide6.QtWidgets import QMainWindow


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("YOLO Export Studio")
        self.resize(1100, 700)
