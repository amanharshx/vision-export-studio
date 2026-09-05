// Route-owned Ultralytics setup state for ticket 08.
//
// One shared Ultralytics environment serves every Ultralytics route, but
// readiness is per route: the base environment alone never marks a route
// ready. The modal opens in a setup-only mode until the exact selected route
// reports ready, then transforms into the export configuration.

import type { HostSupportResult } from "@/lib/tauri/app";
import type {
  DepCheckResult,
  InstallableDependency,
  ProviderId,
  ProviderSpec,
  RouteSpec,
} from "@/lib/types";
import { depGroup } from "./dependency-panel";

export type UltralyticsRouteSetupStatus =
  | "checking"
  | "not-set-up"
  | "setting-up"
  | "setup-incomplete"
  | "ready"
  | "unavailable"
  | "manual-step-required"
  | "check-failed";

export interface UltralyticsRouteSetupStateInput {
  hostStatus: HostSupportResult["status"] | "checking";
  depResults: DepCheckResult[] | null;
  depCheckLoading: boolean;
  depCheckError: string | null;
  setupActive: boolean;
  setupFailed: boolean;
}

function hasManualOnlyBlockers(depResults: DepCheckResult[]): boolean {
  return depResults.some((result) => {
    if (result.status === "platform_unsupported") return false;
    return (
      depGroup(
        { name: result.item, installHint: result.install_hint, optional: false },
        result,
      ) === 2
    );
  });
}

export function hasBlockingDependencies(depResults: DepCheckResult[] | null): boolean {
  if (!depResults) {
    return true;
  }

  return depResults.some((result) => result.status !== "ready" && result.status !== "warning");
}

/**
 * Single per-route readiness decision for Ultralytics routes. Route-intrinsic
 * states (platform restrictions, manual steps, ready) win over the shared
 * setup task so one route's failure can never mislabel another route: an
 * unsupported route stays unavailable and a ready route stays ready after an
 * unrelated failure. `setupFailed` must therefore be scoped by the caller to
 * the route the failed task was setting up. Other routes keep their own
 * result: this call never consults shared environment state beyond the given
 * route's inputs.
 */
export function getUltralyticsRouteSetupStatus(
  input: UltralyticsRouteSetupStateInput,
): UltralyticsRouteSetupStatus {
  if (input.hostStatus === "unsupported" || input.hostStatus === "error") {
    return "unavailable";
  }
  // A "checking" host is neutral: export stays allowed while host support
  // resolves (the export path gates only on resolved incompatibility).
  if (input.setupActive) return "setting-up";
  if (input.depCheckLoading) return "checking";
  if (input.depResults) {
    if (input.depResults.some((result) => result.status === "platform_unsupported")) {
      return "unavailable";
    }
    if (hasManualOnlyBlockers(input.depResults)) return "manual-step-required";
    if (!hasBlockingDependencies(input.depResults)) return "ready";
  }
  if (input.setupFailed) return "setup-incomplete";
  if (input.depCheckError) return "check-failed";
  return "not-set-up";
}

/** Hide options, Advanced settings, command preview, and Start export while setup is incomplete. */
export function shouldHideUltralyticsExportControls(
  providerId: ProviderId,
  status: UltralyticsRouteSetupStatus,
): boolean {
  if (providerId !== "ultralytics") return false;
  return status !== "ready";
}

/**
 * One route's dependency check: results and error travel with the id of the
 * route that was checked and the interpreter they were checked against, so a
 * stale check can never drive another route's setup status, install list, or
 * displayed requirements.
 */
export interface RouteDepCheck {
  results: DepCheckResult[] | null;
  routeId: string | null;
  error: string | null;
  pythonPath: string | null;
}

export function emptyRouteDepCheck(): RouteDepCheck {
  return { results: null, routeId: null, error: null, pythonPath: null };
}

/**
 * Gate a check on the route it was run for. Anything else (including a
 * previous route's error) resolves to empty, never to another route's data.
 */
export function selectRouteDepCheck(check: RouteDepCheck, routeId: string): RouteDepCheck {
  if (check.routeId !== routeId) return emptyRouteDepCheck();
  return check;
}

export interface UltralyticsSetupPrimaryAction {
  label: string;
  enabled: boolean;
}

/** Footer action for the setup-only modal; the export path owns the footer once ready. */
export function getUltralyticsRouteSetupPrimaryAction(
  status: UltralyticsRouteSetupStatus,
  actionLabel: string,
): UltralyticsSetupPrimaryAction {
  switch (status) {
    case "not-set-up":
      return { label: actionLabel, enabled: true };
    case "setup-incomplete":
    case "check-failed":
      return { label: "Retry setup", enabled: true };
    case "checking":
      return { label: "Checking…", enabled: false };
    case "setting-up":
      return { label: "Setting up…", enabled: false };
    case "unavailable":
      return { label: "Unavailable", enabled: false };
    case "manual-step-required":
      return { label: "Manual step required", enabled: false };
    case "ready":
      return { label: actionLabel, enabled: false };
  }
}

/**
 * Package spec from a declared install hint (`pip install "pkg[extra]"`).
 * Falls back to null for non-pip hints so callers keep the package name.
 * Quotes are stripped: packages run as pip argv, never through a shell.
 */
export function installSpecFromHint(installHint: string): string | null {
  const prefix = "pip install ";
  if (!installHint.startsWith(prefix)) return null;
  let spec = installHint.slice(prefix.length).trim();
  if (spec.length >= 2 && spec.startsWith('"') && spec.endsWith('"')) {
    spec = spec.slice(1, -1);
  }
  return spec || null;
}

/**
 * Fallback install list when the managed environment is absent and no
 * dependency check could run: the shared base plus the selected route's
 * required (non-optional) packages, using each dependency's declared install
 * remedy (e.g. `axelera-devkit`, `ultralytics[export-litert]`). Once a check
 * has run, callers use its missing packages instead so version pins come
 * from the backend.
 */
export function getUltralyticsRouteSetupFallbackPackages(
  provider: ProviderSpec,
  route: RouteSpec,
): InstallableDependency[] {
  const packages = [
    ...provider.baseDeps
      .filter((dep) => !(dep.optional ?? false))
      .map((dep) => installSpecFromHint(dep.installHint) ?? dep.packageName),
    ...route.pipDeps
      .filter((dep) => !(dep.optional ?? false))
      .map((dep) => installSpecFromHint(dep.installHint) ?? dep.packageName),
  ];
  return [...new Set(packages)].map((packageName) => ({ package: packageName, prerelease: false }));
}

export interface SetupInstallTarget {
  /** True when the shared environment still needs creating or repair. */
  needsWork: boolean;
  /** Managed interpreter the install lands in. */
  pythonPath: string;
}

export interface UltralyticsRouteSetupCopy {
  title: string;
  body: string;
}

/** Honest, percentage-free copy for every setup-only modal state. */
export function getUltralyticsRouteSetupCopy(
  status: UltralyticsRouteSetupStatus,
  routeTitle: string,
): UltralyticsRouteSetupCopy {
  switch (status) {
    case "checking":
      return {
        title: "Checking…",
        body: `Checking the environment and dependencies for ${routeTitle}.`,
      };
    case "not-set-up":
      return {
        title: "Not set up",
        body: `Set up ${routeTitle} to create the shared Ultralytics environment if needed and install only this route's required packages.`,
      };
    case "setting-up":
      return {
        title: "Setting up…",
        body: `Creating the shared environment and installing ${routeTitle} dependencies. You can keep browsing; setup continues in the background.`,
      };
    case "setup-incomplete":
      return {
        title: "Setup incomplete",
        body: "The partially created environment was preserved. Retry continues in the same environment. Recreate removes it and sets it up again, after confirmation.",
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
