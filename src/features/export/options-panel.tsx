import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { openCalibrationDataPicker } from "@/lib/tauri/dialog";
import type { ExportOptions, RouteSpec } from "@/lib/types";

interface OptionsPanelProps {
  route: RouteSpec;
  options: ExportOptions;
  onOptionsChange: (options: ExportOptions) => void;
}

export function OptionsPanel({ route, options, onOptionsChange }: OptionsPanelProps) {
  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    onOptionsChange({ ...options, [key]: value });
  };

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="imgsz">Image size</Label>
          <Input
            id="imgsz"
            type="number"
            min={32}
            step={32}
            value={options.imgsz}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v > 0) set("imgsz", v);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="batch">Batch</Label>
          <Input
            id="batch"
            type="number"
            min={1}
            step={1}
            value={options.batch}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v > 0) set("batch", v);
            }}
          />
        </div>
      </div>

      <div className="grid gap-3">
        {(
          [
            ["FP16", "half", route.supportsHalf],
            ["INT8", "int8", route.supportsInt8],
            ["Dynamic axes", "dynamic", route.supportsDynamic],
            ["Simplify graph", "simplify", route.targetFormat === "onnx"],
          ] as [string, keyof ExportOptions, boolean][]
        ).map(([label, key, enabled]) => (
          <div
            key={label}
            className="flex items-center justify-between rounded-md border border-zinc-900/10 bg-zinc-50 px-3 py-2"
          >
            <Label className="text-sm text-zinc-700">{label}</Label>
            <Switch
              checked={options[key] as boolean}
              disabled={!enabled}
              onCheckedChange={(checked) => {
                if (enabled) set(key, checked);
              }}
            />
          </div>
        ))}
      </div>

      {route.needsCalibration && (!route.supportsInt8 || options.int8) && (
        <div className="grid gap-2">
          <Label>Calibration dataset</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={options.data || ""}
              placeholder="No dataset selected"
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                const result = await openCalibrationDataPicker();
                if (result !== null) set("data", result);
              }}
            >
              Browse
            </Button>
          </div>
          {!options.data && (
            <p className="text-xs text-destructive">
              Calibration dataset required for this export route.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
