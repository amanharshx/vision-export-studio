// Route-owned RF-DETR setup state for ticket 10.
//
// Each export route maps to exactly one isolated stack environment
// (ONNX and ExecuTorch share `rfdetr-default` but keep per-route readiness:
// the stack alone never marks a route ready). The modal opens in a
// setup-only mode until the exact selected route reports ready, then
// transforms into the export configuration. Only the selected stack is ever
// created; `rfdetr-default` is never created for inspection or as an implicit
// prerequisite for another stack.
//
// The per-route readiness policy and footer action are intentionally shared
// with the Ultralytics flow (import them from there): ready comes only from
// the selected route's own dependency results. This module owns only what
// differs for RF-DETR: the stack-scoped fallback, install selection, host
// refusal, hiding, and stack-aware copy.

import type {
  DepCheckResult,
  InstallableDependency,
  ProviderId,
  RfDetrInspectResult,
  RfDetrInspectStatus,
  RfDetrVariantMode,
  RouteSpec,
} from "@/lib/types";
import type { HostSupportResult } from "@/lib/tauri/app";
import {
  installSpecFromHint,
  type RouteDepCheck,
  type UltralyticsRouteSetupStatus,
} from "./ultralytics-route-setup";
import { getInstallableMissingPackages } from "./install-packages";
import { getRfDetrPlusBlockReason, type RfDetrTrustedCheckpoint } from "./rfdetr-trust";

export type RfDetrRouteSetupStatus = UltralyticsRouteSetupStatus;

/** Hide options, Advanced settings, command preview, and Start export while setup is incomplete. */
export function shouldHideRfDetrExportControls(
  providerId: ProviderId,
  status: RfDetrRouteSetupStatus,
): boolean {
  if (providerId !== "rfdetr") return false;
  return status !== "ready";
}

/**
 * Fallback install list when the selected stack is absent and no dependency
 * check could run: only the selected route's required (non-optional)
 * packages, using each dependency's declared install remedy (e.g.
 * `rfdetr[onnx]`, `rfdetr[tensorrt]`, `rfdetr[coreml]`,
 * `rfdetr[tflite]>=1.9.4`, `rfdetr[executorch]>=1.9.0` plus torch and
 * pre-release flatc). Other provider environments remain untouched.
 */
export function getRfDetrRouteSetupFallbackPackages(route: RouteSpec): InstallableDependency[] {
  const packages = route.pipDeps
    .filter((dep) => !(dep.optional ?? false))
    .map((dep) => installSpecFromHint(dep.installHint) ?? dep.packageName);
  return [...new Set(packages)].map((packageName) => {
    const prerelease = packageName === "flatc";
    return { package: packageName, prerelease };
  });
}

export interface RfDetrSetupInstallTarget {
  /** True when the selected stack still needs creating or repair. */
  needsWork: boolean;
}

/**
 * Authoritative install list for one RF-DETR route's setup. A missing stack
 * always installs the full route fallback: a check that ran against another
 * interpreter must never decide what lands in the fresh stack. Missing-only
 * results are used solely when the stack already exists and the check ran
 * for this exact route.
 */
export function getRfDetrSetupInstallPackages(
  route: RouteSpec,
  check: RouteDepCheck,
  target: RfDetrSetupInstallTarget,
): InstallableDependency[] {
  if (target.needsWork) {
    return getRfDetrRouteSetupFallbackPackages(route);
  }
  if (check.results && check.routeId === route.id) {
    return getInstallableMissingPackages(check.results);
  }
  return getRfDetrRouteSetupFallbackPackages(route);
}

/**
 * Authoritative host refusal for one RF-DETR route's setup, checked before
 * any environment work starts. Returns the exact reason when the host is
 * already known to be incompatible (authoritative host support or the
 * backend dependency preflight), so a doomed large installation never
 * starts; null when setup may proceed.
 */
export function getRfDetrSetupHostRefusal(
  routeId: string,
  hostResults: HostSupportResult[] | null,
  check: RouteDepCheck,
): string | null {
  const host = hostResults?.find((result) => result.route_id === routeId) ?? null;
  if (host && (host.status === "unsupported" || host.status === "error")) {
    return host.reason ?? `This format is not supported on this machine.`;
  }
  if (check.routeId === routeId && check.results) {
    const blocked = check.results.find((result) => result.status === "platform_unsupported");
    if (blocked) return blocked.reason;
  }
  return null;
}

export interface RfDetrRouteSetupCopy {
  title: string;
  body: string;
}

/**
 * Honest, percentage-free copy for every RF-DETR setup-only modal state. A
 * null stack key means the backend-owned mapping has not resolved yet (no
 * inventory and no setup task); the copy then names the route's environment
 * without inventing a key — a route id is never an environment name.
 */
export function getRfDetrRouteSetupCopy(
  status: RfDetrRouteSetupStatus,
  routeTitle: string,
  stackKey: string | null,
): RfDetrRouteSetupCopy {
  const env = stackKey ?? `this route's required environment`;
  switch (status) {
    case "checking":
      return {
        title: "Checking…",
        body: `Checking the ${env} and dependencies for ${routeTitle}.`,
      };
    case "not-set-up":
      return {
        title: "Not set up",
        body: `Set up ${routeTitle} to create only the ${env} and install only this route's required packages. Other environments stay untouched.`,
      };
    case "setting-up":
      return {
        title: "Setting up…",
        body: `Creating the ${env} and installing ${routeTitle} dependencies. You can keep browsing; setup continues in the background.`,
      };
    case "setup-incomplete":
      return {
        title: "Setup incomplete",
        body: "The partially created environment was preserved. Retry continues in the same environment. Recreate removes only this route's environment and sets it up again, after confirmation.",
      };
    case "ready":
      return { title: "Ready", body: `${routeTitle} is ready for export.` };
    case "unavailable":
      return {
        title: "Unavailable",
        body: `${routeTitle} is not available on this machine. Setup is disabled for this route.`,
      };
    case "manual-step-required":
      return {
        title: "Manual step required",
        body: "This route needs a manual step before setup. Follow the requirement below, then check again.",
      };
    case "check-failed":
      return {
        title: "Check failed",
        body: "The dependency check failed. Retry setup to try again.",
      };
  }
}

/**
 * Post-install verification for one RF-DETR route's setup: returns an error
 * message when installable requirements are still unmet after pip success,
 * so the app-wide task fails instead of reporting Ready. Rows without an
 * install remedy (manual Python floors, platform locks) are not failures:
 * the route keeps its distinct manual/unavailable state.
 */
export function getRfDetrSetupVerifyError(results: DepCheckResult[] | null): string | null {
  // Only rows with an install remedy count: manual floors and platform
  // locks carry no install_package and stay distinct non-failure states.
  const unmet = getInstallableMissingPackages(results);
  if (unmet.length === 0) return null;
  return `RF-DETR dependencies still missing after install: ${unmet.map((pkg) => pkg.package).join(", ")}. Review requirements before export.`;
}

// ---------------------------------------------------------------------------
// Ticket 11: resume RF-DETR inspection after the selected stack becomes ready.
// ---------------------------------------------------------------------------

export interface RfDetrInspectionResumeInput {
  setupSucceeded: boolean;
  /** Route the finished setup task ran for; null when unknown (never resumes). */
  setupRouteId: string | null;
  /** Currently selected route; must match the setup route. */
  selectedRouteId: string;
  sourcePath: string;
  trust: RfDetrTrustedCheckpoint | null;
  inspectStatus: RfDetrInspectStatus;
}

/**
 * Resume eligibility after successful route setup. True only when the setup
 * that just finished ran for the still-selected route, the same trusted
 * checkpoint remains selected, and its inspection previously failed
 * (typically for want of a healthy stack). A changed or cleared model, an
 * unknown setup route, or a route mismatch suppresses the resume so an old
 * checkpoint is never inspected and another route's state is never touched.
 */
export function shouldResumeRfDetrInspectionAfterSetup(
  input: RfDetrInspectionResumeInput,
): boolean {
  if (!input.setupSucceeded) return false;
  if (input.setupRouteId == null || input.setupRouteId !== input.selectedRouteId) return false;
  if (!input.sourcePath) return false;
  if (!input.trust) return false;
  if (input.trust.sourcePath !== input.sourcePath) return false;
  return input.inspectStatus === "failed";
}

export interface RfDetrInspectionReadinessInput {
  status: RfDetrInspectStatus;
  result: RfDetrInspectResult | null;
  variantMode: RfDetrVariantMode;
  manualClassSymbol: string;
}

/**
 * Inspection readiness for export configuration. Plus-only checkpoints are
 * never ready, even with an explicit manual variant. Otherwise ready when
 * the checkpoint was detected with a known variant (including incomplete
 * geometry with known constraints, which the options panel presents as a
 * labelled fallback) or when a manual variant was explicitly selected after
 * a load failure. Unknown variants never unlock variant-level fallback.
 */
export function isRfDetrInspectionReadyForExport(
  input: RfDetrInspectionReadinessInput,
): boolean {
  if (getRfDetrPlusBlockReason(input.result)) return false;
  if (input.variantMode === "manual") return input.manualClassSymbol.trim().length > 0;
  if (input.status !== "detected") return false;
  return canUseRfDetrVariantFallback({
    result: input.result,
    variantMode: input.variantMode,
    manualClassSymbol: input.manualClassSymbol,
  });
}

/**
 * Hide export configuration until both the route environment and the
 * checkpoint inspection are ready. Setup unreadiness hides first (shared
 * with the setup-only primitive); a Ready environment still hides while
 * inspection has not produced usable data.
 */
export function shouldHideRfDetrExportControlsUntilInspected(
  providerId: ProviderId,
  setupStatus: RfDetrRouteSetupStatus,
  inspectionReady: boolean,
): boolean {
  if (providerId !== "rfdetr") return false;
  if (shouldHideRfDetrExportControls(providerId, setupStatus)) return true;
  return !inspectionReady;
}

export type RfDetrInspectionFollowUpPhase = "inspecting-checkpoint" | null;

/**
 * Named follow-up phase shown after the environment reports Ready while the
 * resumed inspection is still running. Returns null otherwise so setup
 * readiness is never relabelled: the environment stays Ready while the
 * checkpoint phase runs beside it.
 */
export function getRfDetrInspectionFollowUpPhase(
  setupStatus: RfDetrRouteSetupStatus,
  inspectStatus: RfDetrInspectStatus,
): RfDetrInspectionFollowUpPhase {
  if (setupStatus === "ready" && inspectStatus === "inspecting") return "inspecting-checkpoint";
  return null;
}

export function getRfDetrInspectionFollowUpCopy(): RfDetrRouteSetupCopy {
  return {
    title: "Inspecting checkpoint…",
    body: "The environment is ready. Inspecting the trusted checkpoint to load model details. You can keep browsing; this continues in the background.",
  };
}

export interface RfDetrInspectionFailureActions {
  canRetry: boolean;
  showManualVariant: boolean;
  showFileAction: boolean;
}

/**
 * Failure recovery without guessed defaults. Load failures offer Retry
 * inspection, an explicit manual-variant path, and a file action. Plus-only
 * checkpoints offer only the file action: Retry cannot help and manual
 * selection must not bypass support policy.
 */
export function getRfDetrInspectionFailureActions(input: {
  status: RfDetrInspectStatus;
  result: RfDetrInspectResult | null;
}): RfDetrInspectionFailureActions {
  const idle: RfDetrInspectionFailureActions = {
    canRetry: false,
    showManualVariant: false,
    showFileAction: false,
  };
  if (input.status !== "failed" || !input.result || input.result.success) return idle;
  if (getRfDetrPlusBlockReason(input.result)) {
    return { canRetry: false, showManualVariant: false, showFileAction: true };
  }
  return { canRetry: true, showManualVariant: true, showFileAction: true };
}

/** Standard presets offered as an explicit fallback when native size is unknown. */
const RFDETR_FALLBACK_PRESETS = [384, 512, 560, 576, 640, 704, 768];

/**
 * First standard preset divisible by the known model block size, or null when
 * constraints are unknown. Labelled as a fallback by callers, never as native.
 */
export function getRfDetrFallbackPreset(requiredMultiple: number | null): number | null {
  if (requiredMultiple == null || requiredMultiple <= 0) return null;
  return RFDETR_FALLBACK_PRESETS.find((preset) => preset % requiredMultiple === 0) ?? null;
}

/**
 * Variant-level fallback is allowed only with a known or explicitly selected
 * variant: a detected class in auto mode, or a non-empty manual selection.
 * Unknown variants must not invent constraints.
 */
export function canUseRfDetrVariantFallback(input: {
  result: RfDetrInspectResult | null;
  variantMode: RfDetrVariantMode;
  manualClassSymbol: string;
}): boolean {
  if (input.variantMode === "manual") return input.manualClassSymbol.trim().length > 0;
  return Boolean(input.result?.success && input.result.class_symbol);
}

/**
 * Compact detected-geometry summary: variant, native size, geometry source,
 * and compatible-size requirement. Null when there is no successful
 * inspection to report, so callers show the failure path instead.
 */
export function formatRfDetrInspectionSummary(
  result: RfDetrInspectResult | null,
): string | null {
  if (!result?.success || !result.class_symbol) return null;
  const parts = [result.class_symbol];
  if (result.recommended_imgsz != null) parts.push(`native ${result.recommended_imgsz}px`);
  if (result.resolution_source) parts.push(`source ${result.resolution_source}`);
  if (result.required_multiple != null) parts.push(`multiple ${result.required_multiple}`);
  return parts.join(" · ");
}
