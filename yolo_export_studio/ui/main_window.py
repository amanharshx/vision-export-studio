"""Main window — orchestrates all panels and the export workflow."""
from __future__ import annotations

import platform
import subprocess
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.jobs import ExportJob
from yolo_export_studio.core.logs import ArtifactEvent, FinishedEvent, WorkerEvent
from yolo_export_studio.core.preflight import CheckResult
from yolo_export_studio.core.providers import ExportProvider
from yolo_export_studio.core.routes import Route
from yolo_export_studio.ui.dependency_panel import DependencyPanel
from yolo_export_studio.ui.drop_zone import DropZone
from yolo_export_studio.ui.format_grid import FormatGrid
from yolo_export_studio.ui.log_viewer import LogViewer
from yolo_export_studio.ui.options_panel import OptionsPanel
from yolo_export_studio.ui.process_controller import ProcessController


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("YOLO Export Studio")
        self.resize(1200, 780)

        self._source_match = None
        self._provider: ExportProvider | None = None
        self._source_path: Path | None = None
        self._selected_route: Route | None = None
        self._artifact_path: str | None = None
        self._current_checks: list[CheckResult] = []

        self._setup_ui()
        self._wire_signals()
        self.statusBar().showMessage(f"{platform.system()} {platform.machine()}")

    def _setup_ui(self) -> None:
        # --- Header bar ---
        header = QWidget()
        header.setFixedHeight(44)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(12, 0, 12, 0)

        title = QLabel("YOLO Export Studio")
        title.setStyleSheet("font-size: 16px; font-weight: bold;")
        header_layout.addWidget(title)
        header_layout.addStretch()

        badge = QLabel(platform.machine())
        badge.setStyleSheet(
            "background: #2c3e50; color: #ecf0f1; border-radius: 4px; padding: 2px 8px; font-size: 11px;"
        )
        header_layout.addWidget(badge)

        # --- Splitter ---
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # Left panel
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(8, 8, 4, 8)
        left_layout.setSpacing(8)

        self._drop_zone = DropZone()
        self._drop_zone.setFixedHeight(120)
        left_layout.addWidget(self._drop_zone)

        sep1 = QFrame()
        sep1.setFrameShape(QFrame.Shape.HLine)
        left_layout.addWidget(sep1)

        left_layout.addWidget(QLabel("Target Format"))
        self._format_grid = FormatGrid()
        left_layout.addWidget(self._format_grid, stretch=1)

        splitter.addWidget(left)

        # Right panel
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(4, 8, 8, 8)
        right_layout.setSpacing(8)

        right_layout.addWidget(QLabel("Options"))
        self._options_panel = OptionsPanel()
        self._options_panel.setFixedHeight(240)
        right_layout.addWidget(self._options_panel)

        sep2 = QFrame()
        sep2.setFrameShape(QFrame.Shape.HLine)
        right_layout.addWidget(sep2)

        right_layout.addWidget(QLabel("Dependencies"))
        self._dep_panel = DependencyPanel()
        self._dep_panel.setFixedHeight(160)
        right_layout.addWidget(self._dep_panel)

        sep3 = QFrame()
        sep3.setFrameShape(QFrame.Shape.HLine)
        right_layout.addWidget(sep3)

        # Action buttons
        btn_row = QHBoxLayout()
        self._convert_btn = QPushButton("Convert")
        self._convert_btn.setEnabled(False)
        self._convert_btn.setFixedHeight(32)
        btn_row.addWidget(self._convert_btn)

        self._cancel_btn = QPushButton("Cancel")
        self._cancel_btn.setEnabled(False)
        self._cancel_btn.setFixedHeight(32)
        btn_row.addWidget(self._cancel_btn)

        self._open_btn = QPushButton("Open Output Folder")
        self._open_btn.setEnabled(False)
        self._open_btn.setFixedHeight(32)
        btn_row.addWidget(self._open_btn)
        right_layout.addLayout(btn_row)

        self._progress_bar = QProgressBar()
        self._progress_bar.setRange(0, 100)
        self._progress_bar.setValue(0)
        right_layout.addWidget(self._progress_bar)

        sep4 = QFrame()
        sep4.setFrameShape(QFrame.Shape.HLine)
        right_layout.addWidget(sep4)

        right_layout.addWidget(QLabel("Log"))
        self._log_viewer = LogViewer()
        right_layout.addWidget(self._log_viewer, stretch=1)

        splitter.addWidget(right)
        splitter.setSizes([480, 720])

        # --- Central widget ---
        central = QWidget()
        main_layout = QVBoxLayout(central)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        main_layout.addWidget(header)

        sep_top = QFrame()
        sep_top.setFrameShape(QFrame.Shape.HLine)
        main_layout.addWidget(sep_top)

        main_layout.addWidget(splitter, stretch=1)
        self.setCentralWidget(central)

        # Process controller
        self._proc = ProcessController(self)

    def _wire_signals(self) -> None:
        self._drop_zone.source_changed.connect(self._on_source_changed)
        self._format_grid.route_selected.connect(self._on_route_selected)
        self._options_panel.options_changed.connect(self._on_options_changed)
        self._dep_panel.recheck_requested.connect(self._on_recheck)
        self._convert_btn.clicked.connect(self._on_convert)
        self._cancel_btn.clicked.connect(self._proc.cancel)
        self._open_btn.clicked.connect(self._on_open_output)

        self._proc.event_received.connect(self._on_event)
        self._proc.stderr_received.connect(self._log_viewer.append_stderr)
        self._proc.progress_updated.connect(self._progress_bar.setValue)
        self._proc.finished.connect(self._on_proc_finished)
        self._proc.crashed.connect(self._on_proc_crashed)

    # ------------------------------------------------------------------
    # Signal handlers
    # ------------------------------------------------------------------

    def _on_source_changed(self, source_match, provider: ExportProvider) -> None:
        self._source_match = source_match
        self._provider = provider
        self._source_path = source_match.path
        self._selected_route = None
        self._current_checks = []

        routes = provider.routes_for(source_match)
        routes_with_checks = [
            (route, provider.preflight(route, {})) for route in routes
        ]
        self._format_grid.set_routes(routes_with_checks)
        self._options_panel.set_route(None)
        self._dep_panel.clear()
        self._log_viewer.clear()
        self._progress_bar.setValue(0)
        self._convert_btn.setEnabled(False)
        self._open_btn.setEnabled(False)

    def _on_route_selected(self, route: Route) -> None:
        self._selected_route = route
        self._options_panel.set_route(route)
        checks = self._provider.preflight(route, self._options_panel.get_options())
        self._current_checks = checks
        self._dep_panel.set_checks(checks)
        self._update_convert_button()

    def _on_options_changed(self, options: dict) -> None:
        if self._selected_route is None or self._provider is None:
            return
        checks = self._provider.preflight(self._selected_route, options)
        self._current_checks = checks
        self._dep_panel.set_checks(checks)
        self._update_convert_button()

    def _on_recheck(self) -> None:
        if self._selected_route is None or self._provider is None:
            return
        options = self._options_panel.get_options()
        checks = self._provider.preflight(self._selected_route, options)
        self._current_checks = checks
        self._dep_panel.set_checks(checks)

        # Also refresh the grid
        routes = self._provider.routes_for(self._source_match)
        routes_with_checks = [
            (route, self._provider.preflight(route, {})) for route in routes
        ]
        self._format_grid.set_routes(routes_with_checks)
        # Re-select the current route card
        if self._selected_route is not None:
            self._format_grid.select_route_by_id(self._selected_route.id)

        self._update_convert_button()

    def _on_convert(self) -> None:
        if self._source_path is None or self._selected_route is None or self._provider is None:
            return

        options = self._options_panel.get_options()
        output_dir = self._source_path.parent / "yolo-export-studio-exports"
        output_dir.mkdir(exist_ok=True)

        job: ExportJob = self._provider.build_job(
            self._source_path, self._selected_route, options, output_dir
        )

        self._log_viewer.clear()
        self._progress_bar.setValue(0)
        self._convert_btn.setEnabled(False)
        self._cancel_btn.setEnabled(True)
        self._open_btn.setEnabled(False)
        self._artifact_path = None
        self.statusBar().showMessage("Converting…")

        self._proc.start(job)

    def _on_event(self, event: WorkerEvent) -> None:
        self._log_viewer.append_event(event)
        if isinstance(event, ArtifactEvent):
            self._artifact_path = event.path
            self._open_btn.setEnabled(True)
        if isinstance(event, FinishedEvent):
            ok_str = "ok" if event.ok else f"failed — {event.error}"
            self.statusBar().showMessage(f"Conversion {ok_str}")
            self._convert_btn.setEnabled(True)
            self._cancel_btn.setEnabled(False)

    def _on_proc_finished(self, ok: bool, error_msg: str) -> None:
        self._convert_btn.setEnabled(True)
        self._cancel_btn.setEnabled(False)
        if not ok:
            self.statusBar().showMessage(f"Failed: {error_msg}")

    def _on_proc_crashed(self) -> None:
        self._convert_btn.setEnabled(True)
        self._cancel_btn.setEnabled(False)
        self.statusBar().showMessage("Worker crashed")
        QMessageBox.warning(
            self,
            "Worker Crashed",
            "The worker process crashed. Check the log for details.",
        )

    def _on_open_output(self) -> None:
        if self._artifact_path is None:
            return
        path = Path(self._artifact_path)
        folder = path.parent if path.is_file() else path
        if platform.system() == "Darwin":
            subprocess.Popen(["open", str(folder)])
        elif platform.system() == "Windows":
            subprocess.Popen(["explorer", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _update_convert_button(self) -> None:
        all_ok = (
            self._source_match is not None
            and self._selected_route is not None
            and all(c.ok for c in self._current_checks)
        )
        self._convert_btn.setEnabled(all_ok and not self._proc.is_running)
