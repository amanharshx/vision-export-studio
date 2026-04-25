import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle } from "lucide-react";
import { InputRow, OptionRow, useOptionSetter, type OptionsPanelProps } from "./_base";

export function ImxOptions({ route: _route, options, onOptionsChange }: OptionsPanelProps) {
  const set = useOptionSetter(options, onOptionsChange);

  return (
    <div className="space-y-5">
      {/* Model compatibility warning */}
      <div className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-sm text-amber-800">
          IMX500 export only supports <strong>YOLOv8n</strong> and{" "}
          <strong>YOLO11n</strong> (nano) models. Other architectures or sizes
          will fail during export.
        </p>
      </div>

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

      <OptionRow label="INT8 Quantization" description="Required for IMX500">
        <Switch checked disabled />
      </OptionRow>
    </div>
  );
}
