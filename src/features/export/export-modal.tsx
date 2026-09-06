import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formats } from "@/lib/routes";
import type {
  DepCheckResult,
  ExportOptions,
  InstallableDependency,
  ExportStatus,
  InstallPhase,
  ProviderSpec,
  RfDetrInspectStatus,
  RfDetrVariantMode,
  RouteSpec,
} from "@/lib/types";
import type { HostSupportResult } from "@/lib/tauri/app";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronDown, Download, FolderOpen, Loader2, Play, Square } from "lucide-react";
import { buildCommandPreview } from "./command-preview";
import { DependencyPanel } from "./dependency-panel";
import { ExportLog } from "./export-log";
import { OptionsPanel } from "./options-panel";
import { validateRfDetrImgsz } from "./rfdetr-image-size";
import {
  getUltralyticsRouteSetupCopy,
  getUltralyticsRouteSetupPrimaryAction,
  shouldHideUltralyticsExportControls,
  type UltralyticsRouteSetupStatus,
} from "./ultralytics-route-setup";
import {
  getRfDetrRouteSetupCopy,
  getRfDetrInspectionFollowUpCopy,
  shouldHideRfDetrExportControls,
  type RfDetrInspectionFailureActions,
  type RfDetrInspectionFollowUpPhase,
  type RfDetrRouteSetupStatus,
} from "./rfdetr-route-setup";
import { formatIconMap } from "@/components/format-icons";
import { categoryBg, categoryIcon } from "./route-card";

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderSpec;
  route: RouteSpec;
  hostSupportResult?: HostSupportResult | null;
  sourcePath: string;
  exportStatus: ExportStatus;
  logLines: string[];
  options: ExportOptions;
  onOptionsChange: (opts: ExportOptions) => void;
  onExport: () => void;
  onStopExport: () => void;
  depResults?: DepCheckResult[];
  depCheckLoading?: boolean;
  depCheckError?: string | null;
  errorMsg?: string | null;
  installPhase: InstallPhase;
  missingPackages: InstallableDependency[];
  onInstallAndExport: () => void;
  outputDir?: string;
  completedOutputDir?: string | null;
  publishedPaths: string[];
  publishedRun: number;
  publishedArtifactCount: number;
  onShowExportFolder: () => void;
  managedRuntimeUpgradeEligible: boolean;
  managedRuntimeUpgradeDisabled: boolean;
  onManagedRuntimeUpgrade: () => void;
  setupConflictMessage?: string | null;
  ultralyticsSetup?: UltralyticsSetupModalState | null;
  rfdetrSetup?: RfDetrSetupModalState | null;
  onSetupRoute?: () => void;
  onRemoveEnvironment?: () => void;
  onRecreateEnvironment?: () => void;
  rfdetrSummary?: {
    variantMode: RfDetrVariantMode;
    detectedClass?: string | null;
    selectedClass?: string | null;
    trusted: boolean;
    recommendedImgsz?: number | null;
    patchSize?: number | null;
    requiredMultiple?: number | null;
    resolutionSource?: string | null;
  } | null;
  rfdetrInspection?: RfDetrInspectionModalState | null;
  onRetryRfDetrInspection?: () => void;
  onChooseDifferentRfDetrFile?: () => void;
  onRevealRfDetrManualVariant?: () => void;
}

/**
 * Checkpoint inspection state for the RF-DETR export modal. Bundled so the
 * modal takes one inspection object (plus action callbacks, matching the
 * setup state's convention) instead of a clump of related props. The
 * failure recovery contract is shared with the workspace panel via
 * RfDetrInspectionFailureActions: retry and file actions render here, and
 * the manual-variant select lives in the workspace checkpoint panel.
 */
export interface RfDetrInspectionModalState {
  status: RfDetrInspectStatus;
  error: string | null;
  ready: boolean;
  followUp: RfDetrInspectionFollowUpPhase;
  failure: RfDetrInspectionFailureActions;
}

type FooterAction = "cancel" | "export" | "export_again" | "show_folder" | "starting" | "stop";

export type ExportModalFooterMode = "setup" | "inspection" | "export";

/**
 * Footer ownership for the export modal. Setup owns the footer while its
 * own incomplete state hides export controls; otherwise the inspection
 * follow-up/failure owns it while it hides export; otherwise export owns
 * it. Setup never shadows the inspection footer: a Ready environment with
 * pending or failed inspection reaches the inspection branch.
 */
export function getExportModalFooterMode(input: {
  setupMode: boolean;
  hasSetupAction: boolean;
  inspectionHidesExport: boolean;
}): ExportModalFooterMode {
  if (input.setupMode && input.hasSetupAction) return "setup";
  if (input.inspectionHidesExport) return "inspection";
  return "export";
}

export function getExportFooterActions({
  exportStatus,
  hasCompletedOutputDir,
}: {
  exportStatus: ExportStatus;
  hasCompletedOutputDir: boolean;
}): { secondary: FooterAction; primary: FooterAction } {
  if (exportStatus === "running") {
    return { secondary: "stop", primary: "export" };
  }
  if (exportStatus === "starting") {
    return { secondary: "starting", primary: "export" };
  }
  if (exportStatus === "finished" && hasCompletedOutputDir) {
    return { secondary: "export_again", primary: "show_folder" };
  }
  return { secondary: "cancel", primary: "export" };
}

export function involvesPackageUpdate(depResults: DepCheckResult[] | undefined): boolean {
  return (depResults ?? []).some(
    (result) => result.status === "version_too_old" && Boolean(result.install_package),
  );
}

export function HostSupportBadge({ result }: { result: HostSupportResult | null | undefined }) {
  if (!result || result.status !== "unsupported") return null;
  return (
    <Badge variant="destructive" className="h-6 rounded px-2.5 text-xs font-semibold">
      Unsupported
    </Badge>
  );
}

export function HostSupportReason({ result }: { result: HostSupportResult | null | undefined }) {
  if (!result || !result.reason) return null;
  return (
    <div className="mt-3 flex gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      <p className="text-sm text-red-800">{result.reason}</p>
    </div>
  );
}

export function PendingInstallConsent({
  depResults,
  missingPackages,
}: {
  depResults?: DepCheckResult[];
  missingPackages: InstallableDependency[];
}) {
  const involvesUpdate = involvesPackageUpdate(depResults);
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
      <p className="mb-1 text-sm font-medium text-blue-800">
        {involvesUpdate ? "Package updates" : "Missing packages"}
      </p>
      <p className="mb-2 text-xs text-blue-700">
        {involvesUpdate
          ? "These will be updated or installed into your Python environment before export:"
          : "These will be installed into your Python environment before export:"}
      </p>
      <ul className="space-y-0.5">
        {missingPackages.map((pkg) => (
          <li key={pkg.package} className="font-mono text-xs text-blue-900">
            • {pkg.package}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PrimaryExportActionLabel({
  isInstalling,
  isPendingConsent,
  involvesUpdate,
}: {
  isInstalling: boolean;
  isPendingConsent: boolean;
  involvesUpdate: boolean;
}) {
  if (isInstalling) {
    return (
      <>
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Installing...
      </>
    );
  }
  if (isPendingConsent) {
    return (
      <>
        <Download className="mr-2 h-4 w-4" />
        {involvesUpdate ? "Update & Export" : "Install & Export"}
      </>
    );
  }
  return (
    <>
      <Play className="mr-2 h-4 w-4" />
      Start Export
    </>
  );
}

export interface UltralyticsSetupModalState {
  status: UltralyticsRouteSetupStatus;
  actionLabel: string;
  busy: boolean;
  canSetup: boolean;
  showRecovery: boolean;
  error: string | null;
}

export interface RfDetrSetupModalState extends UltralyticsSetupModalState {
  status: RfDetrRouteSetupStatus;
  /** Backend-owned stack key when resolved; null before inventory/task resolve it. */
  stackKey: string | null;
}

function ultralyticsSetupTones(status: UltralyticsRouteSetupStatus): { container: string; text: string } {
  if (status === "check-failed") return { container: "border-red-200 bg-red-50", text: "text-red-800" };
  if (status === "setup-incomplete" || status === "unavailable" || status === "manual-step-required") {
    return { container: "border-amber-200 bg-amber-50", text: "text-amber-900" };
  }
  return { container: "border-blue-200 bg-blue-50", text: "text-blue-800" };
}

function SetupPanelBase({
  title,
  body,
  tones,
  error,
  showRecovery,
  onRemoveEnvironment,
  onRecreateEnvironment,
}: {
  title: string;
  body: string;
  tones: { container: string; text: string };
  error: string | null;
  showRecovery: boolean;
  onRemoveEnvironment?: () => void;
  onRecreateEnvironment?: () => void;
}) {
  return (
    <div className={`rounded-md border p-3 ${tones.container}`}>
      <p className={`text-sm font-medium ${tones.text}`}>{title}</p>
      <p className={`mt-1 text-xs ${tones.text}`}>{body}</p>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      {showRecovery && (
        <div className="mt-2 flex flex-wrap gap-2">
          {onRemoveEnvironment && (
            <Button size="sm" variant="outline" onClick={onRemoveEnvironment}>
              Remove…
            </Button>
          )}
          {onRecreateEnvironment && (
            <Button size="sm" variant="outline" onClick={onRecreateEnvironment}>
              Recreate environment…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function UltralyticsSetupPanel({
  status,
  routeTitle,
  error,
  showRecovery,
  onRemoveEnvironment,
  onRecreateEnvironment,
}: {
  status: UltralyticsRouteSetupStatus;
  routeTitle: string;
  error: string | null;
  showRecovery: boolean;
  onRemoveEnvironment?: () => void;
  onRecreateEnvironment?: () => void;
}) {
  const copy = getUltralyticsRouteSetupCopy(status, routeTitle);
  return (
    <SetupPanelBase
      title={copy.title}
      body={copy.body}
      tones={ultralyticsSetupTones(status)}
      error={error}
      showRecovery={showRecovery}
      onRemoveEnvironment={onRemoveEnvironment}
      onRecreateEnvironment={onRecreateEnvironment}
    />
  );
}

export function RfDetrSetupPanel({
  status,
  routeTitle,
  stackKey,
  error,
  showRecovery,
  onRemoveEnvironment,
  onRecreateEnvironment,
}: {
  status: RfDetrRouteSetupStatus;
  routeTitle: string;
  stackKey: string | null;
  error: string | null;
  showRecovery: boolean;
  onRemoveEnvironment?: () => void;
  onRecreateEnvironment?: () => void;
}) {
  const copy = getRfDetrRouteSetupCopy(status, routeTitle, stackKey);
  return (
    <SetupPanelBase
      title={copy.title}
      body={copy.body}
      tones={ultralyticsSetupTones(status)}
      error={error}
      showRecovery={showRecovery}
      onRemoveEnvironment={onRemoveEnvironment}
      onRecreateEnvironment={onRecreateEnvironment}
    />
  );
}

export function RfDetrInspectionFollowUpPanel() {
  const copy = getRfDetrInspectionFollowUpCopy();
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
      <p className="text-sm font-medium text-blue-800">{copy.title}</p>
      <p className="mt-1 text-xs text-blue-800">{copy.body}</p>
    </div>
  );
}

export function RfDetrInspectionFailurePanel({
  error,
  failure,
  onRetry,
  onChooseDifferentFile,
  onRevealManualVariant,
}: {
  error: string | null;
  failure: RfDetrInspectionFailureActions;
  onRetry?: () => void;
  onChooseDifferentFile?: () => void;
  onRevealManualVariant?: () => void;
}) {
  const canRetry = failure.canRetry && onRetry;
  const showFileAction = failure.showFileAction && onChooseDifferentFile;
  const showManualVariant = failure.showManualVariant && onRevealManualVariant;
  const recoveryOptions = canRetry
    ? "Retry inspection, try a different checkpoint file, or check route compatibility and environment setup."
    : "Try a different checkpoint file, or check route compatibility and environment setup.";
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-sm font-medium text-red-800">Checkpoint inspection failed</p>
      <p className="mt-1 text-xs text-red-800">
        {error ?? "RF-DETR inspection failed."}
      </p>
      <p className="mt-2 text-xs text-red-700">
        The environment is ready. {recoveryOptions} No guessed defaults were applied.
      </p>
      {(canRetry || showFileAction || showManualVariant) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry inspection
            </Button>
          )}
          {showFileAction && (
            <Button size="sm" variant="outline" onClick={onChooseDifferentFile}>
              Choose different file
            </Button>
          )}
          {showManualVariant && (
            <Button size="sm" variant="outline" onClick={onRevealManualVariant}>
              Select manual variant
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ExportModal({
  open,
  onOpenChange,
  provider,
  route,
  hostSupportResult,
  sourcePath,
  exportStatus,
  logLines,
  options,
  onOptionsChange,
  onExport,
  onStopExport,
  depResults,
  depCheckLoading,
  depCheckError,
  errorMsg,
  installPhase,
  missingPackages,
  onInstallAndExport,
  outputDir,
  completedOutputDir,
  publishedPaths,
  publishedRun,
  publishedArtifactCount,
  onShowExportFolder,
  managedRuntimeUpgradeEligible,
  managedRuntimeUpgradeDisabled,
  onManagedRuntimeUpgrade,
  setupConflictMessage,
  ultralyticsSetup,
  rfdetrSetup,
  onSetupRoute,
  onRemoveEnvironment,
  onRecreateEnvironment,
  rfdetrSummary,
  rfdetrInspection,
  onRetryRfDetrInspection,
  onChooseDifferentRfDetrFile,
  onRevealRfDetrManualVariant,
}: ExportModalProps) {
  const format = formats[route.targetFormat];
  const formatIcon = formatIconMap[format.id];
  const Icon = formatIcon ?? categoryIcon(format.category);
  const bg = formatIcon ? "bg-white text-zinc-800" : categoryBg(format.category);
  const isPendingConsent = installPhase === "pending_consent";
  const isInstalling = installPhase === "installing";
  const involvesUpdate = involvesPackageUpdate(depResults);
  const isStarting = exportStatus === "starting";
  const isRunning = exportStatus === "running";
  const setupBlocked = Boolean(setupConflictMessage);
  // Missing inspection data fails closed for RF-DETR: export configuration
  // requires both a Ready environment and usable checkpoint inspection.
  const inspectionReady = rfdetrInspection?.ready ?? false;
  // Route-owned setup (tickets 08 and 10): the same modal opens in a
  // setup-only mode until the exact route is ready, then transforms into the
  // export configuration below. Ultralytics owns the shared environment;
  // each RF-DETR route owns its isolated stack. Ticket 11 adds inspection
  // readiness on top for RF-DETR, tracked separately so a Ready environment
  // with pending or failed inspection never falls back into setup copy.
  const ultralyticsHides = ultralyticsSetup != null
    && shouldHideUltralyticsExportControls(provider.id, ultralyticsSetup.status);
  const rfdetrHides = rfdetrSetup != null
    && shouldHideRfDetrExportControls(provider.id, rfdetrSetup.status);
  const setupMode = ultralyticsHides || rfdetrHides;
  // Inspection follow-up runs beside a Ready environment, never as setup
  // readiness: when setup is Ready but inspection is still running or has
  // failed, the modal shows the named checkpoint phase instead of export
  // configuration. The environment stays Ready throughout.
  const isRfDetrRouteReady = provider.id === "rfdetr"
    && rfdetrSetup != null
    && rfdetrSetup.status === "ready";
  const rfdetrFollowUpActive = isRfDetrRouteReady
    && rfdetrInspection?.followUp != null;
  const rfdetrFailureActive = isRfDetrRouteReady
    && !inspectionReady
    && rfdetrInspection?.status === "failed";
  // Setup ready without usable inspection data and without a running or
  // failed inspection (for example before the checkpoint is trusted):
  // export stays hidden fail-closed, with a pointer back to the workspace
  // trust step instead of guessed defaults.
  const rfdetrInspectionRequiredActive = isRfDetrRouteReady
    && !inspectionReady
    && !rfdetrFollowUpActive
    && !rfdetrFailureActive;
  const inspectionHidesExport = rfdetrFollowUpActive || rfdetrFailureActive
    || rfdetrInspectionRequiredActive;
  const exportConfigVisible = !setupMode && !inspectionHidesExport;
  // Single footer decision for the failure branch: the body panel owns the
  // same retry rule for its own button; this bool keeps the footer's copy
  // in one named place instead of repeating the guard.
  const showRetryInFooter = Boolean(
    rfdetrFailureActive && rfdetrInspection?.failure.canRetry && onRetryRfDetrInspection,
  );
  // One setup owns the footer at a time; both states share the same shape
  // (RfDetrSetupModalState extends UltralyticsSetupModalState), so the
  // primary action resolves once instead of per provider.
  const activeSetup = ultralyticsHides && ultralyticsSetup
    ? ultralyticsSetup
    : rfdetrHides && rfdetrSetup
      ? rfdetrSetup
      : null;
  const setupPrimary = activeSetup
    ? getUltralyticsRouteSetupPrimaryAction(activeSetup.status, activeSetup.actionLabel)
    : null;
  const setupPrimaryEnabled = activeSetup != null
    && setupPrimary != null
    && setupPrimary.enabled
    && activeSetup.canSetup
    && !activeSetup.busy;
  const setupStatusForSpinner = activeSetup?.status ?? null;
  const footerMode = getExportModalFooterMode({
    setupMode,
    hasSetupAction: setupPrimary != null,
    inspectionHidesExport,
  });
  const rfdetrImgszError =
    provider.id === "rfdetr" && rfdetrSummary
      ? validateRfDetrImgsz(options.imgsz, rfdetrSummary.requiredMultiple ?? null)
      : null;
  const rfdetrInspectionBlocksExport = provider.id === "rfdetr" && !inspectionReady;
  const exportDisabled = isRunning || isStarting || !sourcePath || isInstalling || setupBlocked || rfdetrImgszError !== null
    || rfdetrInspectionBlocksExport;
  const showLog = exportStatus !== "idle" || logLines.length > 0;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const footerActions = getExportFooterActions({
    exportStatus,
    hasCompletedOutputDir: Boolean(completedOutputDir),
  });

  const collapsedSummary = (() => {
    if (provider.id !== "rfdetr" || !rfdetrSummary?.recommendedImgsz) {
      return "Converting with current options";
    }
    const patch = rfdetrSummary.patchSize ? ` · patch ${rfdetrSummary.patchSize}` : "";
    if (options.imgsz === rfdetrSummary.recommendedImgsz) {
      return `Native settings applied: ${options.imgsz}px${patch}`;
    }
    return `Override active: ${options.imgsz}px · native ${rfdetrSummary.recommendedImgsz}px${patch}`;
  })();

  const commandPreview = buildCommandPreview({
    providerId: provider.id,
    routeId: route.id,
    targetFormat: route.targetFormat,
    sourcePath,
    options,
    outputDir,
    rfdetrVariantMode: rfdetrSummary?.variantMode,
    rfdetrManualClassSymbol:
      rfdetrSummary?.variantMode === "manual" ? rfdetrSummary.selectedClass ?? "" : undefined,
  });

  useEffect(() => {
    if (open) setAdvancedOpen(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next === false && isStarting) return; onOpenChange(next); }}>
      <DialogContent className="flex max-h-[720px] w-[450px] sm:max-w-none flex-col gap-0 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* Header */}
        <DialogHeader className="border-b px-6 py-4">
          <div className="flex items-center gap-3">
            {formatIcon ? (
              <Icon className="h-12 w-12 shrink-0" />
            ) : (
              <div
                className={cn(
                  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
                  bg,
                )}
              >
                <Icon className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-lg">
                  Export to {route.title}
                </DialogTitle>
                {exportConfigVisible && <HostSupportBadge result={hostSupportResult} />}
              </div>
              <p className="font-mono text-xs text-zinc-400">
                format={route.targetFormat}{route.backend ? ` · backend=${route.backend}` : ""}
              </p>
            </div>
          </div>
          <HostSupportReason result={hostSupportResult} />
          <p className="mt-2 text-sm leading-6 text-zinc-500">{route.notes}</p>
          {rfdetrSummary && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                RF-DETR variant:{" "}
                <span className="font-mono">
                  {rfdetrSummary.variantMode === "manual"
                    ? rfdetrSummary.selectedClass
                    : rfdetrSummary.detectedClass ?? "Auto"}
                </span>
                {rfdetrSummary.recommendedImgsz
                  ? ` · native ${rfdetrSummary.recommendedImgsz}px${rfdetrSummary.patchSize ? ` · patch ${rfdetrSummary.patchSize}` : ""}${rfdetrSummary.resolutionSource ? ` · source ${rfdetrSummary.resolutionSource}` : ""}${rfdetrSummary.requiredMultiple ? ` · multiple ${rfdetrSummary.requiredMultiple}` : ""}`
                  : rfdetrSummary.requiredMultiple
                    ? ` · multiple ${rfdetrSummary.requiredMultiple}`
                    : ""}
              </p>
              <p className="mt-1">Use checkpoints from trusted sources only. Local checkpoint loading may execute Python pickle data.</p>
            </div>
          )}
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-6 px-6 py-5">
            {/* Dependencies — hidden for hard platform blocks: the backend
                short-circuits those to a single platform row repeating the
                header reason, and nothing there is actionable while setup
                stays disabled. Manual requirements stay visible. */}
            {!((setupMode && ultralyticsSetup && ultralyticsSetup.status === "unavailable") || (setupMode && rfdetrSetup && rfdetrSetup.status === "unavailable")) && (
            <div>
              <p className="mb-2 text-sm font-medium text-zinc-700">
                Dependencies
              </p>
              <DependencyPanel
                provider={provider}
                route={route}
                depResults={depResults}
                depCheckLoading={depCheckLoading}
                depCheckError={depCheckError}
                managedRuntimeUpgradeEligible={managedRuntimeUpgradeEligible}
                managedRuntimeUpgradeDisabled={managedRuntimeUpgradeDisabled}
                onManagedRuntimeUpgrade={onManagedRuntimeUpgrade}
              />
            </div>
            )}

            {/* Route-owned setup status (setup-only mode hides export controls) */}
            {setupMode && ultralyticsSetup && ultralyticsHides && (
              <UltralyticsSetupPanel
                status={ultralyticsSetup.status}
                routeTitle={route.title}
                error={ultralyticsSetup.error}
                showRecovery={ultralyticsSetup.showRecovery}
                onRemoveEnvironment={onRemoveEnvironment}
                onRecreateEnvironment={onRecreateEnvironment}
              />
            )}
            {setupMode && rfdetrSetup && rfdetrHides && (
              <RfDetrSetupPanel
                status={rfdetrSetup.status}
                routeTitle={route.title}
                stackKey={rfdetrSetup.stackKey}
                error={rfdetrSetup.error}
                showRecovery={rfdetrSetup.showRecovery}
                onRemoveEnvironment={onRemoveEnvironment}
                onRecreateEnvironment={onRecreateEnvironment}
              />
            )}

            {/* Ticket 11 follow-up: environment Ready, checkpoint inspection running */}
            {rfdetrFollowUpActive && (
              <RfDetrInspectionFollowUpPanel />
            )}

            {/* Ticket 11 failure: environment stays Ready; Retry, file, and manual-variant recovery */}
            {rfdetrFailureActive && rfdetrInspection && (
              <RfDetrInspectionFailurePanel
                error={rfdetrInspection.error}
                failure={rfdetrInspection.failure}
                onRetry={onRetryRfDetrInspection}
                onChooseDifferentFile={onChooseDifferentRfDetrFile}
                onRevealManualVariant={onRevealRfDetrManualVariant}
              />
            )}

            {/* Ticket 11 required: environment Ready without inspection data
                yet (for example before the checkpoint is trusted). Export
                stays hidden; the workspace trust step owns the next action. */}
            {rfdetrInspectionRequiredActive && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-900">Checkpoint inspection required</p>
                <p className="mt-1 text-xs text-amber-900">
                  Trust the checkpoint in the workspace to inspect it before export. No guessed defaults were applied.
                </p>
              </div>
            )}

            {/* Export configuration — hidden as one group until setup and inspection are ready */}
            {exportConfigVisible && (
            <>
            {/* Default options notice + advanced toggle */}
            <div className="space-y-3">
              {!advancedOpen && (
                <p className="text-sm text-zinc-500 text-center">
                  {collapsedSummary}
                </p>
              )}
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
              >
                Advanced Options
                <ChevronDown
                  className={cn(
                    "size-4 transition-transform duration-200",
                    advancedOpen && "rotate-180",
                  )}
                />
              </button>

              {advancedOpen && (
                <OptionsPanel
                  route={route}
                  options={options}
                  onOptionsChange={onOptionsChange}
                  recommendedImgsz={rfdetrSummary?.recommendedImgsz}
                  requiredMultiple={rfdetrSummary?.requiredMultiple}
                />
              )}
            </div>

            {isPendingConsent && missingPackages.length > 0 && (
              <PendingInstallConsent depResults={depResults} missingPackages={missingPackages} />
            )}

            {rfdetrImgszError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-800">{rfdetrImgszError}</p>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-800">{errorMsg}</p>
              </div>
            )}

            {exportStatus === "finished" && publishedPaths.length > 0 && (
              <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                {publishedPaths.length === 1
                  ? `Created ${publishedPaths[0].split(/[\\/]/).pop()}`
                  : `Created ${publishedArtifactCount} artifacts in run ${publishedRun}`}
              </div>
            )}

            {showLog && (
              <div className="rounded-md bg-zinc-950 p-4">
                <ExportLog
                  lines={logLines}
                  status={exportStatus}
                  installPhase={installPhase}
                  preview={commandPreview}
                />
              </div>
            )}
            </>
            )}

            {/* Setup guard — visible in both modes: it also blocks the setup action itself */}
            {setupBlocked && setupConflictMessage && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm text-amber-900">{setupConflictMessage}</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t px-6 py-4">
          {footerMode === "setup" && setupPrimary ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!setupPrimaryEnabled}
                onClick={onSetupRoute}
                title={setupBlocked && setupConflictMessage ? setupConflictMessage : undefined}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {(setupStatusForSpinner === "setting-up" || setupStatusForSpinner === "checking") && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {setupPrimary.label}
              </Button>
            </>
          ) : footerMode === "inspection" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {showRetryInFooter && (
                <Button
                  onClick={onRetryRfDetrInspection}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Retry inspection
                </Button>
              )}
              {rfdetrFollowUpActive && (
                <Button disabled className="bg-primary text-primary-foreground opacity-50">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Inspecting…
                </Button>
              )}
            </>
          ) : (
          <>
          {footerActions.secondary === "stop" ? (
            <Button variant="outline" onClick={onStopExport}>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          ) : footerActions.secondary === "starting" ? (
            <Button variant="outline" disabled>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Starting…
            </Button>
          ) : footerActions.secondary === "export_again" ? (
            <Button variant="outline" onClick={onExport} disabled={isInstalling || setupBlocked || rfdetrImgszError !== null || rfdetrInspectionBlocksExport} title={setupBlocked && setupConflictMessage ? setupConflictMessage : undefined}>
              <Play className="mr-2 h-4 w-4" />
              Export Again
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isInstalling}>
              Cancel
            </Button>
          )}
          {footerActions.primary === "show_folder" ? (
            <Button
              onClick={onShowExportFolder}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              Show in Folder
            </Button>
          ) : (
            <Button
              disabled={exportDisabled}
              onClick={isPendingConsent ? onInstallAndExport : onExport}
              title={setupBlocked && setupConflictMessage ? setupConflictMessage : undefined}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <PrimaryExportActionLabel
                isInstalling={isInstalling}
                isPendingConsent={isPendingConsent}
                involvesUpdate={involvesUpdate}
              />
            </Button>
          )}
          </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
