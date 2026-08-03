import type { DepCheckResult, ProviderSpec, RouteSpec } from "@/lib/types";
import { AlertTriangle, CheckCircle2, CloudDownload, HelpCircle, Loader2, PackageCheck, TerminalSquare, XCircle } from "lucide-react";

interface DependencyPanelProps {
  provider: ProviderSpec;
  route: RouteSpec;
  depResults?: DepCheckResult[];
  depCheckLoading?: boolean;
  depCheckError?: string | null;
}

export interface DepItem {
  name: string;
  installHint: string;
  optional: boolean;
}

function findDepResult(depResults: DepCheckResult[] | undefined, name: string): DepCheckResult | undefined {
  return depResults?.find((result) => result.item === name);
}

// 0 = installed/ready, 1 = required auto-installable (missing package/unknown/
// updateable version), 2 = required manual-only remediation, 3 = optional
export function depGroup(dep: DepItem, result: DepCheckResult | undefined): number {
  if (dep.optional) return 3;
  if (!result) return 0;
  switch (result.status) {
    case "ready":
    case "warning":
      return 0;
    case "missing_package":
    case "unknown":
      return 1;
    case "version_too_old":
      return result.install_package ? 1 : 2;
    case "missing_binary":
      return dep.installHint.startsWith("pip install ") ? 1 : 2;
    default:
      return 0;
  }
}

export function depIcon(result: DepCheckResult | undefined, installHint: string) {
  if (!result) return <PackageCheck className="size-4 text-teal-700" aria-hidden="true" />;
  switch (result.status) {
    case "ready":
      return <CheckCircle2 className="size-4 shrink-0 text-teal-600" aria-label="Ready" />;
    case "warning":
      return <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-label="Optional" />;
    case "missing_package":
      return <CloudDownload className="size-4 shrink-0 text-blue-500" aria-label="Will be installed" />;
    case "version_too_old":
      return result.install_package ? (
        <CloudDownload className="size-4 shrink-0 text-blue-500" aria-label="Will be installed" />
      ) : (
        <XCircle className="size-4 shrink-0 text-red-600" aria-label="Manual install required" />
      );
    case "missing_binary":
      return installHint.startsWith("pip install ") ? (
        <CloudDownload className="size-4 shrink-0 text-blue-500" aria-label="Will be installed" />
      ) : (
        <XCircle className="size-4 shrink-0 text-red-600" aria-label="Manual install required" />
      );
    default:
      return <HelpCircle className="size-4 shrink-0 text-zinc-400" aria-label="Unknown" />;
  }
}

export function buildDependencyItems(
  provider: ProviderSpec,
  route: RouteSpec,
  depResults?: DepCheckResult[],
): DepItem[] {
  const declaredItems: DepItem[] = [
    ...provider.baseDeps.map((dep) => ({
      name: dep.packageName,
      installHint: dep.installHint,
      optional: dep.optional ?? false,
    })),
    ...route.pipDeps.map((dep) => ({
      name: dep.packageName,
      installHint: dep.installHint,
      optional: dep.optional ?? false,
    })),
    ...route.sysDeps.map((dep) => ({
      name: dep.binaryName,
      installHint: dep.installHint,
      optional: dep.optional ?? false,
    })),
  ];

  const results = depResults ?? [];

  const resolvedDeclared =
    results.length > 0
      ? declaredItems.filter((item) => findDepResult(results, item.name))
      : declaredItems;

  const extraRows = results.flatMap((result) => {
    if (result.status !== "version_too_old" && result.status !== "platform_unsupported") return [];
    if (declaredItems.some((item) => item.name === result.item)) return [];
    return [
      {
        name: result.item,
        installHint: result.install_hint,
        optional: false,
      },
    ];
  });

  return [...resolvedDeclared, ...extraRows];
}

export function sortDependencyItems(depItems: DepItem[], depResults?: DepCheckResult[]): DepItem[] {
  return [...depItems].sort((a, b) => {
    const ra = findDepResult(depResults, a.name);
    const rb = findDepResult(depResults, b.name);
    return depGroup(a, ra) - depGroup(b, rb);
  });
}

export function DependencyPanel({
  provider,
  route,
  depResults,
  depCheckLoading,
  depCheckError,
}: DependencyPanelProps) {
  const sorted = sortDependencyItems(buildDependencyItems(provider, route, depResults), depResults);

  return (
    <div className="space-y-2">
      {depCheckLoading && (
        <p className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          Checking...
        </p>
      )}
      {depCheckError && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Could not check dependencies: {depCheckError}
        </p>
      )}
      {sorted.map((dep) => {
        const result = findDepResult(depResults, dep.name);
        const isVersionTooOld = result?.status === "version_too_old";
        const displayHint = isVersionTooOld ? result.install_hint : dep.installHint;
        const reason = isVersionTooOld ? result.reason.trim() : undefined;
        const isManualRemediation = depGroup(dep, result) === 2;

        return isManualRemediation ? (
          <div
            key={dep.name}
            className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium">
                {depCheckLoading ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-amber-300" aria-hidden="true" />
                ) : result ? (
                  depIcon(result, displayHint)
                ) : (
                  <TerminalSquare className="size-4" aria-hidden="true" />
                )}
                {dep.name}
              </span>
              {reason && <span className="ml-6 text-xs text-amber-700">{reason}</span>}
            </span>
            <span className="min-w-0 truncate">{displayHint}</span>
          </div>
        ) : (
          <div
            key={dep.name}
            className="flex items-center justify-between gap-3 rounded-md border border-zinc-900/10 bg-zinc-50 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium text-zinc-900">
                {depCheckLoading ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-zinc-300" aria-hidden="true" />
                ) : (
                  depIcon(result, displayHint)
                )}
                {dep.name}
              </span>
              {reason && <span className="ml-6 text-xs text-zinc-500">{reason}</span>}
            </span>
            <span className="min-w-0 truncate text-zinc-500">{displayHint}</span>
          </div>
        );
      })}
    </div>
  );
}
