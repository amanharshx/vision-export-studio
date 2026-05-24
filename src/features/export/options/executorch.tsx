import { Input } from "@/components/ui/input";
import { InputRow, useOptionSetter, type OptionsPanelProps } from "./_base";

export function ExecuTorchOptions({ route: _route, options, onOptionsChange }: OptionsPanelProps) {
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
    </div>
  );
}
