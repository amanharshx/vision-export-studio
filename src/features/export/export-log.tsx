import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RouteSpec } from "@/lib/types";

interface ExportLogProps {
  route: RouteSpec;
}

export function ExportLog({ route }: ExportLogProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-100">Export log</span>
        <span className="text-xs text-zinc-400">idle</span>
      </div>
      <Progress value={0} className="bg-zinc-800" />
      <ScrollArea className="h-[152px] rounded-md bg-black/30">
        <pre className="p-3 text-xs leading-6 text-zinc-300">
{`$ yolo export model=best.pt format=${route.targetFormat}
stdout and stderr will stream here.`}
        </pre>
      </ScrollArea>
    </div>
  );
}
