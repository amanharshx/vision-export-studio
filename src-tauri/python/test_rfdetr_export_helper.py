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

    def test_tflite_export_leaves_parent_path_unchanged(self):
        args = SimpleNamespace(
            checkpoint="/tmp/model.pth", output_dir="/tmp/out", route_id="rfdetr.pth.tflite",
            imgsz=640, batch=1, opset=None, precision="fp32",
            variant_mode="auto", manual_class_symbol=None,
        )
        with patch.dict(helper.os.environ, {"PATH": "/usr/bin"}, clear=True):
            with patch.object(helper, "preload_tensorflow_before_rfdetr"):
                with patch.object(helper, "resolve_model", return_value=SimpleNamespace(export=Mock())):
                    with patch.object(helper.os, "makedirs"):
                        result = helper.export_checkpoint(args)
            self.assertEqual(result, 0)
            self.assertEqual(helper.os.environ["PATH"], "/usr/bin")

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
        model = SimpleNamespace(model_config=SimpleNamespace(resolution=512, patch_size=16, num_windows=2))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint={})

        self.assertEqual(native, {
            "recommended_imgsz": 512,
            "patch_size": 16,
            "num_windows": 2,
            "required_multiple": 32,
            "token_grid": 32,
            "resolution_source": "model_config",
        })

    def test_infer_prefers_saved_model_config_over_model_config(self):
        checkpoint = {"model_config": {"resolution": 640, "patch_size": 16, "num_windows": 2}}
        model = SimpleNamespace(model_config=SimpleNamespace(resolution=512, patch_size=16, num_windows=2))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint=checkpoint)

        self.assertEqual(native["recommended_imgsz"], 640)
        self.assertEqual(native["patch_size"], 16)
        self.assertEqual(native["num_windows"], 2)
        self.assertEqual(native["required_multiple"], 32)
        self.assertEqual(native["token_grid"], 40)
        self.assertEqual(native["resolution_source"], "saved_model_config")

    def test_infer_preserves_custom_training_resolution(self):
        checkpoint = {"model_config": {"resolution": 640, "patch_size": 16, "num_windows": 2}}
        model = SimpleNamespace(model_config=SimpleNamespace(resolution=640, patch_size=16, num_windows=2))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint=checkpoint)

        # Custom 640 for a Small variant must not be replaced by the 512 family preset.
        self.assertEqual(native["recommended_imgsz"], 640)
        self.assertEqual(native["resolution_source"], "saved_model_config")

    def test_infer_falls_back_to_legacy_args_without_replacing_stronger_source(self):
        checkpoint = {
            "model_config": {"resolution": 640, "patch_size": 16, "num_windows": 2},
            "args": {"resolution": 512, "patch_size": 14, "num_windows": 4},
        }
        model = SimpleNamespace(model_config=SimpleNamespace(resolution=512, patch_size=16, num_windows=2))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint=checkpoint)

        self.assertEqual(native["recommended_imgsz"], 640)
        self.assertEqual(native["resolution_source"], "saved_model_config")
        self.assertEqual(native["patch_size"], 16)
        self.assertEqual(native["num_windows"], 2)

    def test_infer_uses_legacy_args_when_stronger_sources_missing(self):
        checkpoint = {"args": {"resolution": 560, "patch_size": 14, "num_windows": 4}}

        native = helper.infer_native_export_shape("/tmp/model.pth", None, checkpoint=checkpoint)

        self.assertEqual(native, {
            "recommended_imgsz": 560,
            "patch_size": 14,
            "num_windows": 4,
            "required_multiple": 56,
            "token_grid": 40,
            "resolution_source": "args",
        })

    def test_infer_reads_namespace_args(self):
        checkpoint = {"args": SimpleNamespace(resolution=384, patch_size=16, num_windows=2)}

        native = helper.infer_native_export_shape("/tmp/model.pth", None, checkpoint=checkpoint)

        self.assertEqual(native["recommended_imgsz"], 384)
        self.assertEqual(native["required_multiple"], 32)
        self.assertEqual(native["resolution_source"], "args")

    def test_infer_derives_resolution_from_position_embeddings(self):
        checkpoint = {
            "model_name": "RFDETRSmall",
            "state_dict": {
                "model.backbone.0.encoder.encoder.embeddings.position_embeddings": SimpleNamespace(
                    shape=(1, 1025, 384)
                ),
            },
        }
        model = SimpleNamespace(model_config=SimpleNamespace(patch_size=16, num_windows=2))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint=checkpoint)

        self.assertEqual(native["recommended_imgsz"], 512)
        self.assertEqual(native["token_grid"], 32)
        self.assertEqual(native["required_multiple"], 32)
        self.assertEqual(native["resolution_source"], "position_embeddings")

    def test_infer_ignores_malformed_metadata_and_falls_through(self):
        checkpoint = {
            "model_config": {"resolution": "bad", "patch_size": -1, "num_windows": 0},
            "args": {"resolution": 512, "patch_size": 16, "num_windows": 2},
        }

        native = helper.infer_native_export_shape("/tmp/model.pth", None, checkpoint=checkpoint)

        self.assertEqual(native["recommended_imgsz"], 512)
        self.assertEqual(native["resolution_source"], "args")

    def test_infer_returns_incomplete_geometry_without_crashing(self):
        native = helper.infer_native_export_shape("/tmp/model.pth", None, checkpoint={})

        self.assertEqual(native, {
            "recommended_imgsz": None,
            "patch_size": None,
            "num_windows": None,
            "required_multiple": None,
            "token_grid": None,
            "resolution_source": None,
        })

    def test_infer_reports_segmentation_geometry(self):
        checkpoint = {"model_config": {"resolution": 384, "patch_size": 12, "num_windows": 2}}

        native = helper.infer_native_export_shape("/tmp/model.pth", None, checkpoint=checkpoint)

        self.assertEqual(native["recommended_imgsz"], 384)
        self.assertEqual(native["required_multiple"], 24)
        self.assertEqual(native["resolution_source"], "saved_model_config")

    def test_inspect_reports_full_geometry_for_detection_variant(self):
        checkpoint = {
            "model_name": "RFDETRSmall",
            "model_config": {"resolution": 512, "patch_size": 16, "num_windows": 2},
        }
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "emit", side_effect=fake_emit):
                result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        self.assertTrue(captured["success"])
        self.assertEqual(captured["family"], "detection")
        self.assertEqual(captured["recommended_imgsz"], 512)
        self.assertEqual(captured["patch_size"], 16)
        self.assertEqual(captured["num_windows"], 2)
        self.assertEqual(captured["required_multiple"], 32)
        self.assertEqual(captured["resolution_source"], "saved_model_config")
        self.assertIsNone(captured["error"])

    def test_inspect_reports_full_geometry_for_segmentation_variant(self):
        checkpoint = {
            "model_name": "RFDETRSegSmall",
            "model_config": {"resolution": 384, "patch_size": 12, "num_windows": 2},
        }
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "emit", side_effect=fake_emit):
                result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        self.assertEqual(captured["family"], "segmentation")
        self.assertEqual(captured["required_multiple"], 24)
        self.assertEqual(captured["resolution_source"], "saved_model_config")

    def test_inspect_marks_plus_only_unsupported_with_geometry(self):
        checkpoint = {
            "model_name": "RFDETRXLarge",
            "model_config": {"resolution": 704, "patch_size": 16, "num_windows": 2},
        }
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "emit", side_effect=fake_emit):
                result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 2)
        self.assertFalse(captured["success"])
        self.assertTrue(captured["requires_plus"])
        self.assertIsNotNone(captured["error"])

    def test_inspect_distinguishes_load_failure_from_incomplete_geometry(self):
        incomplete = {"model_name": "RFDETRSmall"}
        incomplete_captured = {}
        legacy_captured = {}

        def capture_incomplete(payload):
            incomplete_captured.update(payload)

        def capture_failure(payload):
            legacy_captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=incomplete):
            with patch.object(helper, "emit", side_effect=capture_incomplete):
                incomplete_result = helper.inspect_checkpoint("/tmp/model.pth")

        with patch.object(helper, "load_checkpoint", side_effect=RuntimeError("torch load boom")):
            with patch.object(helper, "emit", side_effect=capture_failure):
                failure_result = helper.inspect_checkpoint("/tmp/model.pth")

        # Incomplete geometry: variant known, geometry missing, no error.
        self.assertEqual(incomplete_result, 0)
        self.assertTrue(incomplete_captured["success"])
        self.assertIsNone(incomplete_captured["recommended_imgsz"])
        self.assertIsNone(incomplete_captured["resolution_source"])
        self.assertIsNone(incomplete_captured["error"])
        # Load failure: variant unknown, explicit error.
        self.assertEqual(failure_result, 1)
        self.assertFalse(legacy_captured["success"])
        self.assertIsNone(legacy_captured["class_symbol"])
        self.assertIn("torch load boom", legacy_captured["error"])

    def test_empty_failure_carries_new_geometry_fields(self):
        failure = helper.empty_failure("boom")

        self.assertIsNone(failure["num_windows"])
        self.assertIsNone(failure["required_multiple"])
        self.assertIsNone(failure["resolution_source"])

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

    def test_export_checkpoint_fixes_executorch_xnnpack_backend(self):
        export = Mock()
        args = SimpleNamespace(
            checkpoint="/tmp/model.pth", output_dir="/tmp/out", route_id="rfdetr.pth.executorch",
            imgsz=640, batch=2, opset=17, precision="fp16",
            variant_mode="auto", manual_class_symbol=None,
        )

        with patch.object(helper, "resolve_model", return_value=SimpleNamespace(export=export)):
            with patch.object(helper.os, "makedirs"):
                result = helper.export_checkpoint(args)

        self.assertEqual(result, 0)
        self.assertEqual(export.call_args.kwargs, {
            "format": "executorch",
            "backend": "xnnpack",
            "output_dir": "/tmp/out",
            "shape": (640, 640),
            "batch_size": 2,
        })

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
