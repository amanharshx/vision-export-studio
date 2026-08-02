import type { ExportOptions, PrecisionMode, ProviderId, RfDetrVariantMode } from "@/lib/types";
import { findRoute } from "@/lib/providers";

export interface CommandPreviewInput {
  providerId: ProviderId;
  routeId: string;
  targetFormat: string;
  sourcePath: string;
  options: ExportOptions;
  outputDir?: string;
  rfdetrVariantMode?: RfDetrVariantMode;
  rfdetrManualClassSymbol?: string;
}

export function quantizeForPrecision(precision: PrecisionMode): string {
  switch (precision) {
    case "fp32":
      return "32";
    case "fp16":
      return "16";
    case "int8":
      return "8";
    case "w8a16":
      return "w8a16";
    case "w8a32":
      return "w8a32";
  }
}

export function isCalibrationEligible(routeId: string, precision: PrecisionMode): boolean {
  const route = findRoute(routeId);
  if (!route) return false;
  return route.calibrationRecommendedFor.includes(precision);
}

export function buildCommandPreview(input: CommandPreviewInput): string {
  const { providerId, routeId, targetFormat, sourcePath, options, outputDir, rfdetrVariantMode, rfdetrManualClassSymbol } = input;

  if (providerId === "rfdetr") {
    const parts: string[] = [
      "python rfdetr_export_helper.py export",
      `--checkpoint ${sourcePath}`,
      `--route-id ${routeId}`,
      `--output-dir ${outputDir ?? "..."}`,
      `--variant-mode ${rfdetrVariantMode ?? "auto"}`,
      `--imgsz ${options.imgsz}`,
      `--batch ${options.batch}`,
    ];
    if (options.opset != null) {
      parts.push(`--opset ${options.opset}`);
    }
    if (rfdetrVariantMode === "manual" && rfdetrManualClassSymbol) {
      parts.push(`--manual-class-symbol ${rfdetrManualClassSymbol}`);
    }
    return parts.join(" \\\n  ");
  }

  const parts: string[] = [
    "yolo export",
    `model=${sourcePath}`,
    `format=${targetFormat}`,
    `imgsz=${options.imgsz}`,
    `batch=${options.batch}`,
  ];
  parts.push(`quantize=${quantizeForPrecision(options.precision)}`);
  if (isCalibrationEligible(routeId, options.precision) && options.calibrationData) {
    parts.push(`data=${options.calibrationData}`);
  }
  if (options.dynamic) parts.push("dynamic=True");
  if (options.simplify) parts.push("simplify=True");
  if (options.optimize) parts.push("optimize=True");
  if (options.nms) parts.push("nms=True");
  if (options.endToEnd) parts.push("end2end=True");
  if (options.keras) parts.push("keras=True");
  if (options.opset != null) parts.push(`opset=${options.opset}`);
  if (options.workspace != null) parts.push(`workspace=${options.workspace}`);
  if (routeId === "ultralytics.pt.rknn" && options.chip.trim()) {
    parts.push(`name=${options.chip.trim()}`);
  }

  return parts.join(" ");
}
