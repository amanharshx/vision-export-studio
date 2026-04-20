"""Options panel — per-route conversion parameters."""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from yolo_export_studio.core.routes import Route

_NMS_FORMATS = {"coreml", "engine", "onnx", "saved_model", "tflite", "tfjs"}


class OptionsPanel(QWidget):
    """Shows conversion options appropriate for the selected route."""

    options_changed = Signal(dict)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._route: Route | None = None
        self._setup_ui()

    def _setup_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(4)

        self._placeholder = QLabel("Select a target format")
        self._placeholder.setStyleSheet("color: #888; font-style: italic;")
        outer.addWidget(self._placeholder)

        self._body = QWidget()
        form = QFormLayout(self._body)
        form.setContentsMargins(0, 0, 0, 0)
        form.setSpacing(6)

        # imgsz — always shown
        self._imgsz = QSpinBox()
        self._imgsz.setRange(32, 4096)
        self._imgsz.setSingleStep(32)
        self._imgsz.setValue(640)
        form.addRow("Image size:", self._imgsz)

        # batch — always shown
        self._batch = QSpinBox()
        self._batch.setRange(1, 64)
        self._batch.setValue(1)
        form.addRow("Batch size:", self._batch)

        # half
        self._half = QCheckBox("FP16 half precision")
        self._half_row_label = QLabel("Half:")
        form.addRow(self._half_row_label, self._half)

        # int8
        self._int8 = QCheckBox("INT8 quantisation")
        self._int8_row_label = QLabel("INT8:")
        form.addRow(self._int8_row_label, self._int8)

        # dynamic
        self._dynamic = QCheckBox("Dynamic axes")
        self._dynamic_row_label = QLabel("Dynamic:")
        form.addRow(self._dynamic_row_label, self._dynamic)

        # simplify (ONNX only)
        self._simplify = QCheckBox("Simplify graph")
        self._simplify.setChecked(True)
        self._simplify_row_label = QLabel("Simplify:")
        form.addRow(self._simplify_row_label, self._simplify)

        # nms
        self._nms = QCheckBox("Add NMS op")
        self._nms_row_label = QLabel("NMS:")
        form.addRow(self._nms_row_label, self._nms)

        # opset (ONNX only)
        self._opset = QSpinBox()
        self._opset.setRange(0, 20)
        self._opset.setSpecialValueText("auto")
        self._opset.setValue(0)
        self._opset_row_label = QLabel("Opset:")
        form.addRow(self._opset_row_label, self._opset)

        # data (calibration)
        data_widget = QWidget()
        data_layout = QHBoxLayout(data_widget)
        data_layout.setContentsMargins(0, 0, 0, 0)
        self._data_edit = QLineEdit()
        self._data_edit.setPlaceholderText("Path to calibration data…")
        data_browse = QPushButton("Browse…")
        data_browse.setFixedWidth(72)
        data_browse.clicked.connect(self._browse_data)
        data_layout.addWidget(self._data_edit)
        data_layout.addWidget(data_browse)
        self._data_row_label = QLabel("Cal. data:")
        form.addRow(self._data_row_label, data_widget)

        outer.addWidget(self._body)
        self._body.hide()

        # Connect all widgets to emit options_changed
        self._imgsz.valueChanged.connect(self._emit)
        self._batch.valueChanged.connect(self._emit)
        self._half.toggled.connect(self._on_half_toggled)
        self._int8.toggled.connect(self._on_int8_toggled)
        self._dynamic.toggled.connect(self._emit)
        self._simplify.toggled.connect(self._emit)
        self._nms.toggled.connect(self._emit)
        self._opset.valueChanged.connect(self._emit)
        self._data_edit.textChanged.connect(self._emit)

    def _browse_data(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Select Calibration Data", "", "YAML (*.yaml *.yml);;All files (*)")
        if path:
            self._data_edit.setText(path)

    def _on_half_toggled(self, checked: bool) -> None:
        if checked:
            self._int8.setChecked(False)
        self._emit()

    def _on_int8_toggled(self, checked: bool) -> None:
        if checked:
            self._half.setChecked(False)
        self._emit()

    def _emit(self, *_args) -> None:
        self.options_changed.emit(self.get_options())

    def set_route(self, route: Route | None) -> None:
        self._route = route
        if route is None:
            self._body.hide()
            self._placeholder.show()
            return

        self._placeholder.hide()
        self._body.show()

        tf = route.target_format
        self._set_row_visible(self._half_row_label, self._half, route.supports_half)
        self._set_row_visible(self._int8_row_label, self._int8, route.supports_int8)
        self._set_row_visible(self._dynamic_row_label, self._dynamic, route.supports_dynamic)
        self._set_row_visible(self._simplify_row_label, self._simplify, tf == "onnx")
        self._set_row_visible(self._nms_row_label, self._nms, tf in _NMS_FORMATS)
        self._set_row_visible(self._opset_row_label, self._opset, tf == "onnx")
        self._set_row_visible(self._data_row_label, self._data_edit.parent(), route.needs_calibration)

    def _set_row_visible(self, label: QWidget, widget: QWidget, visible: bool) -> None:
        label.setVisible(visible)
        widget.setVisible(visible)

    def get_options(self) -> dict:
        if self._route is None:
            return {}
        opts: dict = {
            "imgsz": self._imgsz.value(),
            "batch": self._batch.value(),
        }
        tf = self._route.target_format
        if self._route.supports_half:
            opts["half"] = self._half.isChecked()
        if self._route.supports_int8:
            opts["int8"] = self._int8.isChecked()
        if self._route.supports_dynamic:
            opts["dynamic"] = self._dynamic.isChecked()
        if tf == "onnx":
            opts["simplify"] = self._simplify.isChecked()
            opts["opset"] = self._opset.value()
        if tf in _NMS_FORMATS:
            opts["nms"] = self._nms.isChecked()
        if self._route.needs_calibration:
            opts["data"] = self._data_edit.text()
        return opts
