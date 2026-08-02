import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ExportOptions, PrecisionMode } from "@/lib/types";
import { InputRow, useOptionSetter, type OptionsPanelProps } from "./_base";
import { PrecisionOptions } from "./precision";

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

export function normalizeRknnChip(chip: string): string {
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

export function RknnOptions({ route, options, onOptionsChange }: OptionsPanelProps) {
  const set = useOptionSetter(options, onOptionsChange);
  const precisionModes: PrecisionMode[] = isRknnInt8OnlyChip(options.chip)
    ? ["int8"]
    : route.precisionModes;
  const precisionRoute = { ...route, precisionModes };

  return (
    <div className="space-y-5">
      <InputRow label="Image Size" description="Input image size in pixels (32–8192)">
        <Input
          type="number"
          min={32}
          step={1}
          value={options.imgsz}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) set("imgsz", v);
          }}
        />
      </InputRow>

      <InputRow label="Batch Size" description="Batch size for inference (1–32)">
        <Input
          type="number"
          min={1}
          step={1}
          value={options.batch}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) set("batch", v);
          }}
        />
      </InputRow>

      <PrecisionOptions route={precisionRoute} options={options} onOptionsChange={onOptionsChange} />

      <div className="space-y-1.5">
        <div>
          <p className="font-medium text-zinc-900">Chip</p>
          <p className="text-xs text-zinc-500">Rockchip processor type</p>
        </div>
        <Select
          value={options.chip}
          onValueChange={(value) => {
            const chip = normalizeRknnChip(value);
            onOptionsChange({
              ...options,
              chip,
              precision: isRknnInt8OnlyChip(chip) ? "int8" : options.precision,
            });
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select chip" />
          </SelectTrigger>
          <SelectContent>
            {RKNN_CHIPS.map((chip) => (
              <SelectItem key={chip} value={chip}>
                {chip}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
