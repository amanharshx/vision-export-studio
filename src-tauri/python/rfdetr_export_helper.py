#!/usr/bin/env python3
import argparse
import inspect
import json
import os
import sys

DETECTION_CLASSES = {
    "RFDETRNano",
    "RFDETRSmall",
    "RFDETRBase",
    "RFDETRMedium",
    "RFDETRLarge",
}

SEGMENTATION_CLASSES = {
    "RFDETRSegNano",
    "RFDETRSegSmall",
    "RFDETRSegMedium",
    "RFDETRSegLarge",
    "RFDETRSegXLarge",
    "RFDETRSeg2XLarge",
}

PLUS_ONLY_CLASSES = {"RFDETRXLarge", "RFDETR2XLarge"}
LEGACY_CLASSES = {"RFDETRBase"}


def emit(payload):
    print(json.dumps(payload), flush=True)


def empty_failure(message):
    return {
        "success": False,
        "class_symbol": None,
        "family": None,
        "size": None,
        "requires_plus": False,
        "is_legacy": False,
        "recommended_imgsz": None,
        "patch_size": None,
        "num_windows": None,
        "required_multiple": None,
        "token_grid": None,
        "resolution_source": None,
        "error": message,
    }


def class_family(class_symbol):
    if class_symbol in DETECTION_CLASSES or class_symbol in PLUS_ONLY_CLASSES:
        return "detection"
    if class_symbol in SEGMENTATION_CLASSES:
        return "segmentation"
    return None


def class_size(class_symbol):
    token = class_symbol.replace("RFDETR", "")
    if token.startswith("Seg"):
        token = "seg-" + token[3:]
    return token.replace("XLarge", "xlarge").replace("2XLarge", "2xlarge").lower()


def load_checkpoint(checkpoint_path):
    import torch

    return torch.load(checkpoint_path, map_location="cpu", weights_only=False)


def resolve_model_class_symbol(checkpoint):
    if not isinstance(checkpoint, dict):
        return None

    model_name = checkpoint.get("model_name")
    if isinstance(model_name, str) and model_name:
        return model_name

    args = checkpoint.get("args")
    if isinstance(args, dict):
        for key in ("model_name", "model_type", "variant", "class_name"):
            value = args.get(key)
            if isinstance(value, str) and value:
                return value

    return None


def load_model_for_inspect(checkpoint_path, checkpoint=None):
    module = __import__("rfdetr", fromlist=["from_checkpoint"])
    from_checkpoint = getattr(module, "from_checkpoint", None)
    if callable(from_checkpoint):
        # The Rust command only runs inspect after explicit user trust, so
        # forward that confirmed trust when RFDETR.from_checkpoint declares
        # it. The public wrapper keeps (path, **kwargs) and forwards.
        try:
            declares_trust = "trust_checkpoint" in inspect.signature(
                module.RFDETR.from_checkpoint
            ).parameters
        except (TypeError, ValueError, AttributeError):
            declares_trust = False
        if declares_trust:
            return from_checkpoint(checkpoint_path, trust_checkpoint=True)
        return from_checkpoint(checkpoint_path)

    checkpoint = checkpoint if checkpoint is not None else load_checkpoint(checkpoint_path)
    class_symbol = resolve_model_class_symbol(checkpoint)
    if not class_symbol:
        raise RuntimeError("unable to resolve RF-DETR class from checkpoint metadata")

    model_class = import_class(class_symbol)
    return model_class(pretrain_weights=checkpoint_path)


def _as_positive_int(value):
    """Return value when it is a positive int, else None.

    Anything else (strings, floats, bools, index-like objects) counts as
    malformed metadata and falls through to weaker sources.
    """
    if isinstance(value, bool):
        return None
    if type(value) is not int:
        return None
    return value if value > 0 else None


def _field_from_container(container, key):
    if container is None:
        return None
    if isinstance(container, dict):
        return container.get(key)
    return getattr(container, key, None)


def _read_resolution_patch_windows(container, *, is_args=False):
    """Read (resolution, patch_size, num_windows) from a config-like container."""
    if container is None:
        return (None, None, None)
    if is_args:
        resolution = None
        for key in ("resolution", "imgsz", "img_size", "image_size"):
            candidate = _as_positive_int(_field_from_container(container, key))
            if candidate is not None:
                resolution = candidate
                break
    else:
        resolution = _as_positive_int(_field_from_container(container, "resolution"))
    patch_size = _as_positive_int(_field_from_container(container, "patch_size"))
    num_windows = _as_positive_int(_field_from_container(container, "num_windows"))
    return (resolution, patch_size, num_windows)


def _first_present(*pairs):
    """Return (value, source) for the first pair whose value is not None."""
    for value, source in pairs:
        if value is not None:
            return (value, source)
    return (None, None)


def infer_native_export_shape(checkpoint_path, model, checkpoint=None):
    import math

    try:
        checkpoint = checkpoint if checkpoint is not None else load_checkpoint(checkpoint_path)
    except Exception:
        checkpoint = None

    saved_container = None
    if isinstance(checkpoint, dict):
        saved_candidate = checkpoint.get("model_config")
        if isinstance(saved_candidate, dict):
            saved_container = saved_candidate
    saved_resolution, saved_patch, saved_windows = _read_resolution_patch_windows(saved_container)

    model_container = getattr(model, "model_config", None) if model is not None else None
    model_resolution, model_patch, model_windows = _read_resolution_patch_windows(model_container)

    args_container = checkpoint.get("args") if isinstance(checkpoint, dict) else None
    args_resolution, args_patch, args_windows = _read_resolution_patch_windows(
        args_container, is_args=True
    )

    # Strongest wins per field; weaker sources only fill gaps. Resolution
    # keeps checkpoint args ahead of the loaded-model default so custom
    # training resolutions survive; patch/windows prefer the loaded model
    # over args. The selected resolution is validated against the final
    # patch_size * num_windows below.
    patch_size, patch_source = _first_present(
        (saved_patch, "saved_model_config"),
        (model_patch, "model_config"),
        (args_patch, "args"),
    )
    num_windows, num_windows_source = _first_present(
        (saved_windows, "saved_model_config"),
        (model_windows, "model_config"),
        (args_windows, "args"),
    )
    required_multiple = (
        patch_size * num_windows
        if patch_size is not None and num_windows is not None
        else None
    )

    # Every resolution candidate must satisfy the block size. An invalid
    # stronger candidate falls through to the next valid source.
    candidates = []
    if saved_resolution is not None:
        candidates.append((saved_resolution, "saved_model_config"))
    if args_resolution is not None:
        candidates.append((args_resolution, "args"))
    if model_resolution is not None:
        candidates.append((model_resolution, "model_config"))

    resolution = None
    resolution_source = None
    token_grid = None
    for value, source in candidates:
        if required_multiple is not None and value % required_multiple != 0:
            continue
        resolution = value
        resolution_source = source
        token_grid = resolution // patch_size if patch_size else None
        break
    if resolution is None:
        # Weakest source: derive resolution from position embeddings. Only
        # accept it when divisible by the model block size; e.g. RF-DETR
        # Base reports 37x37 tokens at patch 14 (518px) but requires
        # multiples of 14*4=56, so 518 must stay incomplete.
        try:
            pos_emb = None
            if isinstance(checkpoint, dict):
                for weight_key in ("model", "state_dict"):
                    state = checkpoint.get(weight_key)
                    if isinstance(state, dict):
                        for key, value in state.items():
                            if isinstance(key, str) and key.endswith("embeddings.position_embeddings"):
                                pos_emb = value
                                break
                        if pos_emb is not None:
                            break
            if pos_emb is not None and patch_size and num_windows:
                num_tokens = int(pos_emb.shape[1]) - 1
                if num_tokens > 0:
                    tokens = int(math.isqrt(num_tokens))
                    if tokens > 0 and tokens * tokens == num_tokens:
                        candidate = tokens * patch_size
                        if candidate % (patch_size * num_windows) == 0:
                            resolution = candidate
                            token_grid = tokens
                            resolution_source = "position_embeddings"
        except (AttributeError, IndexError, TypeError, ValueError):
            pass

    if resolution is None:
        print("[rfdetr-inspect] source=failed", file=sys.stderr, flush=True)
        return {
            "recommended_imgsz": None,
            "patch_size": patch_size,
            "num_windows": num_windows,
            "required_multiple": required_multiple,
            "token_grid": None,
            "resolution_source": None,
            "patch_source": patch_source,
            "num_windows_source": num_windows_source,
        }

    print(
        "[rfdetr-inspect] source={} resolution={} patch_size={} num_windows={} required_multiple={} token_grid={}".format(
            resolution_source, resolution, patch_size, num_windows, required_multiple, token_grid
        ),
        file=sys.stderr,
        flush=True,
    )
    return {
        "recommended_imgsz": resolution,
        "patch_size": patch_size,
        "num_windows": num_windows,
        "required_multiple": required_multiple,
        "token_grid": token_grid,
        "resolution_source": resolution_source,
        "patch_source": patch_source,
        "num_windows_source": num_windows_source,
    }


def inspect_checkpoint(checkpoint_path):
    try:
        checkpoint = load_checkpoint(checkpoint_path)
        class_symbol = resolve_model_class_symbol(checkpoint)
        model = None
        if not class_symbol:
            model = load_model_for_inspect(checkpoint_path, checkpoint)
            class_symbol = model.__class__.__name__
        requires_plus = class_symbol in PLUS_ONLY_CLASSES
        family = class_family(class_symbol)
        success = family is not None and not requires_plus
        native = infer_native_export_shape(checkpoint_path, model, checkpoint)
        fully_saved = (
            native["resolution_source"] == "saved_model_config"
            and native["patch_source"] == "saved_model_config"
            and native["num_windows_source"] == "saved_model_config"
        )
        if model is None and not requires_plus and not fully_saved:
            # Checkpoint geometry is missing or weaker than the loaded model
            # configuration. The Rust command only reaches here after explicit
            # user trust, which load_model_for_inspect forwards when supported.
            # Re-resolve once with every source; precedence and validation
            # stay in infer_native_export_shape, the single owner.
            try:
                model = load_model_for_inspect(checkpoint_path, checkpoint)
            except Exception:
                model = None
            if model is not None:
                native = infer_native_export_shape(checkpoint_path, model, checkpoint)
        emit({
            "success": success,
            "class_symbol": class_symbol,
            "family": family,
            "size": class_size(class_symbol),
            "requires_plus": requires_plus,
            "is_legacy": class_symbol in LEGACY_CLASSES,
            "recommended_imgsz": native["recommended_imgsz"],
            "patch_size": native["patch_size"],
            "num_windows": native["num_windows"],
            "required_multiple": native["required_multiple"],
            "token_grid": native["token_grid"],
            "resolution_source": native["resolution_source"],
            "error": (
                f"{class_symbol} requires rfdetr_plus support and is not supported in v1."
                if requires_plus else None
            ),
        })
        return 0 if success else 2
    except Exception as exc:
        emit(empty_failure(str(exc)))
        return 1


def import_class(class_symbol):
    if class_symbol in PLUS_ONLY_CLASSES:
        raise RuntimeError(f"{class_symbol} requires rfdetr_plus support and is not supported in v1.")
    if class_symbol not in DETECTION_CLASSES and class_symbol not in SEGMENTATION_CLASSES:
        raise RuntimeError(f"unsupported RF-DETR class: {class_symbol}")
    module = __import__("rfdetr", fromlist=[class_symbol])
    return getattr(module, class_symbol)


def resolve_model(args):
    if args.variant_mode == "manual":
        model_class = import_class(args.manual_class_symbol)
        return model_class(pretrain_weights=args.checkpoint)
    return load_model_for_inspect(args.checkpoint)


def preload_tensorflow_before_rfdetr():
    """Avoid macOS ONNX/TensorFlow import-order deadlock (RF-DETR #1322/#1323)."""
    try:
        __import__("tensorflow")
    except ModuleNotFoundError as exc:
        if exc.name != "tensorflow":
            raise


def export_checkpoint(args):
    os.makedirs(args.output_dir, exist_ok=True)
    try:
        if args.route_id not in (
            "rfdetr.pth.onnx",
            "rfdetr.pth.engine",
            "rfdetr.pth.coreml",
            "rfdetr.pth.tflite",
            "rfdetr.pth.executorch",
        ):
            raise RuntimeError(f"unsupported RF-DETR route: {args.route_id}")

        if args.route_id == "rfdetr.pth.tflite":
            preload_tensorflow_before_rfdetr()
        model = resolve_model(args)
        shape = (args.imgsz, args.imgsz)
        kwargs = {
            "format": "onnx",
            "output_dir": args.output_dir,
            "shape": shape,
            "batch_size": args.batch,
        }
        if args.route_id == "rfdetr.pth.engine":
            kwargs["format"] = "tensorrt"
            kwargs["fp16"] = args.precision == "fp16"
        elif args.route_id == "rfdetr.pth.coreml":
            kwargs["format"] = "coreml"
            kwargs["coreml_precision"] = "float16" if args.precision == "fp16" else "float32"
        elif args.route_id == "rfdetr.pth.tflite":
            kwargs["format"] = "tflite"
            kwargs["quantization"] = args.precision
        elif args.route_id == "rfdetr.pth.executorch":
            kwargs["format"] = "executorch"
            kwargs["backend"] = "xnnpack"
        if args.route_id == "rfdetr.pth.onnx" and args.opset is not None:
            kwargs["opset_version"] = args.opset
        model.export(**kwargs)

        return 0
    except Exception as exc:
        text = str(exc)
        if "patch_size" in text or "num_windows" in text or "divisible" in text:
            print(
                "RF-DETR shape error: image size must be divisible by the selected model block size.",
                file=sys.stderr,
                flush=True,
            )
        print(text, file=sys.stderr, flush=True)
        return 1


def parse_args():
    parser = argparse.ArgumentParser(description="Vision Export Studio RF-DETR helper")
    sub = parser.add_subparsers(dest="mode", required=True)

    inspect_parser = sub.add_parser("inspect")
    inspect_parser.add_argument("--checkpoint", required=True)

    export_parser = sub.add_parser("export")
    export_parser.add_argument("--checkpoint", required=True)
    export_parser.add_argument("--route-id", required=True)
    export_parser.add_argument("--output-dir", required=True)
    export_parser.add_argument("--variant-mode", choices=["auto", "manual"], required=True)
    export_parser.add_argument("--manual-class-symbol", default="")
    export_parser.add_argument("--imgsz", type=int, required=True)
    export_parser.add_argument("--batch", type=int, required=True)
    export_parser.add_argument("--opset", type=int)
    # TensorRT 11.x lacks RF-DETR's FP16 builder flag, so fresh unbounded
    # rfdetr[tensorrt] installs downgrade FP16 to FP32 and emit a warning.
    export_parser.add_argument("--precision", choices=["fp16", "fp32", "int8"], default="fp32")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.mode == "inspect":
        return inspect_checkpoint(args.checkpoint)
    if args.variant_mode == "manual" and not args.manual_class_symbol:
        print("manual-class-symbol is required when variant-mode=manual", file=sys.stderr)
        return 1
    return export_checkpoint(args)


if __name__ == "__main__":
    raise SystemExit(main())
