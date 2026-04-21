import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formats } from "@/lib/routes";
import type { RouteSpec } from "@/lib/types";
import { cn } from "@/lib/utils";

const categoryClass: Record<string, string> = {
  intermediate: "border-teal-200 bg-teal-50 text-teal-800",
  runtime: "border-zinc-300 bg-zinc-100 text-zinc-800",
  vendor: "border-rose-200 bg-rose-50 text-rose-800",
  source: "border-zinc-200 bg-zinc-50 text-zinc-700",
};

export function categoryTone(category: string) {
  return categoryClass[category] ?? categoryClass.runtime;
}

export function routeBadges(route: RouteSpec) {
  return [
    route.requiresGpu ? "GPU" : null,
    route.oneWay ? "One-way" : null,
    route.lossy ? "Lossy" : null,
    route.needsCalibration ? "Calibration" : null,
    route.platformLock !== "any" ? route.platformLock : null,
  ].filter((badge): badge is string => Boolean(badge));
}

interface RouteCardProps {
  route: RouteSpec;
  active: boolean;
  onSelect: () => void;
}

export function RouteCard({ route, active, onSelect }: RouteCardProps) {
  const format = formats[route.targetFormat];

  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        "h-full min-h-[172px] flex-col items-stretch justify-start gap-3 rounded-md border p-4 text-left shadow-sm",
        active
          ? "border-teal-700 bg-white ring-2 ring-teal-700/20"
          : "border-zinc-900/10 bg-white/75 hover:border-teal-600/50 hover:bg-white",
      )}
      onClick={onSelect}
    >
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="block text-base font-semibold text-zinc-950">{route.title}</span>
          <span className="mt-1 block text-xs leading-5 text-zinc-500">{route.displayPath}</span>
        </span>
        <Badge variant="outline" className={cn("rounded-md", categoryTone(format.category))}>
          {format.category}
        </Badge>
      </span>
      <span className="block text-sm leading-6 text-zinc-600">{route.notes}</span>
    </Button>
  );
}
