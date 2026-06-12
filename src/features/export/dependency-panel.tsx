import type { DepCheckResult, ProviderSpec, RouteSpec } from "@/lib/types";
import { AlertTriangle, CheckCircle2, CloudDownload, HelpCircle, Loader2, PackageCheck, TerminalSquare, XCircle } from "lucide-react";

interface DependencyPanelProps {
  provider: ProviderSpec;
  route: RouteSpec;
  depResults?: DepCheckResult[];
  depCheckLoading?: boolean;
  depCheckError?: string | null;
}

interface DepItem {
  name: string;
  installHint: string;
}

// 0 = ready/warning, 1 = auto-installable missing, 2 = manual-only missing, 3 = unknown
function depGroup(result: DepCheckResult | undefined, installHint: string): number {
  if (!result) return 0;
  switch (result.status) {
    case "ready":
    case "warning":
      return 0;
    case "missing_package":
      return 1;
    case "missing_binary":
      return installHint.startsWith("pip install ") ? 1 : 2;
    default:
      return 3;
  }
}

function depIcon(result: DepCheckResult | undefined, installHint: string) {
  if (!result) return <PackageCheck className="size-4 text-teal-700" aria-hidden="true" />;
  switch (result.status) {
    case "ready":
      return <CheckCircle2 className="size-4 shrink-0 text-teal-600" aria-label="Ready" />;
    case "warning":
      return <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-label="Optional" />;
    case "missing_package":
      return <CloudDownload className="size-4 shrink-0 text-blue-500" aria-label="Will be installed" />;
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

export function DependencyPanel({
  provider,
  route,
  depResults,
  depCheckLoading,
  depCheckError,
}: DependencyPanelProps) {
  const allItems: DepItem[] = [
    ...provider.baseDeps.map((d) => ({ name: d.packageName, installHint: d.installHint })),
    ...route.pipDeps.map((d) => ({ name: d.packageName, installHint: d.installHint })),
    ...route.sysDeps.map((d) => ({ name: d.binaryName, installHint: d.installHint })),
  ];

  const sorted = [...allItems].sort((a, b) => {
    const ra = depResults?.find((r) => r.item === a.name);
    const rb = depResults?.find((r) => r.item === b.name);
    return depGroup(ra, a.installHint) - depGroup(rb, b.installHint);
  });

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
        const result = depResults?.find((r) => r.item === dep.name);
        const isManualBinary = depGroup(result, dep.installHint) === 2;

        return isManualBinary ? (
          <div
            key={dep.name}
            className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <span className="flex items-center gap-2 font-medium">
              {depCheckLoading ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-amber-300" aria-hidden="true" />
              ) : result ? (
                depIcon(result, dep.installHint)
              ) : (
                <TerminalSquare className="size-4" aria-hidden="true" />
              )}
              {dep.name}
            </span>
            <span className="min-w-0 truncate">{dep.installHint}</span>
          </div>
        ) : (
          <div
            key={dep.name}
            className="flex items-center justify-between gap-3 rounded-md border border-zinc-900/10 bg-zinc-50 px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2 font-medium text-zinc-900">
              {depCheckLoading ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-zinc-300" aria-hidden="true" />
              ) : (
                depIcon(result, dep.installHint)
              )}
              {dep.name}
            </span>
            <span className="min-w-0 truncate text-zinc-500">{dep.installHint}</span>
          </div>
        );
      })}
    </div>
  );
}
