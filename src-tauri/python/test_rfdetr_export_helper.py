import importlib.util
import io
import pathlib
import types
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch


MODULE_PATH = pathlib.Path(__file__).with_name("rfdetr_export_helper.py")
SPEC = importlib.util.spec_from_file_location("rfdetr_export_helper", MODULE_PATH)
helper = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(helper)


class RfDetrExportHelperTests(unittest.TestCase):
    def test_tflite_preloads_tensorflow_before_resolving_model(self):
        events = []
        args = SimpleNamespace(
            checkpoint="/tmp/model.pth", output_dir="/tmp/out", route_id="rfdetr.pth.tflite",
            imgsz=640, batch=1, opset=None, precision="fp32",
            variant_mode="auto", manual_class_symbol=None,
        )

        real_import = __import__

        def record_import(name, *args, **kwargs):
            if name == "tensorflow":
                events.append("tensorflow")
                return Mock()
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=record_import):
            with patch.object(
                helper,
                "resolve_model",
                side_effect=lambda args: events.append("resolve_model") or SimpleNamespace(export=Mock()),
            ):
                with patch.object(helper.os, "makedirs"):
                    result = helper.export_checkpoint(args)

        self.assertEqual(result, 0)
        self.assertEqual(events[:2], ["tensorflow", "resolve_model"])

    def test_non_tflite_exports_do_not_preload_tensorflow(self):
        for route_id in ("rfdetr.pth.onnx", "rfdetr.pth.engine", "rfdetr.pth.coreml"):
            args = SimpleNamespace(
                checkpoint="/tmp/model.pth", output_dir="/tmp/out", route_id=route_id,
                imgsz=640, batch=1, opset=None, precision="fp32",
                variant_mode="auto", manual_class_symbol=None,
            )

            with patch.object(helper, "preload_tensorflow_before_rfdetr") as preload:
                with patch.object(helper, "resolve_model", return_value=SimpleNamespace(export=Mock())):
                    with patch.object(helper.os, "makedirs"):
                        result = helper.export_checkpoint(args)

            self.assertEqual(result, 0)
            preload.assert_not_called()

    def test_tflite_preload_ignores_missing_top_level_tensorflow(self):
        with patch("builtins.__import__", side_effect=ModuleNotFoundError(name="tensorflow")):
            helper.preload_tensorflow_before_rfdetr()

    def test_export_prepends_active_venv_scripts_to_path(self):
        with patch.object(helper.sys, "executable", "/tmp/rfdetr-tflite/.venv/bin/python"):
            with patch.dict(helper.os.environ, {"PATH": "/usr/bin"}, clear=True):
                helper.prepend_active_venv_scripts_to_path()

                self.assertEqual(
                    helper.os.environ["PATH"],
                    "/tmp/rfdetr-tflite/.venv/bin:/usr/bin",
                )

    def test_resolve_model_class_symbol_prefers_checkpoint_model_name(self):
        checkpoint = {"model_name": "RFDETRSmall"}

        class_symbol = helper.resolve_model_class_symbol(checkpoint)

        self.assertEqual(class_symbol, "RFDETRSmall")

    def test_load_model_for_inspect_falls_back_when_from_checkpoint_missing(self):
        checkpoint = {"model_name": "RFDETRSmall"}
        expected_model = SimpleNamespace(model_config=SimpleNamespace(resolution=512, patch_size=16))
        fake_module = types.SimpleNamespace(RFDETRSmall=lambda **kwargs: expected_model)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch("builtins.__import__", return_value=fake_module):
                model = helper.load_model_for_inspect("/tmp/model.pth")

        self.assertIs(model, expected_model)

    def test_inspect_checkpoint_uses_checkpoint_metadata_without_rfdetr_import(self):
        checkpoint = {
            "model_name": "RFDETRSmall",
            "state_dict": {
                "model.backbone.0.encoder.encoder.embeddings.position_embeddings": SimpleNamespace(
                    shape=(1, 1025, 384)
                ),
            },
        }

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "load_model_for_inspect") as load_model:
                result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        load_model.assert_not_called()

    def test_infer_native_export_shape_prefers_model_config(self):
        model = SimpleNamespace(model_config=SimpleNamespace(resolution=512, patch_size=16))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint={})

        self.assertEqual(native, {
            "recommended_imgsz": 512,
            "patch_size": 16,
            "token_grid": 32,
        })

    def test_export_checkpoint_uses_tflite_quantization_without_legacy_flags(self):
        for quantization in ("fp32", "int8"):
            export = Mock()
            args = SimpleNamespace(
                checkpoint="/tmp/model.pth", output_dir="/tmp/out", route_id="rfdetr.pth.tflite",
                imgsz=640, batch=1, opset=None, precision=quantization,
                variant_mode="auto", manual_class_symbol=None,
            )

            with patch.object(helper, "resolve_model", return_value=SimpleNamespace(export=export)):
                with patch.object(helper.os, "makedirs"):
                    result = helper.export_checkpoint(args)

            self.assertEqual(result, 0)
            kwargs = export.call_args.kwargs
            self.assertEqual(kwargs["format"], "tflite")
            self.assertEqual(kwargs["quantization"], quantization)
            self.assertNotIn("fp16", kwargs)
            self.assertNotIn("coreml_precision", kwargs)
            self.assertNotIn("calibration_data", kwargs)
            self.assertNotIn("max_images", kwargs)

    def test_export_checkpoint_uses_native_tensorrt_export(self):
        export = Mock()
        args = SimpleNamespace(
            checkpoint="/tmp/model.pth",
            output_dir="/tmp/out",
            route_id="rfdetr.pth.engine",
            imgsz=640,
            batch=1,
            opset=None,
            precision="fp32",
            variant_mode="auto",
            manual_class_symbol=None,
        )

        with patch.object(helper, "resolve_model", return_value=SimpleNamespace(export=export)):
            with patch.object(helper.os, "makedirs"):
                result = helper.export_checkpoint(args)

        self.assertEqual(result, 0)
        self.assertEqual(export.call_args.kwargs["format"], "tensorrt")
        self.assertFalse(export.call_args.kwargs["fp16"])

    def test_export_checkpoint_uses_coreml_precision_without_fp16_flag(self):
        for precision, expected in (("fp32", "float32"), ("fp16", "float16")):
            export = Mock()
            args = SimpleNamespace(
                checkpoint="/tmp/model.pth", output_dir="/tmp/out", route_id="rfdetr.pth.coreml",
                imgsz=640, batch=1, opset=17, precision=precision,
                variant_mode="auto", manual_class_symbol=None,
            )

            with patch.object(helper, "resolve_model", return_value=SimpleNamespace(export=export)):
                with patch.object(helper.os, "makedirs"):
                    result = helper.export_checkpoint(args)

            self.assertEqual(result, 0)
            self.assertEqual(export.call_args.kwargs["format"], "coreml")
            self.assertEqual(export.call_args.kwargs["coreml_precision"], expected)
            self.assertNotIn("fp16", export.call_args.kwargs)
            self.assertNotIn("opset_version", export.call_args.kwargs)

    def test_parse_args_defaults_tensorrt_precision_to_fp32(self):
        with patch("sys.argv", [
            "rfdetr_export_helper.py", "export", "--checkpoint", "/tmp/model.pth",
            "--route-id", "rfdetr.pth.engine", "--output-dir", "/tmp/out",
            "--variant-mode", "auto", "--imgsz", "640", "--batch", "1",
        ]):
            args = helper.parse_args()

        self.assertEqual(args.precision, "fp32")

    def test_helper_source_has_no_trtexec_reference(self):
        source = MODULE_PATH.read_text()

        self.assertNotIn("trtexec", source)


if __name__ == "__main__":
    unittest.main()
