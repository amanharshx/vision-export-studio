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


def inspect_checkpoint(checkpoint_path):
    try:
        from rfdetr import from_checkpoint

        model = from_checkpoint(checkpoint_path)
        class_symbol = model.__class__.__name__
        requires_plus = class_symbol in PLUS_ONLY_CLASSES
        family = class_family(class_symbol)
        success = family is not None and not requires_plus
        emit({
            "success": success,
            "class_symbol": class_symbol,
            "family": family,
            "size": class_size(class_symbol),
            "requires_plus": requires_plus,
            "is_legacy": class_symbol in LEGACY_CLASSES,
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
    from rfdetr import from_checkpoint
    return from_checkpoint(args.checkpoint)


def export_checkpoint(args):
    os.makedirs(args.output_dir, exist_ok=True)
    try:
        model = resolve_model(args)
        shape = (args.imgsz, args.imgsz)
        if args.route_id in ("rfdetr.pth.onnx", "rfdetr.pth.engine"):
            kwargs = {
                "format": "onnx",
                "output_dir": args.output_dir,
                "shape": shape,
                "batch_size": args.batch,
            }
            if args.opset is not None:
                kwargs["opset_version"] = args.opset
            model.export(**kwargs)
        elif args.route_id == "rfdetr.pth.tflite":
            model.export(
                format="tflite",
                output_dir=args.output_dir,
                shape=shape,
                batch_size=args.batch,
            )
        else:
            raise RuntimeError(f"unsupported RF-DETR route: {args.route_id}")

        if args.route_id == "rfdetr.pth.engine":
            try:
                from rfdetr.export._tensorrt import trtexec
            except Exception as exc:
                raise RuntimeError(f"RF-DETR TensorRT wrapper unavailable: {exc}") from exc
            trtexec(os.path.join(args.output_dir, "inference_model.onnx"), Namespace(verbose=True, profile=False, dry_run=False))

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
