import { ScrollArea } from "@/components/ui/scroll-area";
import type { ExportStatus, RouteSpec } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

interface ExportLogProps {
  lines: string[];
  status: ExportStatus;
  route?: RouteSpec;
}

function StatusBadge({ status }: { status: ExportStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1 text-xs text-teal-400">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          running
        </span>
      );
    case "finished":
      return <span className="text-xs text-emerald-400">finished</span>;
    case "failed":
      return <span className="text-xs text-red-400">failed</span>;
    case "cancelled":
      return <span className="text-xs text-amber-400">cancelled</span>;
    case "idle":
    default:
      return <span className="text-xs text-zinc-400">idle</span>;
  }
}

export function ExportLog({ lines, status, route }: ExportLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-100">Export log</span>
        <StatusBadge status={status} />
      </div>
      <ScrollArea className="h-[152px] rounded-md bg-black/30">
        <pre className="p-3 text-xs leading-6 text-zinc-300">
          {lines.length === 0
            ? `$ yolo export model=best.pt format=${route?.targetFormat ?? "onnx"}\nstdout and stderr will stream here.`
            : lines.join("\n")}
          <div ref={bottomRef} />
        </pre>
      </ScrollArea>
    </div>
  );
}
