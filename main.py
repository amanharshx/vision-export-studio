"""YOLO Export Studio — ML model export studio."""
from __future__ import annotations

import sys


def main() -> None:
    from PySide6.QtWidgets import QApplication
    from yolo_export_studio.ui.main_window import MainWindow

    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
