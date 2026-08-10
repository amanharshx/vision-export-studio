import { Input } from "@/components/ui/input";
import { openCalibrationDirectoryPicker } from "@/lib/tauri/dialog";
import { InputRow, type OptionsPanelProps } from "./_base";
import { PrecisionOptions } from "./precision";

export function RfDetrOptions({ route, options, onOptionsChange, recommendedImgsz, patchSize }: OptionsPanelProps) {
  return (
    <div className="space-y-4">
      <InputRow label="Image Size" description={`Input image size in pixels (64–8192${patchSize ? `, must be divisible by ${patchSize}` : ""})`}>
        <Input
          type="number"
          min={64}
          step={patchSize ?? 1}
          value={options.imgsz}
          onChange={(e) => onOptionsChange({ ...options, imgsz: Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </InputRow>
      {recommendedImgsz != null && (
        <p className="text-xs leading-5 text-zinc-500">
          Recommended native image size: {recommendedImgsz}px.
        </p>
      )}
      {recommendedImgsz != null && options.imgsz !== recommendedImgsz && (
        <p className="text-xs leading-5 text-amber-700">
          Non-native image size may force positional embedding resize and can break ONNX export.
        </p>
      )}
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
      <PrecisionOptions
        route={route}
        options={options}
        onOptionsChange={onOptionsChange}
        label={route.targetFormat === "tflite" ? "Quantization" : undefined}
        hideCalibration={route.targetFormat === "tflite"}
      />
      {route.targetFormat === "tflite" && options.precision === "int8" && (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <InputRow label="Calibration data" description="Directory of calibration images. Without it, RF-DETR uses random noise and accuracy degrades.">
            <button
              type="button"
              className="text-xs font-medium text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-900"
              onClick={async () => {
                const path = await openCalibrationDirectoryPicker();
                if (path) onOptionsChange({ ...options, calibrationData: path });
              }}
            >
              {options.calibrationData ? "Change calibration directory" : "Browse calibration directory"}
            </button>
          </InputRow>
          {options.calibrationData && <p className="truncate font-mono text-xs text-zinc-700">{options.calibrationData}</p>}
          <InputRow label="Max images" description="Maximum calibration images (upstream default: 100).">
            <Input
              type="number"
              min={1}
              step={1}
              value={options.maxImages ?? 100}
              onChange={(e) => onOptionsChange({ ...options, maxImages: Number(e.target.value) })}
              className="h-8 w-20 text-xs"
            />
          </InputRow>
        </div>
      )}
      {route.targetFormat === "onnx" && (
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
      )}
      <p className="text-xs leading-5 text-zinc-500">
        {patchSize
          ? `RF-DETR image size must be divisible by ${patchSize} (model patch size).`
          : "Use checkpoint-native image size when possible."}
      </p>
    </div>
  );
}
