import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { InputRow, OptionRow, useOptionSetter, type OptionsPanelProps } from "./_base";

export function MnnOptions({ route: _route, options, onOptionsChange }: OptionsPanelProps) {
  const set = useOptionSetter(options, onOptionsChange);
  const int8On = options.int8;

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

      <OptionRow label="INT8 Quantization" description="Enable INT8 quantization">
        <Switch checked={options.int8} onCheckedChange={(v) => onOptionsChange({ ...options, int8: v, half: v ? false : options.half })} />
      </OptionRow>

      <OptionRow label="FP16 Half" description="Use FP16 half precision">
        <Switch checked={int8On ? false : options.half} disabled={int8On} onCheckedChange={(v) => set("half", v)} />
      </OptionRow>

      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 space-y-3">
        <p className="text-sm font-medium text-zinc-900">Post-processing</p>
        <OptionRow label="End-to-End" description="Use native NMS-free output when the model supports it">
          <Switch checked={options.endToEnd} onCheckedChange={(v) => set("endToEnd", v)} />
        </OptionRow>
      </div>
    </div>
  );
}
