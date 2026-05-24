import { Badge } from "@/components/ui/badge";
import type { DepCheckResult, RouteSpec } from "@/lib/types";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, PackageCheck, TerminalSquare, XCircle } from "lucide-react";

interface DependencyPanelProps {
  route: RouteSpec;
  depResults?: DepCheckResult[];
  depCheckLoading?: boolean;
  depCheckError?: string | null;
}

function statusIcon(status: DepCheckResult["status"]) {
  switch (status) {
    case "ready":
      return <CheckCircle2 className="size-4 shrink-0 text-teal-600" aria-label="Ready" />;
    case "missing_package":
    case "missing_binary":
      return <XCircle className="size-4 shrink-0 text-red-600" aria-label="Missing" />;
    case "warning":
    case "platform_unsupported":
      return <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-label="Warning" />;
    case "unknown":
    default:
      return <HelpCircle className="size-4 shrink-0 text-zinc-400" aria-label="Unknown" />;
  }
}

export function DependencyPanel({
  route,
  depResults,
  depCheckLoading,
  depCheckError,
}: DependencyPanelProps) {
  const baseDeps = [{ packageName: "ultralytics", installHint: "pip install ultralytics" }];

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
      {[...baseDeps, ...route.pipDeps].map((dep) => {
        const result = depResults?.find((r) => r.item === dep.packageName);
        return (
          <div
            key={dep.packageName}
            className="flex items-center justify-between gap-3 rounded-md border border-zinc-900/10 bg-zinc-50 px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2 font-medium text-zinc-900">
              {depCheckLoading ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-zinc-300" aria-hidden="true" />
              ) : result ? (
                statusIcon(result.status)
              ) : (
                <PackageCheck className="size-4 text-teal-700" aria-hidden="true" />
              )}
              {dep.packageName}
            </span>
            <span className="truncate text-zinc-500">{dep.installHint}</span>
          </div>
        );
      })}
      {route.sysDeps.map((dep) => {
        const result = depResults?.find((r) => r.item === dep.binaryName);
        return (
          <div
            key={dep.binaryName}
            className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <span className="flex items-center gap-2 font-medium">
              {depCheckLoading ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-amber-300" aria-hidden="true" />
              ) : result ? (
                statusIcon(result.status)
              ) : (
                <TerminalSquare className="size-4" aria-hidden="true" />
              )}
              {dep.binaryName}
            </span>
            <span className="truncate">{dep.installHint}</span>
          </div>
        );
      })}
      {route.pipDeps.length === 0 && route.sysDeps.length === 0 ? (
        <Badge variant="outline" className="rounded-md border-teal-200 bg-teal-50 text-teal-800">
          Base Ultralytics stack only
        </Badge>
      ) : null}
    </div>
  );
}
