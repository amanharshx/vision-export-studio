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

export type EnvironmentStatus = "ok" | "partial" | "missing" | "loading" | "error";

export interface EnvironmentInfo {
  python_path: string;
  python_version: string;
  ultralytics_version: string;
  yolo_path: string;
  status: EnvironmentStatus;
  warnings: string[];
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

export type ExportStatus = "idle" | "running" | "finished" | "failed" | "cancelled";

export interface ExportLinePayload {
  session_id: string;
  line: string;
}

export interface ExportFinishedPayload {
  session_id: string;
  exit_code: number;
}

export interface ExportFailedPayload {
  session_id: string;
  error: string;
}

export interface ExportCancelledPayload {
  session_id: string;
}

export type DepCheckStatus =
  | "ready"
  | "missing_package"
  | "missing_binary"
  | "platform_unsupported"
  | "warning"
  | "unknown";

export interface DepCheckResult {
  item: string;
  status: DepCheckStatus;
  reason: string;
  install_hint: string;
}

export interface DepCheckResponse {
  results: DepCheckResult[];
}
