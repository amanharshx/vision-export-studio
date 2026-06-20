export interface AppSettings {
  runtime_dir: string;
  setup_complete: boolean;
  python_path_override?: string;
  output_dir_override?: string;
}

export type ProviderId = "ultralytics" | "rfdetr";
export type SourceFormat = "pt" | "pth";

export interface ProviderDependency {
  packageName: string;
  installHint: string;
  optional?: boolean;
}

export interface ProviderSpec {
  id: ProviderId;
  displayName: string;
  shortName: string;
  sourceFormat: SourceFormat;
  sourceExtensions: string[];
  pickerFilterName: string;
  dropTitle: string;
  dropHelper: string;
  baseDeps: ProviderDependency[];
}

export type FormatCategory = "source" | "intermediate" | "runtime" | "vendor";

export type PlatformLock = "any" | "linux" | "linux_x86_64" | "linux_windows" | "macos" | "macos_linux" | "windows";

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
  providerId: ProviderId;
  sourceFormat: SourceFormat;
  targetFormat: string;
  title: string;
  displayPath: string;
  pipDeps: Array<{ packageName: string; installHint: string; optional?: boolean }>;
  sysDeps: Array<{ binaryName: string; installHint: string; optional?: boolean }>;
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
  experimental?: boolean;
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

export type ExportOptionsSource = "default" | "detected" | "user";

export interface RouteOptionsState {
  options: ExportOptions;
  source: ExportOptionsSource;
  sourcePath: string;
}

export type ExportStatus = "idle" | "starting" | "running" | "finished" | "failed" | "cancelled";

export type RfDetrInspectStatus =
  | "idle"
  | "needs_trust"
  | "inspecting"
  | "detected"
  | "failed"
  | "cancelled";

export type RfDetrVariantMode = "auto" | "manual";
export type RfDetrFamily = "detection" | "segmentation";

export interface RfDetrInspectResult {
  success: boolean;
  class_symbol: string | null;
  family: RfDetrFamily | null;
  size: string | null;
  requires_plus: boolean;
  is_legacy: boolean;
  recommended_imgsz: number | null;
  patch_size: number | null;
  token_grid: number | null;
  error: string | null;
}

export interface ExportLinePayload {
  session_id: string;
  line: string;
}

export interface ExportFinishedPayload {
  session_id: string;
  exit_code: number;
  artifact_moved: boolean;
  artifact_warning?: string;
  output_dir?: string;
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
  install_package?: string;
}

export interface DepCheckResponse {
  results: DepCheckResult[];
}

export type InstallPhase = "idle" | "pending_consent" | "installing" | "done" | "failed";

export interface InstallLinePayload {
  session_id: string;
  line: string;
}

export interface InstallFinishedPayload {
  session_id: string;
}

export interface InstallFailedPayload {
  session_id: string;
  error: string;
}
