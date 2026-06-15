#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
from argparse import Namespace

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
        "token_grid": None,
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
        return from_checkpoint(checkpoint_path)

    checkpoint = checkpoint if checkpoint is not None else load_checkpoint(checkpoint_path)
    class_symbol = resolve_model_class_symbol(checkpoint)
    if not class_symbol:
        raise RuntimeError("unable to resolve RF-DETR class from checkpoint metadata")

    model_class = import_class(class_symbol)
    return model_class(pretrain_weights=checkpoint_path)


def resolve_patch_size(model):
    model_config = getattr(model, "model_config", None)
    patch_size = getattr(model_config, "patch_size", None)
    if patch_size is None:
        patch_size = 16
    return int(patch_size)


def infer_native_export_shape(checkpoint_path, model, checkpoint=None):
    import math

    # primary: model.model_config
    try:
        cfg = model.model_config
        resolution = int(cfg.resolution)
        patch_size = int(cfg.patch_size)
        if resolution > 0 and patch_size > 0:
            token_grid = resolution // patch_size
            print(
                "[rfdetr-inspect] source=model_config resolution={} patch_size={} token_grid={}".format(
                    resolution, patch_size, token_grid
                ),
                file=sys.stderr,
                flush=True,
            )
            return {
                "recommended_imgsz": resolution,
                "patch_size": patch_size,
                "token_grid": token_grid,
            }
    except Exception:
        pass

    # fallback: checkpoint args / position_embeddings
    try:
        checkpoint = checkpoint if checkpoint is not None else load_checkpoint(checkpoint_path)

        # try args
        args = checkpoint.get("args")
        if args is not None:
            resolution = None
            if hasattr(args, "resolution"):
                resolution = int(args.resolution)
            elif isinstance(args, dict):
                if "resolution" in args:
                    resolution = int(args["resolution"])
                else:
                    for key in ("imgsz", "img_size", "image_size"):
                        if key in args:
                            resolution = int(args[key])
                            break
            if resolution is not None:
                patch_size = resolve_patch_size(model)
                print(
                    "[rfdetr-inspect] source=args resolution={} patch_size={} token_grid={}".format(
                        resolution,
                        patch_size,
                        resolution // patch_size,
                    ),
                    file=sys.stderr,
                    flush=True,
                )
                return {
                    "recommended_imgsz": resolution,
                    "patch_size": patch_size,
                    "token_grid": resolution // patch_size,
                }

        # try position embeddings
        state_dict = checkpoint.get("state_dict") if isinstance(checkpoint.get("state_dict"), dict) else None
        model_dict = checkpoint.get("model") if isinstance(checkpoint.get("model"), dict) else None

        pos_emb = None
        for state, key in (
            (model_dict, "backbone.0.encoder.encoder.embeddings.position_embeddings"),
            (state_dict, "model.backbone.0.encoder.encoder.embeddings.position_embeddings"),
        ):
            if isinstance(state, dict) and key in state:
                pos_emb = state[key]
                break

        if pos_emb is not None:
            num_tokens = int(pos_emb.shape[1]) - 1
            tokens = int(math.isqrt(num_tokens))
            patch_size = resolve_patch_size(model)
            recommended = tokens * patch_size
            print(
                "[rfdetr-inspect] source=position_embeddings tokens={} patch_size={} recommended={}".format(
                    tokens,
                    patch_size,
                    recommended,
                ),
                file=sys.stderr,
                flush=True,
            )
            return {
                "recommended_imgsz": recommended,
                "patch_size": patch_size,
                "token_grid": tokens,
            }
    except Exception:
        pass

    print("[rfdetr-inspect] source=failed", file=sys.stderr, flush=True)
    return {"recommended_imgsz": None, "patch_size": None, "token_grid": None}


def inspect_checkpoint(checkpoint_path):
    try:
        checkpoint = load_checkpoint(checkpoint_path)
        model = load_model_for_inspect(checkpoint_path, checkpoint)
        class_symbol = model.__class__.__name__
        requires_plus = class_symbol in PLUS_ONLY_CLASSES
        family = class_family(class_symbol)
        success = family is not None and not requires_plus
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
            "token_grid": native["token_grid"],
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


def resolve_exported_onnx(output_dir, exported):
    """Locate the ONNX file produced by ``model.export(format="onnx")``.

    rf-detr's output filename is version-dependent: 1.6.x writes
    ``inference_model.onnx`` while 1.7.x writes ``rfdetr-<variant>.onnx``
    (PR #910). Older ``export()`` returns ``None``; newer returns the ``Path``.
    Resolve in this order so TensorRT conversion finds the right file on any
    version, and never picks the GridSample-patched intermediate
    (``*_gs_patched.onnx``) used by the TFLite path.
    """
    # 1) Trust the return value when it is a real .onnx path.
    if exported:
        candidate = str(exported)
        if candidate.endswith(".onnx") and os.path.isfile(candidate):
            return candidate

    # 2) Canonical 1.6.x name.
    legacy = os.path.join(output_dir, "inference_model.onnx")
    if os.path.isfile(legacy):
        return legacy

    # 3) Any .onnx in the dir, preferring non-_gs_patched files.
    import glob

    onnx_files = sorted(glob.glob(os.path.join(output_dir, "*.onnx")))
    preferred = [f for f in onnx_files if "_gs_patched" not in os.path.basename(f)]
    pool = preferred or onnx_files
    if pool:
        return pool[0]

    raise RuntimeError(
        f"could not locate an exported ONNX file for TensorRT conversion in {output_dir}"
    )


def export_checkpoint(args):
    os.makedirs(args.output_dir, exist_ok=True)
    try:
        if args.route_id not in ("rfdetr.pth.onnx", "rfdetr.pth.engine"):
            raise RuntimeError(f"unsupported RF-DETR route: {args.route_id}")

        model = resolve_model(args)
        shape = (args.imgsz, args.imgsz)
        exported = None
        kwargs = {
            "format": "onnx",
            "output_dir": args.output_dir,
            "shape": shape,
            "batch_size": args.batch,
        }
        if args.opset is not None:
            kwargs["opset_version"] = args.opset
        exported = model.export(**kwargs)

        if args.route_id == "rfdetr.pth.engine":
            try:
                from rfdetr.export._tensorrt import trtexec
            except Exception as exc:
                raise RuntimeError(f"RF-DETR TensorRT wrapper unavailable: {exc}") from exc
            onnx_path = resolve_exported_onnx(args.output_dir, exported)
            print(f"[rfdetr-export] TensorRT input ONNX: {onnx_path}", file=sys.stderr, flush=True)
            trtexec(onnx_path, Namespace(verbose=True, profile=False, dry_run=False))

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
