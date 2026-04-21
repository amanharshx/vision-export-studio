import { Badge } from "@/components/ui/badge";
import type { RouteSpec } from "@/lib/types";
import { PackageCheck, TerminalSquare } from "lucide-react";

interface DependencyPanelProps {
  route: RouteSpec;
}

export function DependencyPanel({ route }: DependencyPanelProps) {
  const baseDeps = [{ packageName: "ultralytics", installHint: "pip install ultralytics" }];

  return (
    <div className="space-y-2">
      {[...baseDeps, ...route.pipDeps].map((dep) => (
        <div
          key={dep.packageName}
          className="flex items-center justify-between gap-3 rounded-md border border-zinc-900/10 bg-zinc-50 px-3 py-2 text-sm"
        >
          <span className="flex items-center gap-2 font-medium text-zinc-900">
            <PackageCheck className="size-4 text-teal-700" aria-hidden="true" />
            {dep.packageName}
          </span>
          <span className="truncate text-zinc-500">{dep.installHint}</span>
        </div>
      ))}
      {route.sysDeps.map((dep) => (
        <div
          key={dep.binaryName}
          className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span className="flex items-center gap-2 font-medium">
            <TerminalSquare className="size-4" aria-hidden="true" />
            {dep.binaryName}
          </span>
          <span className="truncate">{dep.installHint}</span>
        </div>
      ))}
      {route.pipDeps.length === 0 && route.sysDeps.length === 0 ? (
        <Badge variant="outline" className="rounded-md border-teal-200 bg-teal-50 text-teal-800">
          Base Ultralytics stack only
        </Badge>
      ) : null}
    </div>
  );
}
