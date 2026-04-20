"""Process controller — manages the QProcess export worker subprocess."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PySide6.QtCore import QObject, QProcess, QTimer, Signal

from yolo_export_studio.core.jobs import ExportJob
from yolo_export_studio.core.logs import ArtifactEvent, FinishedEvent, ProgressEvent, WorkerEvent, parse_event


class ProcessController(QObject):
    """Owns the QProcess that runs export_worker, parses JSONL stdout."""

    event_received = Signal(object)   # WorkerEvent
    stderr_received = Signal(str)
    finished = Signal(bool, str)      # (ok, error_message)
    crashed = Signal()
    progress_updated = Signal(int)    # 0-100

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._process: QProcess | None = None
        self._stdout_buf = b""
        self._received_finished = False
        self._cancel_requested = False
        self._job_file: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self, job: ExportJob) -> None:
        if self._process is not None and self._process.state() != QProcess.ProcessState.NotRunning:
            return

        self._cancel_requested = False

        # Write job to a temp file; we delete it in _on_finished
        fd, self._job_file = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        job.write(Path(self._job_file))

        self._stdout_buf = b""
        self._received_finished = False

        if self._process is not None:
            self._process.deleteLater()
        self._process = QProcess(self)
        self._process.setProgram(job.python_executable)
        self._process.setArguments(["-m", "yolo_export_studio.workers.export_worker", self._job_file])
        self._process.readyReadStandardOutput.connect(self._on_stdout)
        self._process.readyReadStandardError.connect(self._on_stderr)
        self._process.finished.connect(self._on_finished)
        self._process.start()

    def cancel(self) -> None:
        if self._process is None:
            return
        self._cancel_requested = True
        self._process.terminate()
        QTimer.singleShot(3000, self._kill_if_running)

    @property
    def is_running(self) -> bool:
        return (
            self._process is not None
            and self._process.state() != QProcess.ProcessState.NotRunning
        )

    # ------------------------------------------------------------------
    # Private slots
    # ------------------------------------------------------------------

    def _on_stdout(self) -> None:
        raw = self._process.readAllStandardOutput().data()
        self._stdout_buf += raw
        while b"\n" in self._stdout_buf:
            line_bytes, self._stdout_buf = self._stdout_buf.split(b"\n", 1)
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            event = parse_event(line)
            if event is None:
                continue
            if isinstance(event, FinishedEvent):
                self._received_finished = True
            self.event_received.emit(event)
            if isinstance(event, ProgressEvent):
                self.progress_updated.emit(event.value)

    def _on_stderr(self) -> None:
        raw = self._process.readAllStandardError().data()
        text = raw.decode("utf-8", errors="replace")
        if text.strip():
            self.stderr_received.emit(text)

    def _on_finished(self, exit_code: int, exit_status: QProcess.ExitStatus) -> None:
        # Capture and reset cancel flag before branching — ensures it's always cleared
        was_cancelled = self._cancel_requested
        self._cancel_requested = False

        # Drain any remaining stdout
        remaining = self._process.readAllStandardOutput().data()
        if remaining:
            self._stdout_buf += remaining
            while b"\n" in self._stdout_buf:
                line_bytes, self._stdout_buf = self._stdout_buf.split(b"\n", 1)
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                event = parse_event(line)
                if event:
                    if isinstance(event, FinishedEvent):
                        self._received_finished = True
                    self.event_received.emit(event)
                    if isinstance(event, ProgressEvent):
                        self.progress_updated.emit(event.value)

        # Clean up temp job file
        if self._job_file:
            try:
                os.unlink(self._job_file)
            except OSError:
                pass
            self._job_file = None

        if exit_status == QProcess.ExitStatus.CrashExit:
            if was_cancelled:
                self.finished.emit(False, "Cancelled")
            else:
                self.crashed.emit()
        elif exit_code != 0 and not self._received_finished:
            if was_cancelled:
                self.finished.emit(False, "Cancelled")
            else:
                self.finished.emit(False, f"Worker exited unexpectedly (exit code {exit_code})")
        elif not self._received_finished:
            self.finished.emit(False, "Worker exited without sending finished event")
        else:
            # finished event was already forwarded via event_received
            pass

    def _kill_if_running(self) -> None:
        if self.is_running and self._process is not None:
            self._process.kill()
