"""Main window — orchestrates all panels and the export workflow."""
from __future__ import annotations

import platform
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QProcess, Qt
from PySide6.QtGui import QCloseEvent, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.jobs import ExportJob
from yolo_export_studio.core.logs import ArtifactEvent, FinishedEvent, StartedEvent, WorkerEvent
from yolo_export_studio.core.preflight import CheckResult
from yolo_export_studio.core.providers import ExportProvider, get_provider
from yolo_export_studio.core.routes import Route
from yolo_export_studio.ui.dependency_panel import DependencyPanel, _is_pip_install
from yolo_export_studio.ui.drop_zone import DropZone
from yolo_export_studio.ui.theme import ACCENT, RADIUS, RED, SECTION_HEADER, TEXT_DIM
from yolo_export_studio.ui.format_grid import FormatGrid
from yolo_export_studio.ui.log_viewer import LogViewer
from yolo_export_studio.ui.options_panel import OptionsPanel
from yolo_export_studio.ui.process_controller import ProcessController
from yolo_export_studio.ui.queue_panel import QueueEntry, QueuePanel


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
        self._queue_job_idx: int = 0
        self._install_proc: QProcess | None = None

        self._setup_ui()
        self._wire_signals()
        self._setup_shortcuts()
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
            "background: #e8e8e8; color: #1a1a1a; border-radius: 4px; padding: 2px 8px; font-size: 11px;"
        )
        header_layout.addWidget(badge)

        header_layout.addWidget(QLabel("Python:"))
        self._interp_edit = QLineEdit(sys.executable)
        self._interp_edit.setFixedWidth(260)
        header_layout.addWidget(self._interp_edit)

        browse_interp_btn = QPushButton("Browse…")
        browse_interp_btn.clicked.connect(self._browse_interpreter)
        header_layout.addWidget(browse_interp_btn)

        # --- Splitter ---
        self._splitter = QSplitter(Qt.Orientation.Horizontal)

        # Left panel — content centered with max width
        left = QWidget()
        self._left_layout = QVBoxLayout(left)
        self._left_layout.setContentsMargins(0, 0, 0, 0)

        self._left_content = QWidget()
        self._left_content.setMaximumWidth(750)
        content_layout = QVBoxLayout(self._left_content)
        content_layout.setContentsMargins(24, 40, 24, 24)
        content_layout.setSpacing(20)

        self._drop_zone = DropZone()
        content_layout.addWidget(self._drop_zone)

        self._tf_label = QLabel("Target Format")
        self._tf_label.setStyleSheet(SECTION_HEADER)
        self._tf_label.setVisible(False)
        content_layout.addWidget(self._tf_label)
        self._format_grid = FormatGrid()
        content_layout.addWidget(self._format_grid, stretch=1)

        self._left_layout.addWidget(self._left_content, alignment=Qt.AlignmentFlag.AlignCenter)

        self._splitter.addWidget(left)

        # Right panel
        self._right_panel = QWidget()
        right_layout = QVBoxLayout(self._right_panel)
        right_layout.setContentsMargins(4, 8, 8, 8)
        right_layout.setSpacing(8)

        _oh = QLabel("Options")
        _oh.setStyleSheet(SECTION_HEADER)
        right_layout.addWidget(_oh)
        self._options_panel = OptionsPanel()
        self._options_panel.setFixedHeight(240)
        right_layout.addWidget(self._options_panel)

        _dh = QLabel("Dependencies")
        _dh.setStyleSheet(SECTION_HEADER)
        right_layout.addWidget(_dh)
        self._dep_panel = DependencyPanel()
        self._dep_panel.setFixedHeight(160)
        right_layout.addWidget(self._dep_panel)

        self._queue_panel = QueuePanel()
        right_layout.addWidget(self._queue_panel)

        # Action buttons
        btn_row = QHBoxLayout()
        self._convert_btn = QPushButton("Convert")
        self._convert_btn.setEnabled(False)
        self._convert_btn.setFixedHeight(32)
        self._convert_btn.setStyleSheet(
            f"QPushButton {{ background: {ACCENT}; color: white; font-weight: bold; "
            f"border: none; border-radius: {RADIUS}px; }}"
            f"QPushButton:disabled {{ background: #e0e0e0; color: {TEXT_DIM}; }}"
            f"QPushButton:hover:enabled {{ background: #3498db; }}"
        )
        btn_row.addWidget(self._convert_btn)

        self._add_queue_btn = QPushButton("Add to Queue")
        self._add_queue_btn.setEnabled(False)
        self._add_queue_btn.setFixedHeight(32)
        btn_row.addWidget(self._add_queue_btn)

        self._cancel_btn = QPushButton("Cancel")
        self._cancel_btn.setEnabled(False)
        self._cancel_btn.setFixedHeight(32)
        self._cancel_btn.setStyleSheet(
            f"QPushButton:enabled {{ color: {RED}; }}"
        )
        btn_row.addWidget(self._cancel_btn)

        self._open_btn = QPushButton("Open Output Folder")
        self._open_btn.setEnabled(False)
        self._open_btn.setFixedHeight(32)
        btn_row.addWidget(self._open_btn)
        right_layout.addLayout(btn_row)

        self._progress_bar = QProgressBar()
        self._progress_bar.setRange(0, 100)
        self._progress_bar.setValue(0)
        self._progress_bar.setFixedHeight(6)
        self._progress_bar.setTextVisible(False)
        self._progress_bar.setStyleSheet(
            f"QProgressBar {{ border: none; background: #e0e0e0; border-radius: 3px; }}"
            f"QProgressBar::chunk {{ background: {ACCENT}; border-radius: 3px; }}"
        )
        right_layout.addWidget(self._progress_bar)

        self._artifact_label = QLabel("")
        self._artifact_label.setVisible(False)
        right_layout.addWidget(self._artifact_label)

        _lh = QLabel("Log")
        _lh.setStyleSheet(SECTION_HEADER)
        right_layout.addWidget(_lh)
        self._log_viewer = LogViewer()
        right_layout.addWidget(self._log_viewer, stretch=1)

        self._splitter.addWidget(self._right_panel)
        self._splitter.setSizes([480, 720])
        self._right_panel.setVisible(False)

        # --- Central widget ---
        central = QWidget()
        main_layout = QVBoxLayout(central)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        main_layout.addWidget(header)

        sep_top = QFrame()
        sep_top.setFrameShape(QFrame.Shape.HLine)
        main_layout.addWidget(sep_top)

        main_layout.addWidget(self._splitter, stretch=1)
        self.setCentralWidget(central)

        QApplication.instance().setStyleSheet(
            "QWidget { background-color: #f5f5f5; color: #1a1a1a; }"
            "QScrollArea, QPlainTextEdit { background-color: #ffffff; }"
            "QLineEdit { background-color: #ffffff; border: 1px solid #d0d0d0; border-radius: 3px; padding: 2px 4px; }"
            "QPushButton { background-color: #ebebeb; color: #1a1a1a; border: 1px solid #d0d0d0; border-radius: 3px; padding: 4px 8px; }"
            "QPushButton:hover { background-color: #dedede; }"
            "QSplitter::handle:horizontal { background-color: #d0d0d0; width: 1px; }"
        )

        # Process controller
        self._proc = ProcessController(self)

    def _wire_signals(self) -> None:
        self._drop_zone.source_changed.connect(self._on_source_changed)
        self._format_grid.route_selected.connect(self._on_route_selected)
        self._options_panel.options_changed.connect(self._on_options_changed)
        self._dep_panel.recheck_requested.connect(self._on_recheck)
        self._dep_panel.install_requested.connect(self._on_install_requested)
        self._convert_btn.clicked.connect(self._on_convert)
        self._add_queue_btn.clicked.connect(self._on_add_to_queue)
        self._cancel_btn.clicked.connect(self._proc.cancel)
        self._open_btn.clicked.connect(self._on_open_output)
        self._queue_panel.run_requested.connect(self._on_run_queue)

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
        self._tf_label.setVisible(True)
        self._options_panel.set_route(None)
        self._dep_panel.clear()
        self._log_viewer.clear()
        self._progress_bar.setValue(0)
        self._artifact_label.setText("")
        self._artifact_label.setVisible(False)
        self._convert_btn.setEnabled(False)
        self._add_queue_btn.setEnabled(False)
        self._open_btn.setEnabled(False)
        self._right_panel.setVisible(False)

    def _on_route_selected(self, route: Route) -> None:
        if not self._right_panel.isVisible():
            self._right_panel.setVisible(True)
            self._splitter.setSizes([480, 720])
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

    def _on_install_requested(self, hint: str, item: str) -> None:
        python = self._get_python_executable()
        if python is None:
            return

        if not _is_pip_install(hint):
            self._log_viewer.append_stderr(f"[install] Rejected hint: {hint!r}")
            return
        spec = shlex.split(hint)[2]

        # Resolve installer: uv (works without pip in venv) → adjacent pip script → python -m pip
        uv = shutil.which("uv")
        pip_script = Path(python).parent / ("pip.exe" if sys.platform == "win32" else "pip")
        if uv:
            program = uv
            arguments = ["pip", "install", "--python", str(python), spec]
            installer_label = "uv"
        elif pip_script.exists():
            program = str(pip_script)
            arguments = ["install", spec]
            installer_label = "pip"
        else:
            program = str(python)
            arguments = ["-m", "pip", "install", spec]
            installer_label = "python -m pip"

        cmd = f"{program} {' '.join(arguments)}"

        reply = QMessageBox.question(
            self,
            "Install Package",
            f"Install '{spec}' using:\n\n  {cmd}\n\nProceed?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        self._log_viewer.append_stderr(f"[install] using {installer_label} for {python}")

        self._dep_panel.set_installing(True)
        self._convert_btn.setEnabled(False)
        self._add_queue_btn.setEnabled(False)

        self._install_proc = QProcess(self)
        self._install_proc.setProgram(program)
        self._install_proc.setArguments(arguments)

        def _on_stdout(_proc=self._install_proc) -> None:
            text = _proc.readAllStandardOutput().data().decode("utf-8", errors="replace")
            if text.strip():
                self._log_viewer.append_stderr(text)

        def _on_stderr_data(_proc=self._install_proc) -> None:
            text = _proc.readAllStandardError().data().decode("utf-8", errors="replace")
            if text.strip():
                self._log_viewer.append_stderr(text)

        def _on_done(exit_code: int, exit_status: QProcess.ExitStatus) -> None:
            self._dep_panel.set_installing(False)
            if exit_status == QProcess.ExitStatus.CrashExit or exit_code != 0:
                self._log_viewer.append_stderr(
                    f"[install] Install failed (exit {exit_code}, status {exit_status.name})"
                )
            else:
                self._log_viewer.append_stderr(f"[install] Installed {item}")
            self._install_proc = None
            self._on_recheck()

        def _on_start_error(error: QProcess.ProcessError) -> None:
            self._dep_panel.set_installing(False)
            self._install_proc = None
            self._log_viewer.append_stderr(
                f"[install] Failed to start process: {error.name}"
            )
            self._on_recheck()

        self._install_proc.readyReadStandardOutput.connect(_on_stdout)
        self._install_proc.readyReadStandardError.connect(_on_stderr_data)
        self._install_proc.finished.connect(_on_done)
        self._install_proc.errorOccurred.connect(_on_start_error)
        self._install_proc.start()

    def _on_convert(self) -> None:
        if self._source_path is None or self._selected_route is None or self._provider is None:
            return

        exe = self._get_python_executable()
        if exe is None and self._interp_edit.text().strip():
            return

        options = self._options_panel.get_options()
        output_dir = self._get_output_dir()

        job: ExportJob = self._provider.build_job(
            self._source_path, self._selected_route, options, output_dir,
            python_executable=exe,
        )

        self._log_viewer.clear()
        self._progress_bar.setValue(0)
        self._artifact_label.setText("")
        self._artifact_label.setVisible(False)
        self._convert_btn.setEnabled(False)
        self._cancel_btn.setEnabled(True)
        self._open_btn.setEnabled(False)
        self._artifact_path = None
        self.statusBar().showMessage("Converting…")

        self._proc.start(job)

    def _on_event(self, event: WorkerEvent) -> None:
        self._log_viewer.append_event(event)
        if isinstance(event, StartedEvent) and self._queue_panel.entries:
            self._queue_panel.mark_active(self._queue_job_idx)
        if isinstance(event, ArtifactEvent):
            self._artifact_path = event.path
            self._open_btn.setEnabled(True)
            size_mb = event.size_bytes / (1024 * 1024)
            name = Path(event.path).name
            self._artifact_label.setText(f"Output: {name}  ({size_mb:.1f} MB)")
            self._artifact_label.setVisible(True)
        if isinstance(event, FinishedEvent):
            if self._queue_panel.entries:
                self._queue_panel.mark_done(self._queue_job_idx, event.ok)
                self._queue_job_idx += 1
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

    def _get_python_executable(self) -> Path | None:
        text = self._interp_edit.text().strip()
        if not text:
            return None
        p = Path(text)
        if not p.is_file():
            self.statusBar().showMessage(f"Interpreter not found: {text}", 5000)
            return None
        return p

    def _get_output_dir(self) -> Path:
        d = self._source_path.parent / "yolo-export-studio-exports"
        d.mkdir(exist_ok=True)
        return d

    def _browse_interpreter(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Select Python interpreter")
        if path and Path(path).exists():
            self._interp_edit.setText(path)

    def _setup_shortcuts(self) -> None:
        QShortcut(QKeySequence("Ctrl+O"), self).activated.connect(self._drop_zone._browse)
        QShortcut(QKeySequence("Ctrl+Return"), self).activated.connect(self._convert_btn.click)
        QShortcut(QKeySequence("Escape"), self).activated.connect(self._proc.cancel)

    def _on_add_to_queue(self) -> None:
        if self._source_path is None or self._selected_route is None:
            return
        entry = QueueEntry(
            source_path=self._source_path,
            route=self._selected_route,
            options=self._options_panel.get_options(),
        )
        self._queue_panel.add_entry(entry)

    def _on_run_queue(self, entries: list) -> None:
        if not entries:
            return

        exe = self._get_python_executable()
        if exe is None and self._interp_edit.text().strip():
            return

        if self._source_path is not None:
            output_dir = self._get_output_dir()
        else:
            output_dir = Path.cwd() / "yolo-export-studio-exports"
            output_dir.mkdir(exist_ok=True)

        jobs = []
        for e in entries:
            provider = get_provider(e.route.provider_id)
            jobs.append(provider.build_job(e.source_path, e.route, e.options, output_dir, python_executable=exe))

        self._queue_job_idx = 0
        self._log_viewer.clear()
        self._progress_bar.setValue(0)
        self._artifact_label.setText("")
        self._artifact_label.setVisible(False)
        self._convert_btn.setEnabled(False)
        self._cancel_btn.setEnabled(True)
        self._open_btn.setEnabled(False)
        self.statusBar().showMessage("Running queue…")
        self._proc.start_sequence(jobs)

    def closeEvent(self, event: QCloseEvent) -> None:
        if self._install_proc is not None:
            self._install_proc.kill()
            self._install_proc.waitForFinished(3000)
        super().closeEvent(event)

    def _update_convert_button(self) -> None:
        all_ok = (
            self._source_match is not None
            and self._selected_route is not None
            and all(c.ok for c in self._current_checks)
        )
        enabled = all_ok and not self._proc.is_running
        self._convert_btn.setEnabled(enabled)
        self._add_queue_btn.setEnabled(enabled)
