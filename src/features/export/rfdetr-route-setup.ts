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
  InstallableDependency,
  ProviderId,
  RouteSpec,
} from "@/lib/types";
import type { HostSupportResult } from "@/lib/tauri/app";
import {
  installSpecFromHint,
  type RouteDepCheck,
  type UltralyticsRouteSetupStatus,
} from "./ultralytics-route-setup";
import { getInstallableMissingPackages } from "./install-packages";

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
