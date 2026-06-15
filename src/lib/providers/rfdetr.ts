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

const rfdetrRoute = (spec: Omit<RouteSpec, "providerId" | "sourceFormat" | "sysDeps" | "platformLock" | "intermediates" | "requiresGpu" | "supportsHalf" | "supportsInt8" | "supportsDynamic" | "oneWay" | "lossy"> & Partial<RouteSpec>): RouteSpec => ({
  providerId: "rfdetr",
  sourceFormat: "pth",
  sysDeps: [],
  platformLock: "any",
  intermediates: [],
  requiresGpu: false,
  supportsHalf: false,
  supportsInt8: false,
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
    displayPath: "checkpoint.pth -> inference_model.onnx -> inference_model.engine",
    pipDeps: [{ packageName: "rfdetr[onnx]", installHint: 'pip install "rfdetr[onnx]"' }],
    sysDeps: [{ binaryName: "trtexec", installHint: "Install NVIDIA TensorRT and ensure trtexec is on PATH." }],
    platformLock: "linux_windows",
    intermediates: ["onnx"],
    requiresGpu: true,
    oneWay: true,
    lossy: true,
    notes: "Exports ONNX first, then compiles TensorRT engine for NVIDIA deployment hardware.",
    unsupportedNote: "TensorRT requires an NVIDIA GPU. NVIDIA does not support macOS.",
  }),
];
