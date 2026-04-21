export type FormatCategory = "source" | "intermediate" | "runtime" | "vendor";

export type PlatformLock = "any" | "linux" | "linux_x86_64" | "not_windows" | "macos";

export interface FormatSpec {
  id: string;
  name: string;
  suffixes: string[];
  category: FormatCategory;
  canBeSource: boolean;
  canBeTarget: boolean;
  oneWay: boolean;
  platformLocked: boolean;
  notes?: string;
}

export interface RouteSpec {
  id: string;
  providerId: "ultralytics";
  sourceFormat: "pt";
  targetFormat: string;
  title: string;
  displayPath: string;
  pipDeps: Array<{ packageName: string; installHint: string }>;
  sysDeps: Array<{ binaryName: string; installHint: string }>;
  platformLock: PlatformLock;
  intermediates: string[];
  requiresGpu: boolean;
  supportsHalf: boolean;
  supportsInt8: boolean;
  supportsDynamic: boolean;
  needsCalibration: boolean;
  oneWay: boolean;
  lossy: boolean;
  notes: string;
}

export interface ExportOptions {
  imgsz: number;
  batch: number;
  half: boolean;
  int8: boolean;
  dynamic: boolean;
  simplify: boolean;
  nms: boolean;
  opset: number | null;
  data: string;
  name: string;
}
