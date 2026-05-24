import { formatIconMap } from "@/components/format-icons";
import { formats } from "@/lib/routes";
import { getOS, isCompatible } from "@/lib/platform";
import type { RouteSpec } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronRight, Cpu, Layers, Zap } from "lucide-react";

const categoryIconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  intermediate: Layers,
  runtime: Cpu,
  vendor: Zap,
};

const categoryBgMap: Record<string, string> = {
  intermediate: "bg-zinc-100 text-zinc-700",
  runtime: "bg-zinc-100 text-zinc-700",
  vendor: "bg-rose-100 text-rose-700",
};

export function categoryIcon(category: string) {
  return categoryIconMap[category] ?? Cpu;
}

export function categoryBg(category: string) {
  return categoryBgMap[category] ?? "bg-zinc-100 text-zinc-700";
}

const os = getOS();

interface RouteRowProps {
  route: RouteSpec;
  onSelect: () => void;
}

export function RouteRow({ route, onSelect }: RouteRowProps) {
  const format = formats[route.targetFormat];
  const formatIcon = formatIconMap[format.id];
  const Icon = formatIcon ?? categoryIcon(format.category);
  const bg = formatIcon ? "bg-white text-zinc-800" : categoryBg(format.category);
  const compatible = isCompatible(route.platformLock, os);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-4 rounded-lg border border-zinc-900/10 bg-white px-4 py-3 text-left transition-colors hover:bg-zinc-50",
        !compatible && "opacity-50",
      )}
    >
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300" />
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
          bg,
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-zinc-900">{route.title}</span>
        <p className="mt-0.5 font-mono text-xs text-zinc-400">
          format={route.targetFormat}
        </p>
      </div>
    </button>
  );
}
