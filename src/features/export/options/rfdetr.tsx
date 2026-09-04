import { Input } from "@/components/ui/input";
import { InputRow, type OptionsPanelProps } from "./_base";
import { PrecisionOptions } from "./precision";
import {
  RFDETR_IMGSZ_MIN,
  validateRfDetrImgsz,
} from "../rfdetr-image-size";

/** Standard presets offered as an explicit fallback when native size is unknown. */
const FALLBACK_PRESETS = [384, 512, 560, 576, 640, 704, 768];

export function getRfDetrFallbackImgsz(
  requiredMultiple?: number | null,
): number | null {
  if (requiredMultiple == null || requiredMultiple <= 0) return null;
  for (const preset of FALLBACK_PRESETS) {
    if (preset % requiredMultiple === 0) return preset;
  }
  return null;
}

export function RfDetrOptions({ route, options, onOptionsChange, recommendedImgsz, requiredMultiple }: OptionsPanelProps) {
  const multiple = requiredMultiple ?? null;
  const imgszError = validateRfDetrImgsz(options.imgsz, multiple);
  const isOverride = recommendedImgsz != null && options.imgsz !== recommendedImgsz;
  const fallback = recommendedImgsz == null ? getRfDetrFallbackImgsz(multiple) : null;
  // Align the native step base with the multiple so the browser's own
  // step validation agrees with the inline check (e.g. min 112 for 56).
  const min = multiple ? Math.ceil(RFDETR_IMGSZ_MIN / multiple) * multiple : RFDETR_IMGSZ_MIN;
  return (
    <div className="space-y-4">
      <InputRow label="Image Size" description={`Input image size in pixels (64–8192${multiple ? `, must be divisible by ${multiple}` : ""})`}>
        <Input
          type="number"
          min={min}
          step={multiple ?? 1}
          value={options.imgsz}
          onChange={(e) => onOptionsChange({ ...options, imgsz: Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </InputRow>
      {imgszError && (
        <p className="text-xs leading-5 text-red-700">
          {imgszError}
        </p>
      )}
      {recommendedImgsz != null && (
        <p className="text-xs leading-5 text-zinc-500">
          Native image size: {recommendedImgsz}px.
        </p>
      )}
      {recommendedImgsz != null && isOverride && !imgszError && (
        <p className="text-xs leading-5 text-amber-700">
          Non-native size resizes positional embeddings; accuracy may differ.
        </p>
      )}
      {recommendedImgsz != null && isOverride && (
        <button
          type="button"
          onClick={() => onOptionsChange({ ...options, imgsz: recommendedImgsz })}
          className="text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-950"
        >
          Reset to native {recommendedImgsz}px
        </button>
      )}
      {recommendedImgsz == null && multiple != null && fallback != null && (
        <div className="space-y-1.5">
          <p className="text-xs leading-5 text-zinc-500">
            Native size unavailable. Fallback preset: {fallback}px (must be divisible by {multiple}).
          </p>
          {options.imgsz !== fallback && (
            <button
              type="button"
              onClick={() => onOptionsChange({ ...options, imgsz: fallback })}
              className="text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-950"
            >
              Use fallback {fallback}px
            </button>
          )}
        </div>
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
      />
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
    </div>
  );
}
