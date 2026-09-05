import { detectEnvironment } from "@/lib/tauri/environment";
import { listStackEnvironments } from "@/lib/tauri/stack-environments";
import { captureAnalyticsEvent } from "@/lib/analytics";
import { checkDependencies, installDependencies } from "@/lib/tauri/deps";
import { cancelExport, openExportFolder, startExport } from "@/lib/tauri/export";
import { defaultRouteForProvider, findRoute, hasAllowedSourceExtension, providers, providerList, routesForProvider } from "@/lib/providers";
import { inspectRfDetrCheckpoint } from "@/lib/tauri/rfdetr";
import { cleanupManagedEnvironments } from "@/lib/tauri/managed-environments";
import { useManagedEnvironmentInventory } from "./use-managed-environment-inventory";
import { architectureMatters, type AppOS, type AppPlatform, getOS, incompatibleReason, isCompatible, UNKNOWN_ARCH } from "@/lib/platform";
import { getAppTelemetryContext, getRoutePlatformSupport, type HostSupportResult } from "@/lib/tauri/app";
import { createListenerGroup, type ListenerGroup } from "@/lib/tauri/listener-group";
import { useSetupTask } from "@/features/setup/setup-task-context";
import {
  isSetupTaskActive,
  runInstallStream,
  SETUP_CONFLICT_MESSAGE,
  type InstallOutcome,
} from "@/features/setup/setup-task";
import type {
  DepCheckResult,
  EnvironmentInfo,
  InstallableDependency,
  ExportCancelledPayload,
  ExportFailedPayload,
  ExportFinishedPayload,
  ExportLinePayload,
  ExportOptions,
  ExportOptionsSource,
  ExportStatus,
  InstallFailedPayload,
  InstallFinishedPayload,
  InstallLinePayload,
  InstallPhase,
  ManagedEnvironmentCleanupReport,
  ManagedEnvironmentCleanupResult,
  ManagedEnvironmentKey,
  ManagedEnvironmentScanResult,
  ProviderId,
  RfDetrInspectResult,
  RfDetrInspectStatus,
  RfDetrVariantMode,
  RouteOptionsState,
  RouteSpec,
  StackEnvironment,
} from "@/lib/types";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, FileBox, FolderOpen, Info, RefreshCw, RotateCcw, X, CircleHelp, BadgeCheck, CircleX, CircleDashed, TriangleAlert } from "lucide-react";
import { UpdateChecker } from "@/components/update-checker";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  getManagedRuntimeRebuildEligibility,
  loadSettings,
  rebuildManagedRuntime,
  savePythonOverride,
  saveOutputDirOverride,
} from "@/lib/tauri/setup";
import type { ManagedRuntimeRebuildEligibility } from "@/lib/tauri/setup";
import { openPythonExecutablePicker, openOutputDirPicker } from "@/lib/tauri/dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UpdaterController } from "@/features/updater/use-updater-controller";

import { DropZone } from "./drop-zone";
import { ExportModal } from "./export-modal";
import { RouteGrid } from "./route-grid";
import { getEffectiveHostSupportResult, getHostSupportResult } from "./host-support";
import { normalizeOptionsForRoute } from "./options/normalize";
import { validateRfDetrImgsz } from "./rfdetr-image-size";

type WorkspaceView = "drop" | "formats";
type RuntimeInstallPhase = "idle" | "installing" | "ready" | "failed";

export function getManagedRuntimeUpgradeNudge(
  eligibility: ManagedRuntimeRebuildEligibility | null,
  mayStart = true,
): string | null {
  if (!eligibility?.eligible || !eligibility.candidate_version || !mayStart) return null;
  return `Python ${eligibility.candidate_version} is available. Set up a new export runtime with it?`;
}

// Exported separately: Radix portals render nothing in SSR; this keeps the dialog body testable.
export function ManagedRuntimeUpgradeDialogBody({
  candidateVersion,
  rebuilding,
  lines,
  error,
  mayStart,
  onCancel,
  onContinue,
}: {
  candidateVersion: string | null;
  rebuilding: boolean;
  lines: string[];
  error: string | null;
  mayStart: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const version = candidateVersion ?? "a compatible Python";
  const steps = [
    `Create a new export environment using Python ${version}`,
    "Keep your current runtime if setup fails",
    "Switch over once the new environment is verified",
  ];
  const note = "Export-format packages install when you next use them. This may take a few minutes.";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Set up a new export runtime?</DialogTitle>
        <DialogDescription className="space-y-3">
          <p>This will:</p>
          <ul className="list-disc space-y-1 pl-5">
            {steps.map((step) => <li key={step}>{step}</li>)}
          </ul>
          <p>{note}</p>
        </DialogDescription>
      </DialogHeader>
      {rebuilding && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
          {lines.join("\n") || "[info] Setting up new export runtime..."}
        </div>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={rebuilding}>
          Cancel
        </Button>
        <Button onClick={onContinue} disabled={!mayStart}>
          {rebuilding ? "Setting up..." : "Continue"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ManagedRuntimeUpgradeDialog({
  open,
  onOpenChange,
  ...bodyProps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<Parameters<typeof ManagedRuntimeUpgradeDialogBody>[0], "onCancel">) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!bodyProps.rebuilding}>
        <ManagedRuntimeUpgradeDialogBody {...bodyProps} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function getUltralyticsRuntimeDisabledReason(runtimeInstallPhase: RuntimeInstallPhase): string | undefined {
  return runtimeInstallPhase === "installing"
    ? undefined
    : "Install the Ultralytics runtime before choosing a YOLO export target.";
}

const defaultOptions: ExportOptions = {
  imgsz: 640,
  batch: 1,
  precision: "fp32",
  calibrationData: null,
  dynamic: false,
  simplify: false,
  optimize: false,
  nms: false,
  endToEnd: false,
  keras: false,
  opset: null,
  workspace: null,
  chip: "rk3588",
};

const routeDefaults: Partial<Record<string, Partial<ExportOptions>>> = {
  "ultralytics.pt.onnx": { simplify: true },
  "ultralytics.pt.engine": { simplify: true },
};

function optionsForRoute(route: RouteSpec): ExportOptions {
  return normalizeOptionsForRoute(route.id, {
    ...defaultOptions,
    ...(routeDefaults[route.id] ?? {}),
    precision: route.defaultPrecision,
    calibrationData: null,
  });
}

export function getResolvedOutputDir(sourcePath: string, outputDirOverride: string): string {
  const out = outputDirOverride.trim();
  if (out) return out;
  const sep = sourcePath.includes("/") ? "/" : "\\";
  const lastSep = sourcePath.lastIndexOf(sep);
  const parentDir = lastSep > 0 ? sourcePath.substring(0, lastSep) : "";
  return parentDir ? `${parentDir}${sep}vision-export-studio-exports` : "";
}

export function withRfDetrDetectedDefaults(
  base: ExportOptions,
  providerId: ProviderId,
  inspect: RfDetrInspectResult | null,
): ExportOptions {
  if (providerId !== "rfdetr") return base;
  if (!inspect?.success || !inspect.recommended_imgsz) return base;
  return { ...base, imgsz: inspect.recommended_imgsz };
}

export function formatManagedEnvironmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024 || nextUnit === units[units.length - 1]) break;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${unit}`;
}

export function isManagedEnvironmentCleanupAllowed(
  result: ManagedEnvironmentScanResult | undefined,
): boolean {
  return result?.status === "available" || result?.status === "unavailable";
}

export function mergeManagedEnvironmentScanResults(
  existing: Record<string, ManagedEnvironmentScanResult>,
  incoming: ManagedEnvironmentScanResult[],
): Record<string, ManagedEnvironmentScanResult> {
  const next = { ...existing };
  for (const result of incoming) {
    const previous = next[result.key];
    if (previous?.status === "available" && result.status === "calculating") continue;
    next[result.key] = result;
  }
  return next;
}

export function invalidateManagedEnvironmentSizes(
  existing: Record<string, ManagedEnvironmentScanResult>,
  keys?: ManagedEnvironmentKey[],
): Record<string, ManagedEnvironmentScanResult> {
  if (!keys) return {};
  const next = { ...existing };
  for (const key of keys) delete next[key];
  return next;
}

/**
 * Drops rows that are still stuck in the transient `calculating` state for the
 * given keys. Used to recover after a command-level scan failure so affected
 * cards do not remain stuck on "Calculating…".
 */
export function clearCalculatingManagedEnvironmentScan(
  existing: Record<string, ManagedEnvironmentScanResult>,
  keys: (ManagedEnvironmentKey | string)[],
): Record<string, ManagedEnvironmentScanResult> {
  const next = { ...existing };
  for (const key of keys) {
    if (next[key]?.status === "calculating") delete next[key];
  }
  return next;
}

/**
 * Expands the requested cleanup keys into the concrete size-cache keys that
 * must be invalidated after a deletion. `rfdetr-all` is a virtual selector, so
 * it fans out to every known stack key alongside the direct keys.
 */
export function managedEnvironmentCacheKeysForCleanup(
  keys: ManagedEnvironmentKey[],
  stackKeys: string[],
): ManagedEnvironmentKey[] {
  const result = new Set<string>(keys);
  if (keys.includes("rfdetr-all")) {
    for (const stackKey of stackKeys) result.add(stackKey);
  }
  return [...result] as ManagedEnvironmentKey[];
}

export interface ManagedEnvironmentScanCacheState {
  generation: number;
  sizes: Record<string, ManagedEnvironmentScanResult>;
}

/**
 * Single mutation-invalidation reducer shared by every flow that changes an
 * environment on disk (dependency/runtime install, managed runtime rebuild,
 * and environment deletion). Bumping the generation makes any in-flight scan
 * result stale, and dropping the affected keys forces a fresh size scan.
 */
export function applyManagedEnvironmentSizeMutation(
  state: ManagedEnvironmentScanCacheState,
  keys?: ManagedEnvironmentKey[],
): ManagedEnvironmentScanCacheState {
  const next = invalidateManagedEnvironmentSizes(state.sizes, keys);
  for (const [key, result] of Object.entries(next)) {
    if (result.status === "calculating") delete next[key];
  }
  return {
    generation: state.generation + 1,
    sizes: next,
  };
}

export function managedEnvironmentKeysForProvider(
  providerId: ProviderId,
  singleKey?: ManagedEnvironmentKey,
): ManagedEnvironmentKey[] {
  if (providerId === "ultralytics") return ["ultralytics-managed"];
  return [singleKey ?? "rfdetr-all"];
}

export function getManagedEnvironmentCleanupState({
  providerId,
  singleKey,
  ultralyticsExists,
  rfdetrCount,
  hasPythonOverride,
}: {
  providerId: ProviderId;
  singleKey?: ManagedEnvironmentKey;
  ultralyticsExists: boolean | null;
  rfdetrCount: number;
  hasPythonOverride: boolean;
}) {
  const isBulkCleanup = providerId === "rfdetr" && !singleKey;
  const removesLastManagedRuntime = providerId === "ultralytics"
    ? rfdetrCount === 0
    : ultralyticsExists === false && (isBulkCleanup ? rfdetrCount > 0 : rfdetrCount === 1);
  return {
    removesLastManagedRuntime,
    willReturnToSetup: providerId === "ultralytics" && !hasPythonOverride,
    hasPythonOverride,
    isBulkCleanup,
  };
}

/**
 * Builds the user-facing cleanup error, combining per-environment deletion
 * failures with a separate setup-state persistence failure. Returns null when
 * the cleanup fully succeeded.
 */
export function managedEnvironmentCleanupErrorMessage(
  report: ManagedEnvironmentCleanupReport,
): string | null {
  const parts: string[] = [];
  const failures = report.results
    .filter((result): result is Extract<ManagedEnvironmentCleanupResult, { status: "failed" }> => result.status === "failed")
    .map((result) => `${result.key}: ${result.error}`);
  if (failures.length > 0) parts.push(`Some environments could not be removed: ${failures.join("; ")}`);
  if (report.setup_error) parts.push(`Environment removed, but saving setup state failed: ${report.setup_error}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** True when the report confirms the given key's environment was deleted. */
export function managedEnvironmentDeletionSucceeded(
  report: ManagedEnvironmentCleanupReport,
  key: ManagedEnvironmentKey,
): boolean {
  return report.results.some((result) => result.status === "succeeded" && result.key === key);
}

export function getManagedEnvironmentCleanupSetupAction(
  report: ManagedEnvironmentCleanupReport,
): { setupComplete: boolean; redetect: boolean } | null {
  if (!managedEnvironmentDeletionSucceeded(report, "ultralytics-managed")) return null;
  if (report.setup_complete === false) return { setupComplete: false, redetect: false };
  if (report.setup_complete === true) return { setupComplete: true, redetect: true };
  if (report.setup_complete === null) return { setupComplete: false, redetect: false };
  return null;
}

export function applyManagedEnvironmentCleanupSetup(
  report: ManagedEnvironmentCleanupReport,
  onSetupCompleteChange?: (complete: boolean, errorMessage?: string) => void,
): { setupComplete: boolean; redetect: boolean } | null {
  const action = getManagedEnvironmentCleanupSetupAction(report);
  if (action) onSetupCompleteChange?.(action.setupComplete, report.setup_error ?? undefined);
  return action;
}
export function shouldSkipEnvironmentRedetection(
  cleanupBusy: boolean,
  allowDuringCleanup = false,
): boolean {
  return cleanupBusy && !allowDuringCleanup;
}

export function shouldApplyManagedEnvironmentScan(
  scanGeneration: number,
  currentGeneration: number,
): boolean {
  return scanGeneration === currentGeneration;
}

export function isManagedEnvironmentCleanupBlocked({
  cleanupBusy,
  exportStatus,
  installPhase,
  runtimeInstallPhase,
  managedRuntimeRebuilding,
  redetecting,
}: {
  cleanupBusy: boolean;
  exportStatus: ExportStatus;
  installPhase: InstallPhase;
  runtimeInstallPhase: RuntimeInstallPhase;
  managedRuntimeRebuilding: boolean;
  redetecting: boolean;
}): boolean {
  return cleanupBusy
    || exportStatus === "running"
    || exportStatus === "starting"
    || installPhase === "installing"
    || runtimeInstallPhase === "installing"
    || managedRuntimeRebuilding
    || redetecting;
}
export function getRouteOptionsForOpen(
  saved: RouteOptionsState | null,
  routeId: string,
  providerId: ProviderId,
  inspect: RfDetrInspectResult | null,
  sourcePath: string,
): RouteOptionsState {
  if (saved && saved.sourcePath === sourcePath) {
    const normalized = normalizeOptionsForRoute(routeId, saved.options);
    return normalized === saved.options ? saved : { ...saved, options: normalized };
  }

  const route = findRoute(routeId) ?? defaultRouteForProvider(providerId);
  const base = optionsForRoute(route);
  const detected = withRfDetrDetectedDefaults(base, providerId, inspect);

  return {
    options: normalizeOptionsForRoute(routeId, detected),
    source: providerId === "rfdetr" && inspect?.success && inspect.recommended_imgsz ? "detected" : "default",
    sourcePath,
  };
}

export function getInstallableMissingPackages(results: DepCheckResult[] | null): InstallableDependency[] {
  if (!results) return [];

  const packages = results.flatMap((result): InstallableDependency[] => {
    if (result.install_package) {
      return [{ package: result.install_package, prerelease: result.prerelease === true }];
    }
    if (result.status === "missing_binary" && result.install_hint.startsWith("pip install ")) {
      return [{ package: result.install_hint.replace("pip install ", "").trim(), prerelease: false }];
    }
    return [];
  });
  return packages.filter((dependency, index) =>
    packages.findIndex((candidate) => candidate.package === dependency.package) === index,
  );
}

export function mayActivateRoute(exportStatus: ExportStatus, installPhase: InstallPhase): boolean {
  return exportStatus !== "starting" && exportStatus !== "running" && installPhase !== "installing";
}

export function mayStartManagedRuntimeUpgrade(
  exportStatus: ExportStatus,
  installPhase: InstallPhase,
  runtimeInstallPhase: RuntimeInstallPhase,
  managedRuntimeRebuilding: boolean,
): boolean {
  return mayActivateRoute(exportStatus, installPhase)
    && runtimeInstallPhase !== "installing"
    && !managedRuntimeRebuilding;
}

function getRuntimeOperationRefusalMessage(error: string, action: string): string | null {
  return error.includes("another runtime operation is in progress")
    ? `Another runtime operation is in progress. Wait for it to finish before ${action}.`
    : null;
}

export function getInstallStartFailureOutcome(error: string): {
  refused: boolean;
  message: string;
} {
  const refusalMessage = getRuntimeOperationRefusalMessage(error, "installing dependencies");
  if (refusalMessage) {
    return {
      refused: true,
      message: refusalMessage,
    };
  }
  return {
    refused: false,
    message: "[error] Failed to start install: " + error,
  };
}

export function getManagedRuntimeRebuildFailureMessage(error: string): string {
  return getRuntimeOperationRefusalMessage(error, "setting up a new runtime")
    ?? `Runtime upgrade failed: ${error}. Previous runtime is unchanged.`;
}

function hasBlockingDependencies(results: DepCheckResult[] | null): boolean {
  if (!results) {
    return true;
  }

  return results.some((result) => result.status !== "ready" && result.status !== "warning");
}

export function getExportFailedUserMessage(error: string): string {
  const trimmed = error.trim();
  return trimmed ? `Export failed: ${trimmed}` : "Export failed.";
}

// Returns a user-facing reason when a route's target format is not supported on
// the current OS, or null when the route is compatible. Used to short-circuit
// the export before any dependency install or subprocess runs, so the user gets
// an immediate, accurate message instead of a doomed install (e.g. TensorRT on macOS).
export function getIncompatibleExportMessage(
  route: RouteSpec,
  os: AppOS,
  arch = "unknown",
  platformResolved = true,
): string | null {
  if (!platformResolved) return null;
  if (arch === UNKNOWN_ARCH && architectureMatters(route.platformLock, os)) return null;
  if (isCompatible(route.platformLock, os, arch)) return null;
  return (
    route.unsupportedNote ??
    incompatibleReason(route.platformLock, os, arch) ??
    "This export target is not supported on your operating system."
  );
}

export function applyDetectedRouteOptions(
  saved: RouteOptionsState | null,
  routeId: string,
  detectedImgsz: number,
  currentSourcePath: string,
): RouteOptionsState | null {
  if (!saved || saved.sourcePath !== currentSourcePath) {
    const route = findRoute(routeId) ?? defaultRouteForProvider("ultralytics");
    return {
      options: normalizeOptionsForRoute(routeId, { ...optionsForRoute(route), imgsz: detectedImgsz }),
      source: "detected",
      sourcePath: currentSourcePath,
    };
  }
  if (saved.source === "user") {
    return null;
  }
  return {
    options: normalizeOptionsForRoute(routeId, { ...saved.options, imgsz: detectedImgsz }),
    source: "detected",
    sourcePath: currentSourcePath,
  };
}

export function applyDetectedRouteOptionsToProviderRoutes(
  savedByRoute: Record<string, RouteOptionsState>,
  providerId: ProviderId,
  detectedImgsz: number,
  currentSourcePath: string,
): Record<string, RouteOptionsState> {
  if (providerId !== "rfdetr") return savedByRoute;

  const next = { ...savedByRoute };
  for (const route of routesForProvider(providerId)) {
    const updated = applyDetectedRouteOptions(
      next[route.id] ?? null,
      route.id,
      detectedImgsz,
      currentSourcePath,
    );
    if (updated) {
      next[route.id] = updated;
    }
  }
  return next;
}

function isRfDetrExportReady(
  inspectStatus: RfDetrInspectStatus,
  variantMode: RfDetrVariantMode,
  manualClassSymbol: string,
): boolean {
  if (variantMode === "manual") {
    return manualClassSymbol.trim().length > 0;
  }
  return inspectStatus === "detected";
}

export function getRfDetrExportImgszError(
  providerId: ProviderId,
  imgsz: number,
  inspect: RfDetrInspectResult | null,
): string | null {
  if (providerId !== "rfdetr") return null;
  return validateRfDetrImgsz(imgsz, inspect?.required_multiple ?? null);
}

type EnvCardStatus = "ok" | "error" | "loading";
export type ProviderGroupStatus = "ready" | "partial" | "missing" | "loading" | "error";

export function getUltralyticsGroupStatus(
  envInfo: EnvironmentInfo | null,
  envError: string | null,
  redetecting: boolean,
): Exclude<ProviderGroupStatus, "error"> {
  if (redetecting || (!envInfo && !envError)) return "loading";
  if (!envInfo) return "missing";
  switch (envInfo.status) {
    case "ok": return "ready";
    case "partial": return "partial";
    case "loading": return "loading";
    case "missing":
    case "error": return "missing";
  }
}

export function getRfdetrGroupStatus(stacks: StackEnvironment[]): "ready" | "error" {
  return stacks.every((stack) =>
    stack.python_version.status === "available" && stack.rfdetr_version.status === "available",
  )
    ? "ready"
    : "error";
}

function providerGroupIcon(status: ProviderGroupStatus) {
  switch (status) {
    case "ready": return BadgeCheck;
    case "partial": return TriangleAlert;
    case "missing":
    case "error": return CircleX;
    case "loading": return CircleDashed;
  }
}

function providerGroupIconColor(status: ProviderGroupStatus): string {
  switch (status) {
    case "ready": return "text-emerald-600";
    case "partial": return "text-amber-500";
    case "missing":
    case "error": return "text-red-500";
    case "loading": return "text-zinc-400";
  }
}

function managedEnvironmentSizeLabel(result: ManagedEnvironmentScanResult | undefined): string {
  if (!result) return "Size not scanned";
  if (result.status === "calculating") return "Calculating size…";
  if (result.status === "unavailable" || result.estimated_logical_bytes === null) return "Size unavailable";
  return `Approx. size: ${formatManagedEnvironmentSize(result.estimated_logical_bytes)}`;
}

export function ProviderGroup({
  title,
  summary,
  status,
  children,
  defaultExpanded = false,
  onExpandedChange,
}: {
  title: string;
  summary: string;
  status: ProviderGroupStatus;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (defaultExpanded) onExpandedChange?.(true);
  }, [defaultExpanded, onExpandedChange]);
  const Icon = providerGroupIcon(status);
  const toggleExpanded = () => {
    setExpanded((value) => {
      const next = !value;
      onExpandedChange?.(next);
      return next;
    });
  };
  return (
    <section className="rounded-xl border border-zinc-200/80 bg-zinc-100/50 p-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/70"
      >
        <Icon className={`size-4 shrink-0 ${providerGroupIconColor(status)}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-zinc-800">{title}</span>
          <span className="block truncate text-[11px] text-zinc-500">{summary}</span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {expanded && <div className="space-y-3 px-1 pb-1 pt-2">{children}</div>}
    </section>
  );
}

export function EnvironmentGroups({
  envInfo,
  envError,
  redetecting,
  managedRuntimeUpgradeNudge,
  openManagedRuntimeUpgrade,
  mayStartRuntimeUpgrade,
  stacks,
  defaultExpanded = false,
  managedEnvironmentSizes = {},
  onProviderExpanded,
  onCleanupUltralytics,
  onCleanupRfDetr,
  onCleanupRfDetrChild,
  cleanupDisabled = false,
  disabledReason = null,
}: {
  envInfo: EnvironmentInfo | null;
  envError: string | null;
  redetecting: boolean;
  managedRuntimeUpgradeNudge: string | null;
  openManagedRuntimeUpgrade: () => void;
  mayStartRuntimeUpgrade: boolean;
  stacks: StackEnvironment[];
  defaultExpanded?: boolean;
  managedEnvironmentSizes?: Record<string, ManagedEnvironmentScanResult>;
  onProviderExpanded?: (providerId: ProviderId) => void;
  onCleanupUltralytics?: () => void;
  onCleanupRfDetr?: () => void;
  onCleanupRfDetrChild?: (key: string) => void;
  cleanupDisabled?: boolean;
  disabledReason?: string | null;
}) {
  const ultralyticsGroupStatus = getUltralyticsGroupStatus(envInfo, envError, redetecting);
  const ultralyticsGroupSummary = ultralyticsGroupStatus[0].toUpperCase() + ultralyticsGroupStatus.slice(1);
  const rfdetrGroupStatus = getRfdetrGroupStatus(stacks);
  const rfdetrGroupSummary = `${stacks.length} installed · ${rfdetrGroupStatus}`;
  const ultralyticsSize = managedEnvironmentSizes["ultralytics-managed"];
  const stackSizes = stacks.map((stack) => managedEnvironmentSizes[stack.key]);
  const rfdetrSize = managedEnvironmentSizes["rfdetr-all"] ?? (
    stackSizes.some((size) => size?.status === "calculating")
      ? { key: "rfdetr-all", status: "calculating" as const, estimated_logical_bytes: null, size_error: null }
      : stackSizes.length > 0 && stackSizes.every((size) => size?.status === "available" && size.estimated_logical_bytes !== null)
        ? {
            key: "rfdetr-all",
            status: "available" as const,
            estimated_logical_bytes: stackSizes.reduce((total, size) => total + (size?.estimated_logical_bytes ?? 0), 0),
            size_error: null,
          }
        : stackSizes.some((size) => size?.status === "unavailable" || (size?.status === "available" && size.estimated_logical_bytes === null))
          ? { key: "rfdetr-all", status: "unavailable" as const, estimated_logical_bytes: null, size_error: stackSizes.find((size) => size?.size_error)?.size_error ?? "size scan failed" }
          : undefined
  );

  return (
    <>
      <ProviderGroup
        title="Ultralytics YOLO"
        summary={ultralyticsGroupSummary}
        status={ultralyticsGroupStatus}
        defaultExpanded={defaultExpanded}
        onExpandedChange={(expanded) => expanded && onProviderExpanded?.("ultralytics")}
      >
        <EnvCard
          title="Python"
          status={
            redetecting || (!envInfo && !envError)
              ? "loading"
              : envError || !envInfo?.python_version
                ? "error"
                : "ok"
          }
          version={envInfo?.python_version || (envError ? "Error" : "...")}
          path={envInfo?.python_path}
          hint={
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <CircleHelp className="h-3 w-3 text-zinc-300 transition-colors hover:text-zinc-500" />
                </TooltipTrigger>
                <TooltipContent side="top" className="whitespace-nowrap">
                  Recommended: Python 3.12 (3.10&ndash;3.13 supported)
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          }
        >
          {managedRuntimeUpgradeNudge && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              <span>{managedRuntimeUpgradeNudge}</span>
              <Button size="sm" variant="outline" className="shrink-0" onClick={openManagedRuntimeUpgrade} disabled={!mayStartRuntimeUpgrade} title={!mayStartRuntimeUpgrade && disabledReason ? disabledReason : undefined}>
                Set up
              </Button>
            </div>
          )}
        </EnvCard>
        <EnvCard
          title="Ultralytics YOLO"
          status={
            redetecting || (!envInfo && !envError)
              ? "loading"
              : envInfo?.ultralytics_version
                ? "ok"
                : "error"
          }
          version={envInfo?.ultralytics_version || (redetecting ? "..." : "Not found")}
          path={envInfo?.yolo_path || undefined}
        />
        <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <span>{ultralyticsSize?.exists === false ? "Managed runtime not installed" : managedEnvironmentSizeLabel(ultralyticsSize)}</span>
          {onCleanupUltralytics && ultralyticsSize?.exists !== false && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={onCleanupUltralytics}
              disabled={cleanupDisabled}
              title={cleanupDisabled && disabledReason ? disabledReason : undefined}
            >
              Reset runtime
            </Button>
          )}
        </div>
        {ultralyticsSize?.exists !== false && ultralyticsSize?.status === "unavailable" && (
          <p className="px-1 text-[11px] text-amber-700">Cleanup size scan failed: {ultralyticsSize.size_error}</p>
        )}
      </ProviderGroup>

      <ProviderGroup
        title="Roboflow RF-DETR"
        summary={rfdetrGroupSummary}
        status={rfdetrGroupStatus}
        defaultExpanded={defaultExpanded}
        onExpandedChange={(expanded) => expanded && onProviderExpanded?.("rfdetr")}
      >
        {stacks.length > 0 ? (
          <>
            <div className="flex flex-col gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
              <span>{managedEnvironmentSizeLabel(rfdetrSize)}</span>
              {onCleanupRfDetr && (
                <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={onCleanupRfDetr} disabled={cleanupDisabled} title={cleanupDisabled && disabledReason ? disabledReason : undefined}>
                  Remove all
                </Button>
              )}
            </div>
            {rfdetrSize?.status === "unavailable" && (
              <p className="px-1 text-[11px] text-amber-700">Cleanup size scan failed: {rfdetrSize.size_error}</p>
            )}
            <StackEnvironmentCards stacks={stacks} sizes={managedEnvironmentSizes} onRemove={onCleanupRfDetrChild} cleanupDisabled={cleanupDisabled} disabledReason={disabledReason} />
          </>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-white/60 px-4 py-3 text-xs text-zinc-500">
            No RF-DETR environments installed
          </p>
        )}
      </ProviderGroup>
    </>
  );
}

const ENV_CARD_PLACEHOLDERS = new Set(["Not found", "Error", "..."]);
const ENV_CARD_MAX_VERSION_LENGTH = 32;

function displayVersion(version: string): string {
  if (ENV_CARD_PLACEHOLDERS.has(version)) return version;
  if (version.length === 0 || version.length > ENV_CARD_MAX_VERSION_LENGTH) return "Unknown";
  if (/\s/.test(version)) return "Unknown";
  return version;
}

export function EnvCard({
  title,
  status,
  version,
  path,
  hint,
  children,
}: {
  title: string;
  status: EnvCardStatus;
  version: string;
  path?: string;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const displayedVersion = displayVersion(version);
  const borderColor =
    status === "ok"
      ? "border-l-emerald-500"
      : status === "error"
        ? "border-l-red-400"
        : "border-l-zinc-300";
  const badgeBg =
    status === "ok"
      ? "bg-emerald-50 text-emerald-700"
      : status === "error"
        ? "bg-red-50 text-red-600"
        : "bg-zinc-100 text-zinc-400";

  return (
    <div
      className={`rounded-xl border border-zinc-200/80 border-l-[3px] bg-white p-4 shadow-sm ${borderColor}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-800">
          {title}
          {hint}
        </span>
        <span
          className={`max-w-[12rem] truncate whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] font-medium ${badgeBg} ${status === "loading" ? "animate-pulse" : ""}`}
          title={displayedVersion}
        >
          {displayedVersion}
        </span>
      </div>
      {path && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-400" title={path}>
          {path}
        </p>
      )}
      {children}
    </div>
  );
}

export function StackEnvironmentCards({
  stacks,
  defaultExpanded = false,
  sizes = {},
  onRemove,
  cleanupDisabled = false,
  disabledReason = null,
}: {
  stacks: StackEnvironment[];
  defaultExpanded?: boolean;
  sizes?: Record<string, ManagedEnvironmentScanResult>;
  onRemove?: (key: string) => void;
  cleanupDisabled?: boolean;
  disabledReason?: string | null;
}) {
  return (
    <>
      {stacks.map((stack) => (
        <StackEnvironmentRow key={stack.key} stack={stack} defaultExpanded={defaultExpanded} size={sizes[stack.key]} onRemove={onRemove} cleanupDisabled={cleanupDisabled} disabledReason={disabledReason} />
      ))}
    </>
  );
}

export function StackEnvironmentRow({
  stack,
  defaultExpanded = false,
  size,
  onRemove,
  cleanupDisabled = false,
  disabledReason = null,
}: {
  stack: StackEnvironment;
  defaultExpanded?: boolean;
  size?: ManagedEnvironmentScanResult;
  onRemove?: (key: string) => void;
  cleanupDisabled?: boolean;
  disabledReason?: string | null;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const pythonAvailable = stack.python_version.status === "available";
  const packageAvailable = stack.rfdetr_version.status === "available";
  const status = pythonAvailable && packageAvailable ? "ok" : "error";
  const packageVersion = stack.rfdetr_version.status === "available"
    ? stack.rfdetr_version.version
    : "Unavailable";

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-2 shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-zinc-50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-zinc-800">{stack.display_name}</span>
          <span className={`block truncate font-mono text-[11px] ${status === "ok" ? "text-zinc-500" : "text-red-500"}`}>
            RF-DETR {packageVersion}
          </span>
          <span className="block truncate text-[11px] text-zinc-400">{managedEnvironmentSizeLabel(size)}</span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="space-y-2 px-1 pb-1 pt-2">
          <EnvCard
            title="Python"
            status={pythonAvailable ? "ok" : "error"}
            version={stack.python_version.status === "available" ? stack.python_version.version : "Unavailable"}
            path={stack.python_path}
          />
          <p className={`px-1 text-[11px] ${status === "ok" ? "text-emerald-600" : "text-red-600"}`}>
            Status: {status === "ok" ? "Ready" : "Error"}
          </p>
          {onRemove && (
            <Button size="sm" variant="outline" onClick={() => onRemove(stack.key)} disabled={cleanupDisabled} title={cleanupDisabled && disabledReason ? disabledReason : undefined}>
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export async function refreshStackEnvironments(
  setStacks: (stacks: StackEnvironment[]) => void,
  list = listStackEnvironments,
): Promise<void> {
  try {
    setStacks(await list());
  } catch {
    setStacks([]);
  }
}

export interface EnvironmentPublishOutcome {
  requestId: number;
  /** Detected environment when this request won; null when superseded or failed. */
  info: EnvironmentInfo | null;
  /** True when this request won but detection failed (error published inside). */
  failed: boolean;
}

/**
 * Single generation-owning environment publication point. Later publishes
 * invalidate earlier ones; only the latest applies the complete atomic
 * transition (environment, error, loading): success clears stale errors,
 * failure drops stale environments. Superseded requests resolve
 * `{ info: null, failed: false }` without touching state.
 */
export function createEnvironmentPublisher(deps: {
  detect: (pythonPath?: string) => Promise<EnvironmentInfo>;
  setEnv: (info: EnvironmentInfo | null) => void;
  setError: (message: string | null) => void;
  setLoading: (loading: boolean) => void;
}) {
  let generation = 0;
  const isCurrent = (requestId: number) => generation === requestId;
  const publish = async (pythonPath?: string): Promise<EnvironmentPublishOutcome> => {
    const requestId = generation + 1;
    generation = requestId;
    try {
      const info = await deps.detect(pythonPath);
      if (!isCurrent(requestId)) return { requestId, info: null, failed: false };
      deps.setEnv(info);
      deps.setError(null);
      deps.setLoading(false);
      return { requestId, info, failed: false };
    } catch (error) {
      if (!isCurrent(requestId)) return { requestId, info: null, failed: false };
      deps.setError(String(error));
      deps.setEnv(null);
      deps.setLoading(false);
      return { requestId, info: null, failed: true };
    }
  };
  return { publish, isCurrent };
}

interface ExportWorkspaceProps {
  onBack: () => void;
  updatesEnabled: boolean;
  updater: UpdaterController;
  onSetupCompleteChange?: (complete: boolean, errorMessage?: string) => void;
}

export function ExportWorkspace({ onBack, updatesEnabled, updater, onSetupCompleteChange }: ExportWorkspaceProps) {
  const { task: setupTask, startRuntimeInstall, dismissTask } = useSetupTask();
  const [appPlatform, setAppPlatform] = useState<AppPlatform>({ os: getOS(), arch: UNKNOWN_ARCH });
  const [platformResolved, setPlatformResolved] = useState(false);
  const [view, setView] = useState<WorkspaceView>("drop");
  const [infoOpen, setInfoOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hostSupportResults, setHostSupportResults] = useState<HostSupportResult[] | null>(null);

  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>("ultralytics");
  const selectedProvider = providers[selectedProviderId];
  const currentRoutes = useMemo(() => routesForProvider(selectedProviderId), [selectedProviderId]);
  const effectiveHostSupportResults = useMemo(
    () => currentRoutes
      .map((route) => getEffectiveHostSupportResult(route, appPlatform, platformResolved, hostSupportResults))
      .filter((result): result is HostSupportResult => result !== null),
    [appPlatform, currentRoutes, hostSupportResults, platformResolved],
  );
  const [selectedRouteId, setSelectedRouteId] = useState(defaultRouteForProvider("ultralytics").id);

  const selectedRoute = useMemo(
    () => currentRoutes.find((route) => route.id === selectedRouteId) ?? defaultRouteForProvider(selectedProviderId),
    [currentRoutes, selectedProviderId, selectedRouteId],
  );

  // Environment
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [pythonOverride, setPythonOverride] = useState("");
  const [redetecting, setRedetecting] = useState(false);
  const [stackEnvironments, setStackEnvironments] = useState<StackEnvironment[]>([]);
  const refreshStackEnvironmentCards = useCallback(
    () => refreshStackEnvironments(setStackEnvironments),
    [],
  );

  const managedEnvironmentInventory = useManagedEnvironmentInventory();
  const managedEnvironmentSizes = managedEnvironmentInventory.sizes;
  const scanProviderEnvironments = managedEnvironmentInventory.scanProvider;
  const invalidateManagedEnvironmentSizesForMutation = managedEnvironmentInventory.invalidate;
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [environmentPanelError, setEnvironmentPanelError] = useState<string | null>(null);
  const [cleanupConfirmation, setCleanupConfirmation] = useState<{
    keys: ManagedEnvironmentKey[];
    provider: string;
    environments: string[];
    routeIds: string[];
    estimatedLogicalBytes: number | null;
    sizeError: string | null;
    cleanupAllowed: boolean;
    hasPythonOverride: boolean;
    removesLastManagedRuntime: boolean;
    willReturnToSetup: boolean;
    isBulkCleanup: boolean;
  } | null>(null);

  // Output directory
  const [outputDirOverride, setOutputDirOverride] = useState("");
  const [outputDirInput, setOutputDirInput] = useState("");

  // Source model path
  const [sourcePath, setSourcePath] = useState("");

  // Export session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [completedOutputDir, setCompletedOutputDir] = useState<string | null>(null);
  const [publishedPaths, setPublishedPaths] = useState<string[]>([]);
  const [publishedRun, setPublishedRun] = useState(0);
  const [publishedArtifactCount, setPublishedArtifactCount] = useState(0);

  // Export options
  const [options, setOptions] = useState<ExportOptions>(defaultOptions);

  // Dependency check state
  const [depResults, setDepResults] = useState<DepCheckResult[] | null>(null);
  const [depCheckLoading, setDepCheckLoading] = useState(false);
  const [depCheckError, setDepCheckError] = useState<string | null>(null);

  // Install phase state
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  // Runtime-install progress, logs, and result live in the app-wide setup
  // task; the route view only derives the phase it needs for gating.
  const ultralyticsSetupTask = setupTask?.environmentKey === "ultralytics-managed" ? setupTask : null;
  const runtimeInstallPhase: RuntimeInstallPhase = !ultralyticsSetupTask
    ? "idle"
    : ultralyticsSetupTask.status === "active"
      ? "installing"
      : ultralyticsSetupTask.status === "succeeded"
        ? "ready"
        : "failed";
  const [managedRuntimeUpgrade, setManagedRuntimeUpgrade] = useState<ManagedRuntimeRebuildEligibility | null>(null);
  const [managedRuntimeUpgradeOpen, setManagedRuntimeUpgradeOpen] = useState(false);
  const [managedRuntimeRebuilding, setManagedRuntimeRebuilding] = useState(false);
  const [managedRuntimeRebuildLines, setManagedRuntimeRebuildLines] = useState<string[]>([]);
  const [managedRuntimeRebuildError, setManagedRuntimeRebuildError] = useState<string | null>(null);

  // RF-DETR inspect state
  const [rfdetrInspectStatus, setRfDetrInspectStatus] = useState<RfDetrInspectStatus>("idle");
  const [rfdetrInspectResult, setRfDetrInspectResult] = useState<RfDetrInspectResult | null>(null);
  const [rfdetrTrustConfirmedPath, setRfDetrTrustConfirmedPath] = useState<string | null>(null);
  const [rfdetrVariantMode, setRfDetrVariantMode] = useState<RfDetrVariantMode>("auto");
  const [rfdetrManualClassSymbol, setRfDetrManualClassSymbol] = useState("");
  const rfdetrInspectRequestRef = useRef(0);
  const depRefreshRequestRef = useRef(0);
  const routeOptionsRef = useRef<Record<string, RouteOptionsState>>({});
  const activeInstallListenerGroupRef = useRef<ListenerGroup | null>(null);
  const hostSupportRequestRef = useRef(0);

  useEffect(() => {
    return () => {
      activeInstallListenerGroupRef.current?.dispose();
      activeInstallListenerGroupRef.current = null;
    };
  }, []);

  const setOptionsWithSource = useCallback(
    (next: ExportOptions, optsSource: ExportOptionsSource) => {
      const normalized = selectedRouteId
        ? normalizeOptionsForRoute(selectedRouteId, next)
        : next;
      setOptions(normalized);
      if (selectedRouteId) {
        routeOptionsRef.current[selectedRouteId] = {
          options: normalized,
          source: optsSource,
          sourcePath,
        };
      }
    },
    [selectedRouteId, sourcePath],
  );

  const missingPackageNames = useMemo(() => {
    return getInstallableMissingPackages(depResults);
  }, [depResults]);
  const ultralyticsRuntimeReady = selectedProviderId !== "ultralytics" || Boolean(envInfo?.yolo_path);
  const ultralyticsRuntimeInstalling = runtimeInstallPhase === "installing";
  const setupConflictMessage = isSetupTaskActive(setupTask) ? SETUP_CONFLICT_MESSAGE : null;
  // Single shared guard for every setup-owned conflict (setup, export,
  // cleanup, rebuild). Each handler passes its own inline error setter.
  const blockOnSetupConflict = (setError: (message: string) => void): boolean => {
    if (!setupConflictMessage) return false;
    setError(setupConflictMessage);
    return true;
  };
  // Navigation stays available while setup runs; only the setup-owned
  // conflicts (setup/export/cleanup/rebuild) are blocked via the message.
  // Route activation keeps its existing rebuild/redetect guards and drops
  // only the setup restriction.
  const ultralyticsRuntimeBlocking =
    selectedProviderId === "ultralytics" &&
    !envInfo?.yolo_path &&
    runtimeInstallPhase !== "installing";
  const routeActivationAllowed =
    !cleanupBusy &&
    mayActivateRoute(exportStatus, installPhase) &&
    !managedRuntimeRebuilding &&
    !redetecting;
  const cleanupActionsDisabled = isManagedEnvironmentCleanupBlocked({
    cleanupBusy,
    exportStatus,
    installPhase,
    runtimeInstallPhase,
    managedRuntimeRebuilding,
    redetecting,
  });
  const routeGridDisabled = ultralyticsRuntimeBlocking || !routeActivationAllowed;
  const routeGridDisabledReason = !routeActivationAllowed
    ? (installPhase === "installing" ? "Dependency installation in progress" : "Export in progress")
    : getUltralyticsRuntimeDisabledReason(runtimeInstallPhase);
  const mayStartRuntimeUpgrade = !cleanupBusy && mayStartManagedRuntimeUpgrade(
    exportStatus,
    installPhase,
    runtimeInstallPhase,
    managedRuntimeRebuilding,
  );
  const managedRuntimeUpgradeNudge = getManagedRuntimeUpgradeNudge(
    managedRuntimeUpgrade,
    mayStartRuntimeUpgrade,
  );
  // Ref to current sessionId for use inside event listener closures
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const currentExportRouteRef = useRef<{ routeId: string; exportFormat: string } | null>(null);
  const currentExportOutputDirRef = useRef<string | null>(null);

  // One shared environment publisher for mount, setup-terminal,
  // Environment-panel, and post-install detection. Only the latest request
  // publishes; stale requests resolve without touching state.
  const envPublisherRef = useRef<ReturnType<typeof createEnvironmentPublisher> | null>(null);
  if (!envPublisherRef.current) {
    envPublisherRef.current = createEnvironmentPublisher({
      detect: (pythonPath) => detectEnvironment(pythonPath),
      setEnv: (info) => setEnvInfo(info),
      setError: (message) => setEnvError(message),
      setLoading: (loading) => setRedetecting(loading),
    });
  }
  const environmentPublisher = envPublisherRef.current;

  // Load settings + detect environment on mount
  useEffect(() => {
    void getAppTelemetryContext()
      .then(setAppPlatform)
      .catch(() => {
        // Keep browser OS plus unknown architecture; Rust validates before work starts.
      })
      .finally(() => setPlatformResolved(true));

    loadSettings()
      .then((settings) => {
        const override = settings.python_path_override || "";
        if (override) setPythonOverride(override);
        const outOverride = settings.output_dir_override || "";
        if (outOverride) {
          setOutputDirOverride(outOverride);
          setOutputDirInput(outOverride);
        }
        return environmentPublisher.publish(override.trim() || undefined);
      })
      .catch((e: unknown) => setEnvError(String(e)));
    void getManagedRuntimeRebuildEligibility().then(setManagedRuntimeUpgrade).catch(() => setManagedRuntimeUpgrade(null));
    void refreshStackEnvironmentCards();
  }, [environmentPublisher, refreshStackEnvironmentCards]);

  useEffect(() => {
    const requestId = hostSupportRequestRef.current + 1;
    hostSupportRequestRef.current = requestId;
    setHostSupportResults(null);
    void getRoutePlatformSupport(currentRoutes.map((route) => route.id))
      .then((results) => {
        if (hostSupportRequestRef.current === requestId) setHostSupportResults(results);
      })
      .catch((error: unknown) => {
        if (hostSupportRequestRef.current !== requestId) return;
        setHostSupportResults(currentRoutes.map((route) => ({
          route_id: route.id,
          status: "error" as const,
          reason: `Host compatibility check failed: ${String(error)}`,
        })));
      });
  }, [currentRoutes]);

  const refreshRouteDependencies = useCallback(async (routeId: string | null, pythonPath: string | null) => {
    const requestId = depRefreshRequestRef.current + 1;
    depRefreshRequestRef.current = requestId;

    if (!routeId || !pythonPath) {
      if (depRefreshRequestRef.current === requestId) {
        setDepResults(null);
        setDepCheckError(null);
        setDepCheckLoading(false);
      }
      return;
    }

    if (depRefreshRequestRef.current === requestId) {
      setDepResults(null);
      setDepCheckLoading(true);
      setDepCheckError(null);
    }

    try {
      const response = await checkDependencies(routeId, pythonPath);
      if (depRefreshRequestRef.current !== requestId) {
        return;
      }
      setDepResults(response.results);
    } catch (error) {
      if (depRefreshRequestRef.current !== requestId) {
        return;
      }
      setDepResults(null);
      setDepCheckError(String(error));
      throw error;
    } finally {
      if (depRefreshRequestRef.current === requestId) {
        setDepCheckLoading(false);
      }
    }
  }, []);

  // Check dependencies whenever the selected route or resolved environment changes.
  // Observes the environment object (not just its python path) so a fresh
  // object published by setup completion refreshes whichever route is current.
  useEffect(() => {
    const pythonPath = envInfo?.python_path;
    if (!pythonPath || !selectedRouteId) {
      setDepResults(null);
      return;
    }

    void refreshRouteDependencies(selectedRouteId, pythonPath).catch(() => {
      // State handled in helper; avoid unhandled promise noise.
    });
  }, [selectedRouteId, envInfo, refreshRouteDependencies]);

  // On setup terminal, publish the fresh environment and let the dependency
  // effect above refresh the currently selected route. Detection uses the
  // interpreter captured on the task, never the live editable Python input,
  // so typing an unsaved path cannot publish the wrong environment. Keyed by
  // task session/status; overlapping detections are generation-guarded.
  const setupTerminalSession = ultralyticsSetupTask?.sessionId ?? null;
  const setupTerminalStatus = ultralyticsSetupTask?.status ?? null;
  const setupTerminalError = ultralyticsSetupTask?.error ?? null;
  const setupTerminalDismissed = ultralyticsSetupTask?.dismissed ?? null;
  const setupTerminalPythonPath = ultralyticsSetupTask?.pythonPath ?? null;
  useEffect(() => {
    if (!setupTerminalSession) return;
    if (setupTerminalStatus !== "succeeded" && setupTerminalStatus !== "failed") return;
    if (setupTerminalDismissed) return;
    invalidateManagedEnvironmentSizesForMutation(["ultralytics-managed"]);
    if (setupTerminalStatus === "failed") {
      setDepCheckError(setupTerminalError ?? "Setup failed.");
      return;
    }
    if (!setupTerminalPythonPath) return;
    void environmentPublisher.publish(setupTerminalPythonPath);
  }, [environmentPublisher, invalidateManagedEnvironmentSizesForMutation, setupTerminalDismissed, setupTerminalError, setupTerminalPythonPath, setupTerminalSession, setupTerminalStatus]);

  // Register once; handlers filter events through the current session ref.
  useEffect(() => {
    const listeners = createListenerGroup();
    const registrations = [
      listen<ExportLinePayload>("export:stdout", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setLogLines((prev) => [...prev, "[stdout] " + event.payload.line]);
        }
      }),
      listen<ExportLinePayload>("export:stderr", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setLogLines((prev) => [...prev, "[stderr] " + event.payload.line]);
        }
      }),
      listen<ExportFinishedPayload>("export:finished", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          if (event.payload.artifact_warning) {
            setLogLines((prev) => [...prev, "[warning] " + event.payload.artifact_warning]);
          }
          setPublishedPaths(event.payload.published_paths);
          setPublishedRun(event.payload.run);
          setPublishedArtifactCount(event.payload.artifact_count);
          setLogLines((prev) => [
            ...prev,
            ...event.payload.published_paths.map((path) => "[published] " + path),
          ]);
          const exportRoute = currentExportRouteRef.current;
          if (exportRoute) {
            captureAnalyticsEvent("export_completed", {
              route_id: exportRoute.routeId,
              export_format: exportRoute.exportFormat,
            });
          }
          setCompletedOutputDir(event.payload.output_dir || currentExportOutputDirRef.current);
          setExportStatus("finished");
        }
      }),
      listen<ExportFailedPayload>("export:failed", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          const message = getExportFailedUserMessage(event.payload.error);
          const exportRoute = currentExportRouteRef.current;
          if (exportRoute) {
            captureAnalyticsEvent("export_failed", {
              route_id: exportRoute.routeId,
              export_format: exportRoute.exportFormat,
              failure_stage: "export_run",
              failure_kind: "export_process_failed",
            });
          }
          setInvokeError(message);
          setLogLines((prev) => [...prev, "[error] " + message]);
          setExportStatus("failed");
        }
      }),
      listen<ExportCancelledPayload>("export:cancelled", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          const exportRoute = currentExportRouteRef.current;
          if (exportRoute) {
            captureAnalyticsEvent("export_cancelled", {
              route_id: exportRoute.routeId,
              export_format: exportRoute.exportFormat,
            });
          }
          setExportStatus("cancelled");
        }
      }),
    ];

    void Promise.all(registrations.map((registration) => listeners.add(registration))).catch((e: unknown) => {
      const alreadyDisposed = listeners.isDisposed();
      listeners.dispose();
      if (!alreadyDisposed) {
        setInvokeError("Failed to set up export listeners: " + String(e));
      }
    });

    return () => listeners.dispose();
  }, []);

  useEffect(() => {
    routeOptionsRef.current = {};
  }, [sourcePath]);

  const streamDependencyInstall = useCallback(async (
    routeId: string | null,
    packages: InstallableDependency[],
    pythonPath: string,
    appendLine: (line: string) => void,
  ): Promise<InstallOutcome> => {
    const listeners = createListenerGroup();
    activeInstallListenerGroupRef.current?.dispose();
    activeInstallListenerGroupRef.current = listeners;

    try {
      return await runInstallStream(
        {
          listenInstallEvent: <T,>(event: string, handler: (ev: { payload: T }) => void) =>
            listen<T>(event, handler),
          startInstall: (resolvedRouteId, resolvedPackages, resolvedPythonPath) =>
            installDependencies(resolvedRouteId, resolvedPackages, resolvedPythonPath),
        },
        listeners,
        { routeId, packages, pythonPath },
        { onLine: appendLine },
      );
    } finally {
      listeners.dispose();
      if (activeInstallListenerGroupRef.current === listeners) {
        activeInstallListenerGroupRef.current = null;
      }
    }
  }, []);

  const handleInstallUltralyticsRuntime = useCallback(async () => {
    const pythonPath = envInfo?.python_path;
    if (!pythonPath) return;
    if (blockOnSetupConflict(setDepCheckError)) return;
    if (cleanupBusy) return;

    setDepCheckLoading(true);
    setDepCheckError(null);

    try {
      if (
        ultralyticsSetupTask &&
        ultralyticsSetupTask.status !== "active" &&
        !ultralyticsSetupTask.dismissed
      ) {
        dismissTask();
      }
      // Install → verify → terminal lives in the app-wide owner, so
      // unmounting (e.g. Landing navigation) cannot strand completion.
      // Environment + current-route refresh happens in the terminal effect.
      const result = await startRuntimeInstall({
        provider: "ultralytics",
        routeId: null,
        environmentKey: "ultralytics-managed",
        packages: [{ package: "ultralytics", prerelease: false }],
        pythonPath,
        summary: "Installing Ultralytics runtime…",
      });
      if (!result.ok) {
        setDepCheckError(result.error);
        return;
      }
    } catch (error) {
      setDepCheckError(String(error));
    } finally {
      setDepCheckLoading(false);
    }
  }, [blockOnSetupConflict, cleanupBusy, dismissTask, envInfo?.python_path, startRuntimeInstall, ultralyticsSetupTask]);

  const failExportStart = useCallback((message: string) => {
    setInstallPhase("idle");
    setInvokeError(message);
    setCompletedOutputDir(null);
    setPublishedPaths([]);
    setPublishedRun(0);
    setPublishedArtifactCount(0);
    setExportStatus("failed");
    setLogLines(["[error] " + message]);
  }, []);

  // Core export invocation — call only when deps are satisfied
  const doStartExport = async (missingDepCount: number, envOverride?: EnvironmentInfo) => {
    const activeEnv = envOverride ?? envInfo;
    if (!sourcePath || !activeEnv?.python_path) return;
    if (selectedProviderId === "ultralytics" && !activeEnv.yolo_path) {
      setInvokeError("YOLO CLI not found. Install the Ultralytics runtime or re-detect the environment.");
      return;
    }
    if (selectedProviderId === "rfdetr" && rfdetrTrustConfirmedPath !== sourcePath) {
      setInvokeError("Confirm trusted RF-DETR checkpoint loading before export.");
      return;
    }
    if (
      selectedProviderId === "rfdetr" &&
      !isRfDetrExportReady(rfdetrInspectStatus, rfdetrVariantMode, rfdetrManualClassSymbol)
    ) {
      setInvokeError("Inspect RF-DETR checkpoint successfully or select a manual variant before export.");
      return;
    }
    if (selectedProviderId === "rfdetr" && rfdetrVariantMode === "manual" && !rfdetrManualClassSymbol) {
      setInvokeError("Select an RF-DETR variant before export.");
      return;
    }
    const rfdetrImgszError = getRfDetrExportImgszError(selectedProviderId, options.imgsz, rfdetrInspectResult);
    if (rfdetrImgszError) {
      setInvokeError(rfdetrImgszError);
      return;
    }
    setInvokeError(null);
    setCompletedOutputDir(null);
    setExportStatus("starting");
    setLogLines(["[info] Starting export..."]);
    const exportRoute = {
      routeId: selectedRoute.id,
      exportFormat: selectedRoute.targetFormat,
    };
    currentExportRouteRef.current = exportRoute;
    const outputDir = getResolvedOutputDir(sourcePath, outputDirOverride);
    currentExportOutputDirRef.current = outputDir || null;
    try {
      const id = await startExport({
        sourcePath,
        routeId: selectedRoute.id,
        outputDir,
        providerId: selectedProviderId,
        pythonPath: activeEnv.python_path,
        yoloPath: activeEnv.yolo_path ?? "",
        imgsz: options.imgsz,
        batch: options.batch,
        precision: options.precision,
        calibrationData: options.calibrationData,
        dynamic: options.dynamic,
        simplify: options.simplify,
        optimize: options.optimize,
        nms: options.nms,
        endToEnd: options.endToEnd,
        keras: options.keras,
        opset: options.opset,
        workspace: options.workspace,
        chip: options.chip,
        rfdetrTrustConfirmed: selectedProviderId === "rfdetr" && rfdetrTrustConfirmedPath === sourcePath,
        rfdetrVariantMode: selectedProviderId === "rfdetr" ? rfdetrVariantMode : null,
        rfdetrManualClassSymbol: selectedProviderId === "rfdetr" && rfdetrVariantMode === "manual" ? rfdetrManualClassSymbol : null,
      });
      sessionIdRef.current = id;
      setSessionId(id);
      setExportStatus("running");
      captureAnalyticsEvent("export_started", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        provider_id: selectedProviderId,
        rfdetr_variant_mode: selectedProviderId === "rfdetr" ? rfdetrVariantMode : undefined,
        rfdetr_detected_class: rfdetrInspectResult?.class_symbol ?? undefined,
        rfdetr_selected_class: rfdetrVariantMode === "manual" ? rfdetrManualClassSymbol : undefined,
        rfdetr_family: rfdetrInspectResult?.family ?? undefined,
        missing_dep_count: missingDepCount,
      });
    } catch (e: unknown) {
      captureAnalyticsEvent("export_failed", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        failure_stage: "start_export",
        failure_kind: "start_export_failed",
      });
      sessionIdRef.current = null;
      setSessionId(null);
      currentExportOutputDirRef.current = null;
      setExportStatus("failed");
      setInvokeError(String(e));
      setLogLines((prev) => [...prev, "[error] " + String(e)]);
    }
  };

  // Export handler — gates on missing deps before starting
  const handleExport = async () => {
    if (blockOnSetupConflict(setInvokeError)) return;
    if (cleanupBusy || !sourcePath || !envInfo?.python_path || exportStatus === "running" || exportStatus === "starting") return;
    const incompatibleMessage = getIncompatibleExportMessage(
      selectedRoute,
      appPlatform.os,
      appPlatform.arch,
      platformResolved,
    );
    if (incompatibleMessage) {
      setInstallPhase("idle");
      setInvokeError(incompatibleMessage);
      setExportStatus("failed");
      setLogLines(["[error] " + incompatibleMessage]);
      captureAnalyticsEvent("export_failed", {
        route_id: selectedRoute.id,
        export_format: selectedRoute.targetFormat,
        failure_stage: "preflight",
        failure_kind: "os_incompatible",
      });
      return;
    }
    if (selectedProviderId === "ultralytics" && !envInfo.yolo_path) {
      setInvokeError("Install the Ultralytics runtime before starting a YOLO export.");
      return;
    }
    if (depCheckLoading) {
      setInvokeError("Dependency check still running. Wait for it to finish before export.");
      return;
    }
    if (depCheckError || depResults === null) {
      setInvokeError("Dependency check not ready. Resolve dependency check before export.");
      return;
    }
    const rfdetrImgszError = getRfDetrExportImgszError(selectedProviderId, options.imgsz, rfdetrInspectResult);
    if (rfdetrImgszError) {
      failExportStart(rfdetrImgszError);
      return;
    }

    if (missingPackageNames.length > 0) {
      setInvokeError(null);
      setInstallPhase("pending_consent");
      return;
    }
    if (hasBlockingDependencies(depResults)) {
      failExportStart("Blocking dependencies still unresolved. Review dependency panel before export.");
      return;
    }

    setLogLines([]);
    await doStartExport(missingPackageNames.length);
  };

  // Install missing deps then auto-start export
  const handleInstallAndExport = async () => {
    if (blockOnSetupConflict(setInvokeError)) return;
    if (cleanupBusy || !mayActivateRoute(exportStatus, installPhase)) {
      setInvokeError("Another runtime operation is in progress. Wait for it to finish before installing dependencies.");
      return;
    }
    const pythonPath = envInfo?.python_path;
    if (!pythonPath) return;
    const incompatibleMessage = getIncompatibleExportMessage(
      selectedRoute,
      appPlatform.os,
      appPlatform.arch,
      platformResolved,
    );
    if (incompatibleMessage) {
      setInstallPhase("idle");
      setInvokeError(incompatibleMessage);
      setExportStatus("failed");
      setLogLines(["[error] " + incompatibleMessage]);
      captureAnalyticsEvent("export_failed", {
        route_id: selectedRoute.id,
        export_format: selectedRoute.targetFormat,
        failure_stage: "preflight",
        failure_kind: "os_incompatible",
      });
      return;
    }
    const exportRoute = {
      routeId: selectedRoute.id,
      exportFormat: selectedRoute.targetFormat,
    };
    const rfdetrImgszError = getRfDetrExportImgszError(selectedProviderId, options.imgsz, rfdetrInspectResult);
    if (rfdetrImgszError) {
      failExportStart(rfdetrImgszError);
      return;
    }
    const missingPkgs = getInstallableMissingPackages(depResults);

    if (missingPkgs.length === 0) {
      setInstallPhase("idle");
      setLogLines([]);
      await doStartExport(missingPkgs.length);
      return;
    }

    setInstallPhase("installing");
    setLogLines([]);

    try {
      const result = await streamDependencyInstall(exportRoute.routeId, missingPkgs, pythonPath, (line) => {
        setLogLines((prev) => [...prev, line]);
      });
      invalidateManagedEnvironmentSizesForMutation();

      if (!result.ok) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "install_dependencies",
          failure_kind: "install_failed",
        });
        setInstallPhase("failed");
        setLogLines((prev) => [...prev, "[error] Install failed: " + result.error]);
        return;
      }
      await refreshStackEnvironmentCards();
    } catch (e: unknown) {
      const outcome = getInstallStartFailureOutcome(String(e));
      if (outcome.refused) {
        setInvokeError(outcome.message);
        return;
      }
      invalidateManagedEnvironmentSizesForMutation();
      captureAnalyticsEvent("export_failed", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        failure_stage: "install_dependencies",
        failure_kind: "install_start_failed",
      });
      setInstallPhase("failed");
      setLogLines((prev) => [...prev, outcome.message]);
      return;
    }

    setInstallPhase("done");
    setDepCheckLoading(true);
    setDepCheckError(null);
    let refreshedMissingPkgs: InstallableDependency[] = [];
    let freshEnv: EnvironmentInfo | undefined;
    try {
      const refreshed = await checkDependencies(selectedRoute.id, pythonPath);
      setDepResults(refreshed.results);
      refreshedMissingPkgs = getInstallableMissingPackages(refreshed.results);
      if (refreshedMissingPkgs.length > 0) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "recheck_dependencies",
          failure_kind: "deps_still_missing_after_install",
        });
        setInstallPhase("pending_consent");
        setInvokeError("Dependencies still missing after install. Review requirements before export.");
        return;
      }
      if (hasBlockingDependencies(refreshed.results)) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "recheck_dependencies",
          failure_kind: "blocking_dependencies_remaining_after_install",
        });
        setInstallPhase("failed");
        setInvokeError("Non-installable dependency blockers remain after install. Export blocked.");
        return;
      }

      if (selectedProviderId === "ultralytics") {
        const published = await environmentPublisher.publish(pythonOverride.trim() || pythonPath);
        if (!environmentPublisher.isCurrent(published.requestId)) return;
        if (published.failed || !published.info) {
          captureAnalyticsEvent("export_failed", {
            route_id: exportRoute.routeId,
            export_format: exportRoute.exportFormat,
            failure_stage: "redetect_environment",
            failure_kind: "environment_redetect_failed_after_install",
          });
          setInstallPhase("failed");
          setInvokeError("Environment re-detect failed after install. Re-detect the environment before export.");
          return;
        }
        freshEnv = published.info;

        if (!freshEnv.yolo_path) {
          captureAnalyticsEvent("export_failed", {
            route_id: exportRoute.routeId,
            export_format: exportRoute.exportFormat,
            failure_stage: "redetect_environment",
            failure_kind: "yolo_missing_after_install",
          });
          setInstallPhase("failed");
          setInvokeError("YOLO CLI still missing after install. Re-detect the environment or reinstall the Ultralytics runtime.");
          return;
        }
      }
    } catch (e: unknown) {
      captureAnalyticsEvent("export_failed", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        failure_stage: "recheck_dependencies",
        failure_kind: "dependency_recheck_failed",
      });
      setDepResults(null);
      setDepCheckError(String(e));
      setInstallPhase("failed");
      setInvokeError("Dependency re-check failed after install. Export blocked.");
      return;
    } finally {
      setDepCheckLoading(false);
    }

    await doStartExport(refreshedMissingPkgs.length, freshEnv);
  };

  // Cancel handler
  const handleCancel = async () => {
    if (sessionId === null || exportStatus !== "running") return;
    try {
      await cancelExport(sessionId);
    } catch (e: unknown) {
      const exportRoute = currentExportRouteRef.current;
      if (exportRoute) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "cancel_export",
          failure_kind: "cancel_export_failed",
        });
      }
      setInvokeError("Cancel failed: " + String(e));
    }
  };

  const handleShowExportFolder = useCallback(async () => {
    if (!completedOutputDir) return;
    try {
      await openExportFolder(completedOutputDir);
    } catch (error) {
      setInvokeError(String(error));
    }
  }, [completedOutputDir]);

  // Provider switch
  function resetExportStateForProvider(providerId: ProviderId) {
    setSelectedRouteId(defaultRouteForProvider(providerId).id);
    setDialogOpen(false);
    setSourcePath("");
    setView("drop");
    setLogLines([]);
    setInvokeError(null);
    setCompletedOutputDir(null);
    setDepResults(null);
    setDepCheckLoading(false);
    setDepCheckError(null);
    setInstallPhase("idle");
    setExportStatus("idle");
    setSessionId(null);
    currentExportOutputDirRef.current = null;
    setRfDetrInspectStatus("idle");
    setRfDetrInspectResult(null);
    setRfDetrTrustConfirmedPath(null);
    setRfDetrVariantMode("auto");
    setRfDetrManualClassSymbol("");
    rfdetrInspectRequestRef.current += 1;
  }

  const handleProviderChange = (providerId: ProviderId) => {
    if (providerId === selectedProviderId) return;
    setSelectedProviderId(providerId);
    resetExportStateForProvider(providerId);
  };

  // File select — validate extension, then advance to formats view
  const handleFileSelect = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (!hasAllowedSourceExtension(trimmed, selectedProvider)) {
      setInvokeError(`${selectedProvider.displayName} accepts ${selectedProvider.sourceExtensions.join(", ")} files only.`);
      setSourcePath("");
      setView("drop");
      return;
    }
    setInvokeError(null);
    setSourcePath(trimmed);
    if (selectedProvider.id === "rfdetr") {
      setRfDetrInspectStatus("needs_trust");
      setRfDetrInspectResult(null);
      setRfDetrTrustConfirmedPath(null);
      setRfDetrVariantMode("auto");
      setRfDetrManualClassSymbol("");
    }
    setView("formats");
  }, [selectedProvider]);

  const handleConfirmRfDetrTrust = async () => {
    if (!sourcePath || !envInfo?.python_path) return;
    const requestId = rfdetrInspectRequestRef.current + 1;
    rfdetrInspectRequestRef.current = requestId;
    setRfDetrTrustConfirmedPath(sourcePath);
    setRfDetrInspectStatus("inspecting");
    setRfDetrInspectResult(null);
    try {
      const result = await inspectRfDetrCheckpoint({
        checkpointPath: sourcePath,
        pythonPath: envInfo.python_path,
        trustConfirmed: true,
      });
      if (rfdetrInspectRequestRef.current !== requestId) return;
      setRfDetrInspectResult(result);
      setRfDetrInspectStatus(result.success ? "detected" : "failed");
      if (result.success && result.recommended_imgsz) {
        const recommended = result.recommended_imgsz;
        const nextRouteOptions = applyDetectedRouteOptionsToProviderRoutes(
          routeOptionsRef.current,
          "rfdetr",
          recommended,
          sourcePath,
        );
        routeOptionsRef.current = nextRouteOptions;

        if (selectedRouteId) {
          const selectedState = nextRouteOptions[selectedRouteId];
          if (selectedState && selectedState.source === "detected") {
            setOptions(selectedState.options);
          }
        }
      }
    } catch (error) {
      if (rfdetrInspectRequestRef.current !== requestId) return;
      setRfDetrInspectResult({
        success: false,
        class_symbol: null,
        family: null,
        size: null,
        requires_plus: false,
        is_legacy: false,
        recommended_imgsz: null,
        patch_size: null,
        num_windows: null,
        required_multiple: null,
        token_grid: null,
        resolution_source: null,
        error: String(error),
      });
      setRfDetrInspectStatus("failed");
    }
  };

  // Route row clicked — open modal for that route. Route browsing stays
  // available while setup runs; rebuild/redetect guards are retained.
  const handleActivateRoute = (routeId: string) => {
    if (!routeActivationAllowed) return;
    setSelectedRouteId(routeId);

    const saved = routeOptionsRef.current[routeId] ?? null;
    const routeState = getRouteOptionsForOpen(saved, routeId, selectedProvider.id, rfdetrInspectResult, sourcePath);
    setOptions(routeState.options);
    routeOptionsRef.current[routeId] = routeState;
    setLogLines([]);
    setInvokeError(null);
    setCompletedOutputDir(null);
    setExportStatus("idle");
    setInstallPhase("idle");
    setDialogOpen(true);
  };

  // Clear file — back to drop view
  const handleClearFile = () => {
    setSourcePath("");
    setView("drop");
    setRfDetrInspectStatus("idle");
    setRfDetrInspectResult(null);
    setRfDetrTrustConfirmedPath(null);
    setRfDetrVariantMode("auto");
    setRfDetrManualClassSymbol("");
    setCompletedOutputDir(null);
    currentExportOutputDirRef.current = null;
    rfdetrInspectRequestRef.current += 1;
  };

  // Re-detect environment with current override. Detection and loading-state
  // publication go through the shared generation-owning path; the envInfo
  // effect refreshes whichever route is current.
  const handleRedetect = useCallback(async (overridePath?: string, allowDuringCleanup = false) => {
    if (shouldSkipEnvironmentRedetection(cleanupBusy, allowDuringCleanup)) return;
    const trimmedOverride = overridePath?.trim();
    setRedetecting(true);
    setEnvInfo(null);
    setEnvError(null);
    const outcome = await environmentPublisher.publish(trimmedOverride || undefined);
    if (!environmentPublisher.isCurrent(outcome.requestId)) return;
    if (outcome.failed) return;
    try {
      setManagedRuntimeUpgrade(await getManagedRuntimeRebuildEligibility());
      await refreshStackEnvironmentCards();
    } catch (e: unknown) {
      if (environmentPublisher.isCurrent(outcome.requestId)) setEnvironmentPanelError(String(e));
    }
  }, [cleanupBusy, environmentPublisher, refreshStackEnvironmentCards]);

  const handleRebuildManagedRuntime = useCallback(async () => {
    if (blockOnSetupConflict(setManagedRuntimeRebuildError)) return;
    if (!mayStartRuntimeUpgrade) return;
    setManagedRuntimeRebuilding(true);
    setManagedRuntimeRebuildError(null);
    setManagedRuntimeRebuildLines([]);
    const listeners = createListenerGroup();
    let sessionId = "";
    let resolveResult!: (result: "ok" | string) => void;
    const resultPromise = new Promise<"ok" | string>((resolve) => { resolveResult = resolve; });

    const cleanup = () => listeners.dispose();
    try {
      await Promise.all([
        listeners.add(listen<InstallLinePayload>("setup:stdout", (event) => {
          if (sessionId && event.payload.session_id === sessionId) {
            setManagedRuntimeRebuildLines((lines) => [...lines, "[stdout] " + event.payload.line]);
          }
        })),
        listeners.add(listen<InstallLinePayload>("setup:stderr", (event) => {
          if (sessionId && event.payload.session_id === sessionId) {
            setManagedRuntimeRebuildLines((lines) => [...lines, "[stderr] " + event.payload.line]);
          }
        })),
        listeners.add(listen<InstallFinishedPayload>("setup:finished", (event) => {
          if (sessionId && event.payload.session_id === sessionId) resolveResult("ok");
        })),
        listeners.add(listen<InstallFailedPayload>("setup:failed", (event) => {
          if (sessionId && event.payload.session_id === sessionId) resolveResult(event.payload.error);
        })),
      ]);
      sessionId = await rebuildManagedRuntime();
      const result = await resultPromise;
      cleanup();
      if (result !== "ok") {
        setManagedRuntimeRebuildError(getManagedRuntimeRebuildFailureMessage(result));
        return;
      }
      invalidateManagedEnvironmentSizesForMutation();
      setManagedRuntimeUpgradeOpen(false);
      await handleRedetect();
    } catch (error) {
      cleanup();
      setManagedRuntimeRebuildError(getManagedRuntimeRebuildFailureMessage(String(error)));
    } finally {
      setManagedRuntimeRebuilding(false);
    }
  }, [blockOnSetupConflict, handleRedetect, invalidateManagedEnvironmentSizesForMutation, mayStartRuntimeUpgrade]);

  const openManagedRuntimeUpgrade = useCallback(() => {
    if (blockOnSetupConflict(setManagedRuntimeRebuildError)) return;
    if (mayStartRuntimeUpgrade) setManagedRuntimeUpgradeOpen(true);
  }, [blockOnSetupConflict, mayStartRuntimeUpgrade]);

  // Save python path override and re-detect
  const handleSaveAndRedetect = useCallback(async () => {
    if (cleanupBusy) return;
    const val = pythonOverride.trim();
    try {
      await savePythonOverride(val || null);
    } catch (error) {
      setEnvironmentPanelError(String(error));
      return;
    }
    handleRedetect(val);
  }, [cleanupBusy, pythonOverride, handleRedetect]);

  // Browse for python executable
  const handleBrowsePython = useCallback(async () => {
    const path = await openPythonExecutablePicker();
    if (path) setPythonOverride(path);
  }, []);

  // Clear python override
  const handleClearOverride = useCallback(async () => {
    if (cleanupBusy) return;
    setPythonOverride("");
    await savePythonOverride(null);
    handleRedetect();
  }, [cleanupBusy, handleRedetect]);

  const prepareCleanup = useCallback(async (providerId: ProviderId, singleKey?: ManagedEnvironmentKey) => {
    if (blockOnSetupConflict(setEnvironmentPanelError)) return;
    if (cleanupActionsDisabled) return;
    setEnvironmentPanelError(null);
    let scanned: ManagedEnvironmentScanResult[];
    try {
      scanned = await scanProviderEnvironments(providerId, singleKey);
    } catch (error: unknown) {
      setCleanupConfirmation(null);
      setEnvironmentPanelError(String(error));
      return;
    }
    const scannedByKey = Object.fromEntries(scanned.map((row) => [row.key, row]));
    const isUltralytics = providerId === "ultralytics";
    const ultralyticsPresence = isUltralytics
      ? scannedByKey["ultralytics-managed"]?.exists ?? null
      : managedEnvironmentSizes["ultralytics-managed"]?.exists ?? null;
    if (!isUltralytics && ultralyticsPresence === null) {
      const ultralyticsScan = await scanProviderEnvironments("ultralytics").catch(() => []);
      const result = ultralyticsScan.find((row) => row.key === "ultralytics-managed");
      if (result) scannedByKey[result.key] = result;
    }
    const rows = isUltralytics
      ? [scannedByKey["ultralytics-managed"] ?? managedEnvironmentSizes["ultralytics-managed"]]
      : scanned.filter((row) => row.key !== "rfdetr-all");
    const cleanupAllowed = rows.length > 0 && rows.every((row) => isManagedEnvironmentCleanupAllowed(row));
    const estimatedLogicalBytes = cleanupAllowed && rows.every((row) => row?.status === "available")
      ? rows.reduce((total, row) => total + (row?.estimated_logical_bytes ?? 0), 0)
      : null;
    const sizeError = rows.find((row) => row?.status === "unavailable")?.size_error ?? null;
    const displayName = (key: string) => stackEnvironments.find((stack) => stack.key === key)?.display_name ?? key;
    const selectedKeys = managedEnvironmentKeysForProvider(providerId, singleKey);
    const cleanupState = getManagedEnvironmentCleanupState({
      providerId,
      singleKey,
      ultralyticsExists: scannedByKey["ultralytics-managed"]?.exists ?? ultralyticsPresence,
      rfdetrCount: stackEnvironments.length,
      hasPythonOverride: Boolean(pythonOverride.trim()),
    });
    setCleanupConfirmation({
      keys: selectedKeys,
      provider: isUltralytics ? "Ultralytics YOLO" : "Roboflow RF-DETR",
      environments: isUltralytics ? ["Ultralytics managed runtime"] : rows.map((row) => displayName(row.key)),
      routeIds: isUltralytics
        ? routesForProvider("ultralytics").map((route) => route.id)
        : rows.flatMap((row) => {
            const stack = stackEnvironments.find((item) => item.key === row.key);
            return stack?.route_ids ?? [];
          }),
      estimatedLogicalBytes,
      sizeError,
      cleanupAllowed,
      ...cleanupState,
    });
  }, [blockOnSetupConflict, cleanupActionsDisabled, managedEnvironmentSizes, pythonOverride, scanProviderEnvironments, stackEnvironments]);

  const confirmCleanup = useCallback(async () => {
    if (!cleanupConfirmation || !cleanupConfirmation.cleanupAllowed || cleanupBusy) return;
    if (blockOnSetupConflict(setEnvironmentPanelError)) return;
    const confirmation = cleanupConfirmation;
    setCleanupBusy(true);
    setEnvironmentPanelError(null);
    try {
      const report: ManagedEnvironmentCleanupReport = await cleanupManagedEnvironments(confirmation.keys);
      const cleanupMessage = managedEnvironmentCleanupErrorMessage(report);
      if (cleanupMessage) setEnvironmentPanelError(cleanupMessage);
      setCleanupConfirmation(null);
      invalidateManagedEnvironmentSizesForMutation(
        managedEnvironmentCacheKeysForCleanup(confirmation.keys, stackEnvironments.map((stack) => stack.key)),
      );
      if (confirmation.keys.includes("ultralytics-managed")) {
        // Deletion succeeds independently of setup-state persistence, so refresh
        // the managed runtime card whenever the .venv was actually removed, even
        // if saving setup state failed (surfaced via cleanupMessage above).
        if (managedEnvironmentDeletionSucceeded(report, "ultralytics-managed")) {
          setEnvInfo(null);
          const setupAction = applyManagedEnvironmentCleanupSetup(report, onSetupCompleteChange);
          if (setupAction?.redetect) {
            const settings = await loadSettings();
            await handleRedetect(settings.python_path_override || undefined, true);
          }
        }
      } else {
        await refreshStackEnvironmentCards();
        await refreshRouteDependencies(selectedRouteId, envInfo?.python_path ?? null).catch(() => {});
      }
    } catch (error: unknown) {
      setEnvironmentPanelError((current) => current ? `${current} ${String(error)}` : String(error));
    } finally {
      setCleanupBusy(false);
    }
  }, [blockOnSetupConflict, cleanupBusy, cleanupConfirmation, envInfo?.python_path, handleRedetect, invalidateManagedEnvironmentSizesForMutation, onSetupCompleteChange, pythonOverride, refreshRouteDependencies, refreshStackEnvironmentCards, selectedRouteId, stackEnvironments]);

  // Save output dir override
  const handleSaveOutputDir = useCallback(async () => {
    if (cleanupBusy) return;

    const val = outputDirInput.trim();
    setOutputDirOverride(val);
    await saveOutputDirOverride(val || null);
  }, [cleanupBusy, outputDirInput]);

  // Browse for output directory
  const handleBrowseOutputDir = useCallback(async () => {
    const path = await openOutputDirPicker();
    if (path) setOutputDirInput(path);
  }, []);

  // Clear output dir override
  const handleClearOutputDir = useCallback(async () => {
    if (cleanupBusy) return;
    setOutputDirOverride("");
    setOutputDirInput("");
    await saveOutputDirOverride(null);
  }, [cleanupBusy]);
  const handleBack = () => {
    if (view === "drop") onBack();
    else handleClearFile();
  };

  const backLabel = "Back";
  const baseName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;

  const header = (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-900/10 bg-white px-5 py-3">
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-950"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </button>

      <div className="flex items-center gap-4">
        {/* (i) settings panel trigger */}
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          title="Environment & settings"
        >
          <Info className="h-3.5 w-3.5" />
        </button>

        {updatesEnabled ? <UpdateChecker updater={updater} /> : null}
      </div>

      {/* Settings slide-in panel */}
      <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-[340px] bg-zinc-50/80 p-0">
          {/* Panel header */}
          <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-4">
            <SheetHeader className="p-0">
              <SheetTitle className="text-[15px]">Environment</SheetTitle>
            </SheetHeader>
            <button
              type="button"
              onClick={() => handleRedetect(pythonOverride.trim())}
              disabled={redetecting || cleanupBusy}
              className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 disabled:opacity-50"
              title="Re-detect environment"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${redetecting ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {/* Status cards */}
            <div className="space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                Status
              </p>

              <EnvironmentGroups
                envInfo={envInfo}
                envError={envError}
                redetecting={redetecting}
                managedRuntimeUpgradeNudge={managedRuntimeUpgradeNudge}
                openManagedRuntimeUpgrade={openManagedRuntimeUpgrade}
                mayStartRuntimeUpgrade={mayStartRuntimeUpgrade}
                stacks={stackEnvironments}
                managedEnvironmentSizes={managedEnvironmentSizes}
                onProviderExpanded={(providerId) => {
                  const scans = providerId === "rfdetr"
                    ? stackEnvironments.map((stack) => scanProviderEnvironments("rfdetr", stack.key as ManagedEnvironmentKey))
                    : [scanProviderEnvironments(providerId)];
                  void Promise.all(scans).catch((error: unknown) => setEnvironmentPanelError(String(error)));
                }}
                onCleanupUltralytics={() => { void prepareCleanup("ultralytics"); }}
                onCleanupRfDetr={() => { void prepareCleanup("rfdetr"); }}
                onCleanupRfDetrChild={(key) => { void prepareCleanup("rfdetr", key as ManagedEnvironmentKey); }}
                cleanupDisabled={cleanupActionsDisabled}
                disabledReason={setupConflictMessage}
              />
              {environmentPanelError && <p className="text-xs text-red-700">{environmentPanelError}</p>}
            </div>

            {/* Configuration */}
            <div className="space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                Configuration
              </p>

              <div className="rounded-xl border border-zinc-200/80 bg-white p-4 shadow-sm">
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[13px] font-semibold text-zinc-800">Python override</p>
                  {pythonOverride && (
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                      onClick={handleClearOverride}
                      title="Reset to auto-detect"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={pythonOverride}
                    onChange={(e) => setPythonOverride(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveAndRedetect(); }}
                    placeholder="Use managed Vision Export Studio runtime"
                    className="h-8 flex-1 min-w-0 rounded-lg border-zinc-200 bg-zinc-50 font-mono text-[12px] placeholder:text-zinc-300 focus-visible:bg-white"
                  />
                  <button
                    type="button"
                    onClick={handleBrowsePython}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                    title="Browse for Python executable"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  Leave empty to use Vision Export Studio&apos;s managed runtime in <code>~/.vision-export-studio/.venv</code>.
                </p>
                <div className="mt-2.5 flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 rounded-lg px-3 text-[12px]"
                    onClick={handleSaveAndRedetect}
                  >
                    Apply
                  </Button>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-200/80 bg-white p-4 shadow-sm">
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[13px] font-semibold text-zinc-800">Output directory</p>
                  {outputDirInput && (
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                      onClick={handleClearOutputDir}
                      title="Reset to auto"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={outputDirInput}
                    onChange={(e) => setOutputDirInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveOutputDir(); }}
                    placeholder="Auto (next to model file)"
                    className="h-8 flex-1 min-w-0 rounded-lg border-zinc-200 bg-zinc-50 font-mono text-[12px] placeholder:text-zinc-300 focus-visible:bg-white"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseOutputDir}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                    title="Browse for output directory"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2.5 flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 rounded-lg px-3 text-[12px]"
                    onClick={handleSaveOutputDir}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>

            {/* Warnings */}
            {envInfo?.warnings && envInfo.warnings.length > 0 && (
              <div className="rounded-xl border border-amber-200/60 bg-amber-50/50 p-4">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-amber-600/80">
                  Warnings
                </p>
                <div className="space-y-1.5">
                  {envInfo.warnings.map((w, i) => (
                    <p key={i} className="text-[12px] leading-relaxed text-amber-700">{w}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );

  const filePill = (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-900/10 bg-white/85 p-4 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <FileBox className="h-5 w-5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-950">{baseName}</p>
        <p className="text-xs text-zinc-500">Ready to export</p>
      </div>
      <button
        type="button"
        onClick={handleClearFile}
        className="text-zinc-400 hover:text-zinc-950"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const managedRuntimeUpgradeDialog = (
    <ManagedRuntimeUpgradeDialog
      open={managedRuntimeUpgradeOpen}
      candidateVersion={managedRuntimeUpgrade?.candidate_version ?? null}
      rebuilding={managedRuntimeRebuilding}
      lines={managedRuntimeRebuildLines}
      error={managedRuntimeRebuildError ?? setupConflictMessage}
      mayStart={mayStartRuntimeUpgrade}
      onOpenChange={setManagedRuntimeUpgradeOpen}
      onContinue={handleRebuildManagedRuntime}
    />
  );

  const cleanupDialog = cleanupConfirmation ? (
    <Dialog open onOpenChange={(open) => { if (!open && !cleanupBusy) setCleanupConfirmation(null); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cleanupConfirmation.provider === "Ultralytics YOLO" ? "Reset Ultralytics runtime?" : cleanupConfirmation.keys.includes("rfdetr-all") ? "Remove RF-DETR environments?" : "Remove RF-DETR environment?"}</DialogTitle>
          <DialogDescription>
            {cleanupConfirmation.provider === "Ultralytics YOLO"
              ? "This removes the local environment used for Ultralytics exports."
              : cleanupConfirmation.keys.includes("rfdetr-all")
                ? `This removes ${cleanupConfirmation.environments.length} local RF-DETR environments.`
                : `This removes the local environment used for ${cleanupConfirmation.routeIds.map((id) => findRoute(id)?.title ?? id).join(", ")} exports.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <div><p className="font-medium">What will be removed</p><p className="text-zinc-600">{cleanupConfirmation.environments.join(", ")}</p></div>
          <div><p className="font-medium">Approx. size</p><p className="text-zinc-600">{cleanupConfirmation.estimatedLogicalBytes === null ? "Unavailable" : formatManagedEnvironmentSize(cleanupConfirmation.estimatedLogicalBytes)}</p></div>
          <div><p className="font-medium">What happens next</p><p className="text-zinc-600">{cleanupConfirmation.removesLastManagedRuntime && <><strong>This is your last managed runtime.</strong> </>}{cleanupConfirmation.willReturnToSetup ? "Vision Export Studio will return to Setup. You must set up an environment before exporting again." : cleanupConfirmation.removesLastManagedRuntime && cleanupConfirmation.hasPythonOverride ? "Your Python override will stay active. You can continue exporting with it." : cleanupConfirmation.provider === "Ultralytics YOLO" ? "Your Python override will stay active. You can continue exporting with it." : cleanupConfirmation.isBulkCleanup ? "These environments will be set up again when needed." : "This environment will be set up again when needed."}</p></div>
          <div><p className="font-medium">What stays safe</p><p className="text-zinc-600">Your models, exported files, and settings will not be deleted.</p></div>
          <details>
            <summary className="cursor-pointer font-medium">Affected export formats ({cleanupConfirmation.routeIds.length})</summary>
            <div className="mt-2 max-h-24 overflow-y-auto text-zinc-600">{cleanupConfirmation.routeIds.map((routeId) => findRoute(routeId)?.title ?? routeId).join(", ")}</div>
          </details>
          {cleanupConfirmation.estimatedLogicalBytes === null && cleanupConfirmation.sizeError && <p className="text-amber-700">We could not calculate this environment’s size. You can still remove it.</p>}
        </div>
        <p className="text-xs text-zinc-500">Estimate; actual free-space change may differ.</p>
        {setupConflictMessage && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{setupConflictMessage}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setCleanupConfirmation(null)} disabled={cleanupBusy}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => void confirmCleanup()}
            disabled={cleanupBusy || !cleanupConfirmation.cleanupAllowed || Boolean(setupConflictMessage)}
            title={setupConflictMessage ?? undefined}
          >
            {cleanupBusy ? "Removing…" : cleanupConfirmation.provider === "Ultralytics YOLO" ? "Reset runtime" : cleanupConfirmation.keys.includes("rfdetr-all") ? "Remove all" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  if (view === "drop") {
    return (
      <div className="flex min-h-screen flex-col">
        {header}
        <main className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md">
            <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-white p-1">
              {providerList().map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => handleProviderChange(provider.id)}
                  className={[
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    provider.id === selectedProviderId
                      ? "bg-zinc-950 text-white"
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950",
                  ].join(" ")}
                >
                  {provider.displayName}
                </button>
              ))}
            </div>
            <DropZone
              path={sourcePath}
              title={selectedProvider.dropTitle}
              helper={selectedProvider.dropHelper}
              pickerFilterName={selectedProvider.pickerFilterName}
              pickerExtensions={selectedProvider.sourceExtensions}
              onFileSelect={handleFileSelect}
              errorMsg={invokeError}
            />
          </div>
        </main>
        {managedRuntimeUpgradeDialog}
        {cleanupDialog}
      </div>
    );
  }

  // formats view
  return (
    <div className="flex h-dvh flex-col">
      {header}
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-2xl space-y-6 px-5 py-8">
          {filePill}
          {selectedProviderId === "rfdetr" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {rfdetrInspectStatus === "needs_trust" && (
                <div className="space-y-3">
                  <p className="font-medium">Trusted checkpoint required</p>
                  <p>RF-DETR checkpoint inspection loads local PyTorch checkpoint data. Use checkpoints from trusted sources only.</p>
                  <Button size="sm" onClick={handleConfirmRfDetrTrust} disabled={!envInfo?.python_path}>
                    Trust and inspect
                  </Button>
                </div>
              )}
              {rfdetrInspectStatus === "inspecting" && <p>Inspecting RF-DETR checkpoint...</p>}
              {rfdetrInspectStatus === "detected" && rfdetrInspectResult && (
                <p>Detected: <span className="font-mono">{rfdetrInspectResult.class_symbol}</span>{rfdetrInspectResult.is_legacy ? " (legacy)" : ""}{rfdetrInspectResult.recommended_imgsz ? ` · native ${rfdetrInspectResult.recommended_imgsz}px` : ""}{rfdetrInspectResult.required_multiple ? ` · multiple ${rfdetrInspectResult.required_multiple}` : ""}</p>
              )}
              {rfdetrInspectStatus === "failed" && (
                <div className="space-y-3">
                  <p>{rfdetrInspectResult?.error ?? "RF-DETR inspection failed."}</p>
                  <label className="block text-xs font-medium uppercase tracking-wide">Manual variant</label>
                  <select
                    value={rfdetrManualClassSymbol}
                    onChange={(event) => {
                      setRfDetrVariantMode("manual");
                      setRfDetrManualClassSymbol(event.target.value);
                    }}
                    className="h-9 w-full rounded-md border border-amber-300 bg-white px-3 text-sm"
                  >
                    <option value="">Select RF-DETR variant</option>
                    <optgroup label="Detection">
                      <option value="RFDETRNano">RFDETRNano</option>
                      <option value="RFDETRSmall">RFDETRSmall</option>
                      <option value="RFDETRMedium">RFDETRMedium</option>
                      <option value="RFDETRLarge">RFDETRLarge</option>
                    </optgroup>
                    <optgroup label="Detection legacy">
                      <option value="RFDETRBase">RFDETRBase (legacy)</option>
                    </optgroup>
                    <optgroup label="Segmentation">
                      <option value="RFDETRSegNano">RFDETRSegNano</option>
                      <option value="RFDETRSegSmall">RFDETRSegSmall</option>
                      <option value="RFDETRSegMedium">RFDETRSegMedium</option>
                      <option value="RFDETRSegLarge">RFDETRSegLarge</option>
                      <option value="RFDETRSegXLarge">RFDETRSegXLarge</option>
                      <option value="RFDETRSeg2XLarge">RFDETRSeg2XLarge</option>
                    </optgroup>
                  </select>
                </div>
              )}
            </div>
          )}
          {selectedProviderId === "ultralytics" && !ultralyticsRuntimeReady && !ultralyticsRuntimeInstalling && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div>
                <p className="font-medium">Ultralytics runtime required</p>
                <p className="mt-1">Install once to enable YOLO exports on this machine.</p>
              </div>
              <Button size="sm" onClick={handleInstallUltralyticsRuntime} disabled={!envInfo?.python_path || cleanupBusy}>
                Install Runtime
              </Button>
            </div>
          )}
          <div>
            <h2 className="mb-3 text-sm font-medium uppercase text-zinc-400">
              Export Target
            </h2>
            <RouteGrid
              routes={currentRoutes}
              platform={appPlatform}
              hostSupportResults={effectiveHostSupportResults}
              onSelectRoute={handleActivateRoute}
              disabled={routeGridDisabled}
              disabledReason={routeGridDisabledReason}
            />
          </div>
        </main>
      </div>

      <ExportModal
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setInstallPhase("idle");
            setInvokeError(null);
          }
        }}
        provider={selectedProvider}
        route={selectedRoute}
        hostSupportResult={getHostSupportResult(effectiveHostSupportResults, selectedRoute.id)}
        sourcePath={sourcePath}
        exportStatus={exportStatus}
        logLines={logLines}
        options={options}
        onOptionsChange={(next) => setOptionsWithSource(next, "user")}
        onExport={handleExport}
        onStopExport={handleCancel}
        depResults={depResults ?? undefined}
        depCheckLoading={depCheckLoading}
        depCheckError={depCheckError}
        errorMsg={invokeError}
        installPhase={installPhase}
        missingPackageNames={missingPackageNames}
        onInstallAndExport={handleInstallAndExport}
        outputDir={getResolvedOutputDir(sourcePath, outputDirOverride)}
        completedOutputDir={completedOutputDir}
        publishedPaths={publishedPaths}
        publishedRun={publishedRun}
        publishedArtifactCount={publishedArtifactCount}
        onShowExportFolder={handleShowExportFolder}
        managedRuntimeUpgradeEligible={Boolean(managedRuntimeUpgrade?.eligible)}
        managedRuntimeUpgradeDisabled={!mayStartRuntimeUpgrade}
        onManagedRuntimeUpgrade={openManagedRuntimeUpgrade}
        setupConflictMessage={setupConflictMessage}
        rfdetrSummary={selectedProviderId === "rfdetr" ? {
          variantMode: rfdetrVariantMode,
          detectedClass: rfdetrInspectResult?.class_symbol ?? null,
          selectedClass: rfdetrVariantMode === "manual" ? rfdetrManualClassSymbol : null,
          trusted: rfdetrTrustConfirmedPath === sourcePath,
          recommendedImgsz: rfdetrInspectResult?.recommended_imgsz ?? null,
          patchSize: rfdetrInspectResult?.patch_size ?? null,
          requiredMultiple: rfdetrInspectResult?.required_multiple ?? null,
        } : null}
      />

      {managedRuntimeUpgradeDialog}
      {cleanupDialog}
    </div>
  );
}
