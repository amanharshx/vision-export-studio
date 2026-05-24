import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InputRow, useOptionSetter, type OptionsPanelProps } from "./_base";

const RKNN_CHIPS = [
  "rk3562",
  "rk3566",
  "rk3568",
  "rk3576",
  "rk3582",
  "rk3588",
  "rk3588s",
  "rv1103",
  "rv1103b",
  "rv1106",
  "rv1106b",
  "rv1109",
  "rv1126",
];

export function RknnOptions({ route: _route, options, onOptionsChange }: OptionsPanelProps) {
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

      <div className="space-y-1.5">
        <div>
          <p className="font-medium text-zinc-900">Chip</p>
          <p className="text-xs text-zinc-500">Rockchip processor type</p>
        </div>
        <Select value={options.chip} onValueChange={(v) => set("chip", v)}>
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
