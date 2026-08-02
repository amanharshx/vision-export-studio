import type { ExportOptions } from "@/lib/types";

export const RKNN_CHIPS = [
  "rk3588",
  "rk3576",
  "rk3566",
  "rk3568",
  "rk3562",
  "rv1103",
  "rv1106",
  "rv1103b",
  "rv1106b",
  "rk2118",
  "rv1126b",
] as const;

const RKNN_INT8_ONLY_CHIPS = new Set(["rv1103", "rv1103b", "rv1106", "rv1106b"]);

function normalizeRknnChip(chip: string): string {
  return chip.trim().toLowerCase();
}

export function isRknnInt8OnlyChip(chip: string): boolean {
  return RKNN_INT8_ONLY_CHIPS.has(normalizeRknnChip(chip));
}

export function normalizeOptionsForRoute(routeId: string, options: ExportOptions): ExportOptions {
  if (routeId !== "ultralytics.pt.rknn") return options;
  const chip = normalizeRknnChip(options.chip);
  const precision = isRknnInt8OnlyChip(chip) ? "int8" : options.precision;
  if (chip === options.chip && precision === options.precision) return options;
  return { ...options, chip, precision };
}
