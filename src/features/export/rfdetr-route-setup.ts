// Route-owned RF-DETR setup state for ticket 10.
//
// Each export route maps to exactly one isolated stack environment
// (ONNX and ExecuTorch share `rfdetr-default` but keep per-route readiness:
// the stack alone never marks a route ready). The modal opens in a
// setup-only mode until the exact selected route reports ready, then
// transforms into the export configuration. Only the selected stack is ever
// created; `rfdetr-default` is never created for inspection or as an implicit
// prerequisite for another stack.

import type {
  DepCheckResult,
  InstallableDependency,
  ProviderId,
  ProviderSpec,
  RouteSpec,
} from "@/lib/types";
import {
  getUltralyticsRouteSetupPrimaryAction,
  getUltralyticsRouteSetupStatus,
  installSpecFromHint,
  type RouteDepCheck,
  type UltralyticsRouteSetupStatus,
  type UltralyticsSetupPrimaryAction,
} from "./ultralytics-route-setup";

/**
 * Installable packages missing for the selected route. Mirrors
 * `getInstallableMissingPackages` in export-workspace without importing it
 * (that module imports this one for setup status, so an import would be a
 * cycle): backend-reported `install_package` remedies win, `missing_binary`
 * rows fall back to their pip spec, and duplicates collapse.
 */
function getRfDetrMissingPackages(results: DepCheckResult[] | null): InstallableDependency[] {
  if (!results) return [];
  const packages = results.flatMap((result): InstallableDependency[] => {
    if (result.install_package) {
      return [{ package: result.install_package, prerelease: result.prerelease === true }];
    }
    if (result.status === "missing_binary") {
      const spec = installSpecFromHint(result.install_hint);
      return spec ? [{ package: spec, prerelease: false }] : [];
    }
    return [];
  });
  return packages.filter((dependency, index) =>
    packages.findIndex((candidate) => candidate.package === dependency.package) === index,
  );
}

export type RfDetrRouteSetupStatus = UltralyticsRouteSetupStatus;

export interface RfDetrRouteSetupStateInput {
  hostStatus: "supported" | "unsupported" | "checking" | "error";
  depResults: DepCheckResult[] | null;
  depCheckLoading: boolean;
  depCheckError: string | null;
  setupActive: boolean;
  setupFailed: boolean;
}

/**
 * Single per-route readiness decision for RF-DETR routes. The shared
 * stack never marks a route ready: readiness comes only from the selected
 * route's own dependency results, so ONNX and ExecuTorch keep independent
 * readiness while using `rfdetr-default`. `setupFailed` must be scoped by
 * the caller to the route the failed task was setting up.
 */
export function getRfDetrRouteSetupStatus(
  input: RfDetrRouteSetupStateInput,
): RfDetrRouteSetupStatus {
  return getUltralyticsRouteSetupStatus(input);
}

/** Hide options, Advanced settings, command preview, and Start export while setup is incomplete. */
export function shouldHideRfDetrExportControls(
  providerId: ProviderId,
  status: RfDetrRouteSetupStatus,
): boolean {
  if (providerId !== "rfdetr") return false;
  return status !== "ready";
}

/** Footer action for the setup-only modal; the export path owns the footer once ready. */
export function getRfDetrRouteSetupPrimaryAction(
  status: RfDetrRouteSetupStatus,
  actionLabel: string,
): UltralyticsSetupPrimaryAction {
  return getUltralyticsRouteSetupPrimaryAction(status, actionLabel);
}

/**
 * Fallback install list when the selected stack is absent and no dependency
 * check could run: only the selected route's required (non-optional)
 * packages, using each dependency's declared install remedy (e.g.
 * `rfdetr[onnx]`, `rfdetr[tensorrt]`, `rfdetr[coreml]`,
 * `rfdetr[tflite]>=1.9.4`, `rfdetr[executorch]>=1.9.0` plus torch and
 * pre-release flatc). Other provider environments remain untouched.
 */
export function getRfDetrRouteSetupFallbackPackages(
  _provider: ProviderSpec,
  route: RouteSpec,
): InstallableDependency[] {
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
  /** Stack interpreter the install lands in. */
  pythonPath: string;
  /** Backend-resolved stack key for the selected route. */
  stackKey: string;
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
    return getRfDetrRouteSetupFallbackPackages({} as ProviderSpec, route);
  }
  if (check.results && check.routeId === route.id) {
    return getRfDetrMissingPackages(check.results);
  }
  return getRfDetrRouteSetupFallbackPackages({} as ProviderSpec, route);
}

export interface RfDetrRouteSetupCopy {
  title: string;
  body: string;
}

/** Honest, percentage-free copy for every RF-DETR setup-only modal state. */
export function getRfDetrRouteSetupCopy(
  status: RfDetrRouteSetupStatus,
  routeTitle: string,
  stackKey: string,
): RfDetrRouteSetupCopy {
  switch (status) {
    case "checking":
      return {
        title: "Checking…",
        body: `Checking the ${stackKey} environment and dependencies for ${routeTitle}.`,
      };
    case "not-set-up":
      return {
        title: "Not set up",
        body: `Set up ${routeTitle} to create only the ${stackKey} environment and install only this route's required packages. Other environments stay untouched.`,
      };
    case "setting-up":
      return {
        title: "Setting up…",
        body: `Creating the ${stackKey} environment and installing ${routeTitle} dependencies. You can keep browsing; setup continues in the background.`,
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
