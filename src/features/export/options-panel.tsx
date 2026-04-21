import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { RouteSpec } from "@/lib/types";

interface OptionsPanelProps {
  route: RouteSpec;
}

export function OptionsPanel({ route }: OptionsPanelProps) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="imgsz">Image size</Label>
          <Input id="imgsz" value="640" readOnly />
        </div>
        <div className="space-y-2">
          <Label htmlFor="batch">Batch</Label>
          <Input id="batch" value="1" readOnly />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <Label>Quality</Label>
          <span className="text-zinc-500">balanced</span>
        </div>
        <Slider value={[64]} max={100} step={1} disabled />
      </div>

      <div className="grid gap-3">
        {[
          ["FP16", route.supportsHalf],
          ["INT8", route.supportsInt8],
          ["Dynamic axes", route.supportsDynamic],
          ["Simplify graph", route.targetFormat === "onnx"],
        ].map(([label, enabled]) => (
          <div
            key={label as string}
            className="flex items-center justify-between rounded-md border border-zinc-900/10 bg-zinc-50 px-3 py-2"
          >
            <Label className="text-sm text-zinc-700">{label}</Label>
            <Switch checked={Boolean(enabled)} disabled />
          </div>
        ))}
      </div>
    </div>
  );
}
