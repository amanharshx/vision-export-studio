export interface AppSettings {
  runtime_dir: string;
  setup_complete: boolean;
  python_path_override?: string;
}

export type FormatCategory = "source" | "intermediate" | "runtime" | "vendor";

export type PlatformLock = "any" | "linux" | "linux_x86_64" | "linux_windows" | "macos" | "windows";

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
  oneWay: boolean;
  lossy: boolean;
  notes: string;
  unsupportedNote?: string;
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
  optimize: boolean;
  nms: boolean;
  endToEnd: boolean;
  keras: boolean;
  opset: number | null;
  workspace: number | null;
  chip: string;
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

/**
 * Status values emitted by the Rust check_dependencies command (DepCheckResult.status).
 *
 * Rust sends this as a plain String field, so the union here documents the contract.
 *
 * Currently emitted by Rust:
 *   "ready"           — dependency found
 *   "missing_package" — pip package absent (hard required)
 *   "missing_binary"  — system binary absent on PATH
 *   "warning"         — optional dep absent; export will still work
 *   "unknown"         — probe could not run (python crashed / spawn failed)
 *
 * Reserved for Phase 5 platform gating (not yet emitted by Rust):
 *   "platform_unsupported" — route is locked to a platform the user is not on
 */
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
