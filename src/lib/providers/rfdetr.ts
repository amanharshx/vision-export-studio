import type { ProviderSpec, RouteSpec } from "@/lib/types";

export const rfdetrProvider: ProviderSpec = {
  id: "rfdetr",
  displayName: "Roboflow RF-DETR",
  shortName: "RF-DETR",
  sourceFormat: "pth",
  sourceExtensions: [".pth"],
  pickerFilterName: "RF-DETR Checkpoint",
  dropTitle: "Drop .pth checkpoint",
  dropHelper: "Local Roboflow RF-DETR export using the selected Python environment.",
  baseDeps: [],
};

const rfdetrRoute = (spec: Omit<RouteSpec, "providerId" | "sourceFormat" | "sysDeps" | "platformLock" | "intermediates" | "requiresGpu" | "precisionModes" | "defaultPrecision" | "calibrationRecommendedFor" | "supportsDynamic" | "oneWay" | "lossy"> & Partial<RouteSpec>): RouteSpec => ({
  providerId: "rfdetr",
  sourceFormat: "pth",
  sysDeps: [],
  platformLock: "any",
  intermediates: [],
  requiresGpu: false,
  precisionModes: ["fp32"],
  defaultPrecision: "fp32",
  calibrationRecommendedFor: [],
  supportsDynamic: false,
  oneWay: false,
  lossy: false,
  ...spec,
});

export const rfdetrRoutes: RouteSpec[] = [
  rfdetrRoute({
    id: "rfdetr.pth.onnx",
    targetFormat: "onnx",
    title: "ONNX",
    displayPath: "checkpoint.pth -> inference_model.onnx",
    pipDeps: [{ packageName: "rfdetr[onnx]", installHint: 'pip install "rfdetr[onnx]"' }],
    notes: "Recommended RF-DETR export target and primary validation path.",
  }),
  rfdetrRoute({
    id: "rfdetr.pth.engine",
    targetFormat: "engine",
    title: "TensorRT via ONNX",
    displayPath: "checkpoint.pth -> inference_model_fp16.trt",
    pipDeps: [{ packageName: "rfdetr[tensorrt]", installHint: 'pip install "rfdetr[tensorrt]"' }],
    platformLock: "linux_windows",
    intermediates: ["onnx"],
    requiresGpu: true,
    oneWay: true,
    lossy: true,
    notes: "Uses RF-DETR's native TensorRT export for NVIDIA deployment hardware.",
    unsupportedNote: "TensorRT requires an NVIDIA GPU. NVIDIA does not support macOS.",
  }),
];
