import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { listGpus, type GpuInfo } from "@/lib/tauri/gpu";
import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { InputRow, OptionRow, useOptionSetter, type OptionsPanelProps } from "./_base";

export function TensorRtOptions({ route: _route, options, onOptionsChange }: OptionsPanelProps) {
  const set = useOptionSetter(options, onOptionsChange);
  const int8On = options.int8;
  const showBatchWarn = int8On && options.dynamic && options.batch === 1;

  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [selectedGpu, setSelectedGpu] = useState<string>("");

  useEffect(() => {
    listGpus().then((list) => {
      setGpus(list);
      if (list.length > 0) setSelectedGpu(list[0].name);
    });
  }, []);

  const selected = gpus.find((g) => g.name === selectedGpu);

  return (
    <div className="space-y-5">
      {/* Target GPU */}
      <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
        <div className="flex items-center gap-1.5">
          <Cpu className="h-4 w-4 text-zinc-500" />
          <p className="font-medium text-zinc-900">Target GPU</p>
        </div>
        <p className="text-xs text-zinc-500">
          TensorRT engines are compiled for a specific GPU. Inference requires the same TensorRT version and compatible GPU used during export.
        </p>
        {gpus.length > 0 ? (
          <>
            <Select value={selectedGpu} onValueChange={setSelectedGpu}>
              <SelectTrigger>
                <SelectValue placeholder="Select GPU" />
              </SelectTrigger>
              <SelectContent>
                {gpus.map((g) => (
                  <SelectItem key={g.name} value={g.name}>
                    {g.name}{g.vramGb != null ? ` — ${g.vramGb} GB` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <p className="text-xs text-zinc-500">
                Selected: {selected.name}{selected.vramGb != null ? ` (${selected.vramGb} GB VRAM)` : ""}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-zinc-400 italic">No GPUs detected</p>
        )}
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
        {showBatchWarn && (
          <p className="text-xs text-amber-600">INT8 calibration with dynamic shapes needs batch ≥ 16.</p>
        )}
      </InputRow>

      <OptionRow label="INT8 Quantization" description="Enable INT8 quantization">
        <Switch checked={options.int8} onCheckedChange={(v) => onOptionsChange({ ...options, int8: v, half: v ? false : options.half })} />
      </OptionRow>

      <OptionRow label="FP16 Half" description="Use FP16 half precision">
        <Switch checked={int8On ? false : options.half} disabled={int8On} onCheckedChange={(v) => set("half", v)} />
      </OptionRow>

      <OptionRow label="Dynamic" description="Dynamic input shapes">
        <Switch checked={options.dynamic} onCheckedChange={(v) => set("dynamic", v)} />
      </OptionRow>

      <OptionRow label="Simplify" description="Simplify ONNX graph">
        <Switch checked={options.simplify} onCheckedChange={(v) => set("simplify", v)} />
      </OptionRow>

      <InputRow label="Workspace (GB)" description="TensorRT workspace size (1–16, leave blank for auto)">
        <Input
          type="number"
          min={1}
          max={16}
          placeholder="auto"
          value={options.workspace ?? ""}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            set("workspace", isNaN(v) ? null : v);
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
