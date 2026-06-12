import { Input } from "@/components/ui/input";
import { InputRow, type OptionsPanelProps } from "./_base";

export function RfDetrOptions({ options, onOptionsChange }: OptionsPanelProps) {
  return (
    <div className="space-y-4">
      <InputRow label="Image Size" description="Input image size in pixels (64–8192, must be divisible by 14/model block size)">
        <Input
          type="number"
          min={64}
          step={14}
          value={options.imgsz}
          onChange={(e) => onOptionsChange({ ...options, imgsz: Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </InputRow>
      <InputRow label="Batch" description="Export batch size (1–128)">
        <Input
          type="number"
          min={1}
          step={1}
          value={options.batch}
          onChange={(e) => onOptionsChange({ ...options, batch: Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </InputRow>
      <InputRow label="Opset" description="ONNX opset version (11–20)">
        <Input
          type="number"
          min={11}
          step={1}
          value={options.opset ?? 17}
          onChange={(e) => onOptionsChange({ ...options, opset: Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </InputRow>
      <p className="text-xs leading-5 text-zinc-500">
        RF-DETR image size must be divisible by 14 (model patch/block size). Invalid values fail with a helper error.
      </p>
    </div>
  );
}
