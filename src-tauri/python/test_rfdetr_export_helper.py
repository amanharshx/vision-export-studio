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
            "model_config": {"resolution": 512, "patch_size": 16, "num_windows": 2},
        }

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "load_model_for_inspect") as load_model:
                result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        load_model.assert_not_called()

    def test_infer_geometry_sources(self):
        model_512 = SimpleNamespace(
            model_config=SimpleNamespace(resolution=512, patch_size=16, num_windows=2)
        )
        model_patch_only = SimpleNamespace(
            model_config=SimpleNamespace(patch_size=16, num_windows=2)
        )
        cases = [
            ("model_config", {}, model_512, {
                "recommended_imgsz": 512, "patch_size": 16, "num_windows": 2,
                "required_multiple": 32, "token_grid": 32,
                "resolution_source": "model_config",
            }),
            # Stronger saved config wins, including a custom 640 training
            # resolution that must not be replaced by a family preset.
            ("saved_model_config_wins", {
                "model_config": {"resolution": 640, "patch_size": 16, "num_windows": 2},
                "args": {"resolution": 512, "patch_size": 14, "num_windows": 4},
            }, model_512, {
                "recommended_imgsz": 640, "patch_size": 16, "num_windows": 2,
                "required_multiple": 32, "token_grid": 40,
                "resolution_source": "saved_model_config",
            }),
            ("legacy_args", {"args": {"resolution": 560, "patch_size": 14, "num_windows": 4}},
             None, {
                 "recommended_imgsz": 560, "patch_size": 14, "num_windows": 4,
                 "required_multiple": 56, "token_grid": 40,
                 "resolution_source": "args",
             }),
            ("namespace_args",
             {"args": SimpleNamespace(resolution=384, patch_size=16, num_windows=2)},
             None, {
                 "recommended_imgsz": 384, "patch_size": 16, "num_windows": 2,
                 "required_multiple": 32, "token_grid": 24,
                 "resolution_source": "args",
             }),
            ("position_embeddings", {
                "model_name": "RFDETRSmall",
                "state_dict": {
                    "model.backbone.0.encoder.encoder.embeddings.position_embeddings":
                        SimpleNamespace(shape=(1, 1025, 384)),
                },
            }, model_patch_only, {
                "recommended_imgsz": 512, "patch_size": 16, "num_windows": 2,
                "required_multiple": 32, "token_grid": 32,
                "resolution_source": "position_embeddings",
            }),
            ("segmentation",
             {"model_config": {"resolution": 384, "patch_size": 12, "num_windows": 2}},
             None, {
                 "recommended_imgsz": 384, "patch_size": 12, "num_windows": 2,
                 "required_multiple": 24, "token_grid": 32,
                 "resolution_source": "saved_model_config",
             }),
            ("malformed_falls_through", {
                "model_config": {"resolution": "bad", "patch_size": -1, "num_windows": 0},
                "args": {"resolution": 512, "patch_size": 16, "num_windows": 2},
            }, None, {
                "recommended_imgsz": 512, "patch_size": 16, "num_windows": 2,
                "required_multiple": 32, "token_grid": 32,
                "resolution_source": "args",
            }),
            ("invalid_saved_resolution_falls_through", {
                "model_config": {"resolution": 518, "patch_size": 14, "num_windows": 4},
            }, None, {
                "recommended_imgsz": None, "patch_size": 14, "num_windows": 4,
                "required_multiple": 56, "token_grid": None,
                "resolution_source": None,
            }),
            ("model_fields_outrank_conflicting_args",
             {"args": {"resolution": 560, "patch_size": 14, "num_windows": 4}},
             model_512, {
                 "recommended_imgsz": 512, "patch_size": 16, "num_windows": 2,
                 "required_multiple": 32, "token_grid": 32,
                 "resolution_source": "model_config",
             }),
            ("incomplete", {}, None, {
                "recommended_imgsz": None, "patch_size": None, "num_windows": None,
                "required_multiple": None, "token_grid": None,
                "resolution_source": None,
            }),
        ]
        for name, checkpoint, model, expected in cases:
            with self.subTest(name):
                native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint=checkpoint)
                self.assertEqual(native, expected)

    def test_infer_rejects_position_embedding_resolution_not_divisible_by_block(self):
        # RF-DETR Base: 37x37 tokens at patch 14 derives 518px, but the block
        # is 14*4=56 and 518 % 56 != 0, so resolution must stay incomplete.
        checkpoint = {
            "model_name": "RFDETRBase",
            "model": {
                "backbone.0.encoder.encoder.embeddings.position_embeddings":
                    SimpleNamespace(shape=(1, 37 * 37 + 1, 384)),
            },
        }
        model = SimpleNamespace(model_config=SimpleNamespace(patch_size=14, num_windows=4))

        native = helper.infer_native_export_shape("/tmp/model.pth", model, checkpoint=checkpoint)

        self.assertIsNone(native["recommended_imgsz"])
        self.assertIsNone(native["resolution_source"])
        self.assertEqual(native["patch_size"], 14)
        self.assertEqual(native["num_windows"], 4)
        self.assertEqual(native["required_multiple"], 56)

    def test_inspect_geometry_variants(self):
        cases = [
            ("detection", "RFDETRSmall",
             {"resolution": 512, "patch_size": 16, "num_windows": 2},
             "detection", 32, 0, True, False),
            ("nano", "RFDETRNano",
             {"resolution": 384, "patch_size": 16, "num_windows": 2},
             "detection", 32, 0, True, False),
            ("medium", "RFDETRMedium",
             {"resolution": 576, "patch_size": 16, "num_windows": 2},
             "detection", 32, 0, True, False),
            ("large", "RFDETRLarge",
             {"resolution": 704, "patch_size": 16, "num_windows": 2},
             "detection", 32, 0, True, False),
            ("legacy_base", "RFDETRBase",
             {"resolution": 560, "patch_size": 14, "num_windows": 4},
             "detection", 56, 0, True, True),
            ("segmentation", "RFDETRSegSmall",
             {"resolution": 384, "patch_size": 12, "num_windows": 2},
             "segmentation", 24, 0, True, False),
            ("seg_nano", "RFDETRSegNano",
             {"resolution": 312, "patch_size": 12, "num_windows": 1},
             "segmentation", 12, 0, True, False),
            ("seg_medium", "RFDETRSegMedium",
             {"resolution": 480, "patch_size": 12, "num_windows": 2},
             "segmentation", 24, 0, True, False),
            ("seg_large", "RFDETRSegLarge",
             {"resolution": 504, "patch_size": 12, "num_windows": 2},
             "segmentation", 24, 0, True, False),
            ("seg_xlarge", "RFDETRSegXLarge",
             {"resolution": 624, "patch_size": 12, "num_windows": 2},
             "segmentation", 24, 0, True, False),
            ("seg_2xlarge", "RFDETRSeg2XLarge",
             {"resolution": 768, "patch_size": 12, "num_windows": 2},
             "segmentation", 24, 0, True, False),
            ("plus_only", "RFDETRXLarge",
             {"resolution": 704, "patch_size": 16, "num_windows": 2},
             "detection", 32, 2, False, False),
            ("plus_2xlarge", "RFDETR2XLarge",
             {"resolution": 704, "patch_size": 16, "num_windows": 2},
             "detection", 32, 2, False, False),
        ]
        for name, class_symbol, geometry, family, multiple, exit_code, success, legacy in cases:
            with self.subTest(name):
                checkpoint = {"model_name": class_symbol, "model_config": geometry}
                captured = {}

                def fake_emit(payload, store=captured):
                    store.update(payload)

                with patch.object(helper, "load_checkpoint", return_value=checkpoint):
                    with patch.object(helper, "emit", side_effect=fake_emit):
                        result = helper.inspect_checkpoint("/tmp/model.pth")

                self.assertEqual(result, exit_code)
                self.assertEqual(captured["success"], success)
                self.assertEqual(captured["family"], family)
                self.assertEqual(captured["is_legacy"], legacy)
                self.assertEqual(captured["required_multiple"], multiple)
                self.assertEqual(captured["resolution_source"], "saved_model_config")
                if success:
                    self.assertIsNone(captured["error"])
                else:
                    self.assertTrue(captured["requires_plus"])
                    self.assertIsNotNone(captured["error"])

    def test_inspect_loads_model_when_saved_geometry_incomplete(self):
        checkpoint = {"model_name": "RFDETRSmall"}
        loaded = SimpleNamespace(
            model_config=SimpleNamespace(resolution=512, patch_size=16, num_windows=2)
        )
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "load_model_for_inspect", return_value=loaded) as load_model:
                with patch.object(helper, "emit", side_effect=fake_emit):
                    result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        load_model.assert_called_once()
        self.assertEqual(captured["recommended_imgsz"], 512)
        self.assertEqual(captured["required_multiple"], 32)
        self.assertEqual(captured["resolution_source"], "model_config")

    def test_inspect_prefers_valid_loaded_model_resolution_over_legacy_args(self):
        # Legacy args carry 640 without patch info; the loaded model supplies
        # 512/16/2. Precedence is saved > model > args with validity filtering,
        # so the valid loaded-model resolution wins in a single re-resolve.
        checkpoint = {"model_name": "RFDETRSmall", "args": {"resolution": 640}}
        loaded = SimpleNamespace(
            model_config=SimpleNamespace(resolution=512, patch_size=16, num_windows=2)
        )
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "load_model_for_inspect", return_value=loaded):
                with patch.object(helper, "emit", side_effect=fake_emit):
                    result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        self.assertEqual(captured["recommended_imgsz"], 512)
        self.assertEqual(captured["resolution_source"], "model_config")
        self.assertEqual(captured["patch_size"], 16)
        self.assertEqual(captured["required_multiple"], 32)
        self.assertEqual(captured["token_grid"], 32)

    def test_inspect_rejects_invalid_legacy_resolution_after_model_load(self):
        # Args 518 against loaded 560/14/4 (block 56): 518 is invalid and
        # must fall through instead of pairing with the model multiple.
        checkpoint = {"model_name": "RFDETRBase", "args": {"resolution": 518}}
        loaded = SimpleNamespace(
            model_config=SimpleNamespace(resolution=560, patch_size=14, num_windows=4)
        )
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=checkpoint):
            with patch.object(helper, "load_model_for_inspect", return_value=loaded):
                with patch.object(helper, "emit", side_effect=fake_emit):
                    result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        self.assertEqual(captured["recommended_imgsz"], 560)
        self.assertEqual(captured["resolution_source"], "model_config")
        self.assertEqual(captured["required_multiple"], 56)

    def test_inspect_keeps_checkpoint_geometry_when_model_load_fails(self):
        incomplete = {"model_name": "RFDETRSmall"}
        captured = {}

        def fake_emit(payload):
            captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=incomplete):
            with patch.object(helper, "load_model_for_inspect", side_effect=RuntimeError("no rfdetr")):
                with patch.object(helper, "emit", side_effect=fake_emit):
                    result = helper.inspect_checkpoint("/tmp/model.pth")

        self.assertEqual(result, 0)
        self.assertTrue(captured["success"])
        self.assertIsNone(captured["recommended_imgsz"])
        self.assertIsNone(captured["error"])

    def test_inspect_distinguishes_load_failure_from_incomplete_geometry(self):
        incomplete = {"model_name": "RFDETRSmall"}
        incomplete_captured = {}
        failure_captured = {}

        def capture_incomplete(payload):
            incomplete_captured.update(payload)

        def capture_failure(payload):
            failure_captured.update(payload)

        with patch.object(helper, "load_checkpoint", return_value=incomplete):
            with patch.object(helper, "load_model_for_inspect", side_effect=RuntimeError("no rfdetr")):
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
        self.assertFalse(failure_captured["success"])
        self.assertIsNone(failure_captured["class_symbol"])
        self.assertIn("torch load boom", failure_captured["error"])

    def test_load_model_for_inspect_forwards_confirmed_trust(self):
        seen = {}

        def from_checkpoint(path, trust_checkpoint=False):
            seen["kwargs"] = {"trust_checkpoint": trust_checkpoint}
            return SimpleNamespace()

        fake_module = types.SimpleNamespace(from_checkpoint=from_checkpoint)

        with patch("builtins.__import__", return_value=fake_module):
            helper.load_model_for_inspect("/tmp/model.pth")

        self.assertEqual(seen["kwargs"], {"trust_checkpoint": True})

    def test_load_model_for_inspect_omits_trust_flag_on_legacy_signature(self):
        seen = {}

        def from_checkpoint(path, **kwargs):
            seen["kwargs"] = kwargs
            return SimpleNamespace()

        fake_module = types.SimpleNamespace(from_checkpoint=from_checkpoint)

        with patch("builtins.__import__", return_value=fake_module):
            helper.load_model_for_inspect("/tmp/model.pth")

        self.assertEqual(seen["kwargs"], {})

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
