import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { InputRow, OptionRow, useOptionSetter, type OptionsPanelProps } from "./_base";

export function OnnxOptions({ route: _route, options, onOptionsChange }: OptionsPanelProps) {
  const set = useOptionSetter(options, onOptionsChange);

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

      <OptionRow label="FP16 Half" description="Use FP16 half precision">
        <Switch checked={options.half} onCheckedChange={(v) => set("half", v)} />
      </OptionRow>

      <OptionRow label="Dynamic" description="Dynamic input shapes">
        <Switch checked={options.dynamic} onCheckedChange={(v) => set("dynamic", v)} />
      </OptionRow>

      <OptionRow label="Simplify" description="Simplify ONNX graph">
        <Switch checked={options.simplify} onCheckedChange={(v) => set("simplify", v)} />
      </OptionRow>

      <InputRow label="Opset" description="ONNX opset version (9–23, leave blank for auto)">
        <Input
          type="number"
          min={9}
          max={23}
          placeholder="auto"
          value={options.opset ?? ""}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            set("opset", isNaN(v) ? null : v);
          }}
        />
      </InputRow>

      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 space-y-3">
        <p className="text-sm font-medium text-zinc-900">Post-processing</p>
        <OptionRow label="End-to-End" description="Use native NMS-free output when the model supports it">
          <Switch checked={options.endToEnd} onCheckedChange={(v) => set("endToEnd", v)} />
        </OptionRow>
        <OptionRow label="Embed NMS" description="Include NMS in the exported model">
          <Switch checked={options.nms} onCheckedChange={(v) => set("nms", v)} />
        </OptionRow>
      </div>
    </div>
  );
}
