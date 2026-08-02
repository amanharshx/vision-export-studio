import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { openCalibrationDataPicker } from "@/lib/tauri/dialog";
import type { ExportOptions, PrecisionMode, RouteSpec } from "@/lib/types";
import { OptionRow } from "./_base";

export const PRECISION_LABELS: Record<PrecisionMode, string> = {
  fp32: "FP32",
  fp16: "FP16",
  int8: "INT8",
  w8a16: "W8A16",
  w8a32: "W8A32",
};

export const CALIBRATION_FALLBACK_WARNING =
  "No calibration dataset selected. Ultralytics will use its default dataset; accuracy may differ.";

export const CALIBRATION_SELECTED_LABEL = "Representative dataset YAML for this precision.";

interface PrecisionOptionsProps {
  route: RouteSpec;
  options: ExportOptions;
  onOptionsChange: (options: ExportOptions) => void;
}

export function PrecisionOptions({ route, options, onOptionsChange }: PrecisionOptionsProps) {
  const precisionItems = route.precisionModes.map((mode) => ({
    value: mode,
    label: PRECISION_LABELS[mode],
  }));
  const calibrationRecommended = route.calibrationRecommendedFor.includes(options.precision);

  return (
    <div className="space-y-3">
      <OptionRow label="Precision" description="Numerical format for the exported model">
        {precisionItems.length > 1 ? (
          <Select
            value={options.precision}
            onValueChange={(value) =>
              onOptionsChange({ ...options, precision: value as PrecisionMode })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Select precision" />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="end"
              className="w-(--radix-select-trigger-width) min-w-0"
            >
              {precisionItems.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  className="pr-1.5 [&>span:first-child]:hidden"
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm font-medium text-zinc-700">{precisionItems[0]?.label}</span>
        )}
      </OptionRow>

      {calibrationRecommended && (
        <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          {options.calibrationData ? (
            <>
              <p className="text-sm font-medium text-zinc-900">{CALIBRATION_SELECTED_LABEL}</p>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-xs text-zinc-700">
                  {options.calibrationData}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900"
                  onClick={() => onOptionsChange({ ...options, calibrationData: null })}
                >
                  Clear
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-amber-700">{CALIBRATION_FALLBACK_WARNING}</p>
              <button
                type="button"
                className="text-xs font-medium text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-900"
                onClick={async () => {
                  const path = await openCalibrationDataPicker();
                  if (path) onOptionsChange({ ...options, calibrationData: path });
                }}
              >
                Browse calibration dataset
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
