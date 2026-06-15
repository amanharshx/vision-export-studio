import type { ExportOptions, ProviderId, RfDetrVariantMode } from "@/lib/types";

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
  if (options.half) parts.push("half=True");
  if (options.int8) parts.push("int8=True");
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
