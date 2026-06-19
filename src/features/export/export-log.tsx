import { ScrollArea } from "@/components/ui/scroll-area";
import type { ExportStatus, InstallPhase } from "@/lib/types";
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ExportLogProps {
  lines: string[];
  status: ExportStatus;
  installPhase: InstallPhase;
  preview: string;
}

type LogStatusTone = "active" | "success" | "error" | "warning" | "muted";

interface LogStatusBadge {
  label: string;
  tone: LogStatusTone;
  spinner: boolean;
}

export function getLogStatusLabel(status: ExportStatus, installPhase: InstallPhase): string {
  return getLogStatusBadge(status, installPhase).label;
}

export function getLogStatusBadge(status: ExportStatus, installPhase: InstallPhase): LogStatusBadge {
  if (installPhase === "installing") {
    return { label: "Installing", tone: "active", spinner: true };
  }

  switch (status) {
    case "starting":
      return { label: "Starting", tone: "active", spinner: true };
    case "running":
      return { label: "Running", tone: "active", spinner: true };
    case "finished":
      return { label: "Success", tone: "success", spinner: false };
    case "failed":
      return { label: "Failed", tone: "error", spinner: false };
    case "cancelled":
      return { label: "Cancelled", tone: "warning", spinner: false };
    case "idle":
    default:
      return { label: "Preparing", tone: "muted", spinner: false };
  }
}

function StatusBadge({ status, installPhase }: { status: ExportStatus; installPhase: InstallPhase }) {
  const badge = getLogStatusBadge(status, installPhase);
  const toneClass = {
    active: "text-teal-400",
    success: "text-emerald-400",
    error: "text-red-400",
    warning: "text-amber-400",
    muted: "text-zinc-400",
  }[badge.tone];

  return (
    <span className={`flex items-center gap-1 text-xs ${toneClass}`}>
      {badge.spinner && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
      {badge.label}
    </span>
  );
}

export function ExportLog({ lines, status, installPhase, preview }: ExportLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  function handleCopy() {
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-100">Logs</span>
        <StatusBadge status={status} installPhase={installPhase} />
      </div>
      <ScrollArea className="h-[152px] rounded-md bg-black/30">
        <pre className="p-3 text-xs leading-6 text-zinc-300">
          {lines.length === 0
            ? `$ ${preview}\nstdout and stderr will stream here.`
            : lines.join("\n")}
          <div ref={bottomRef} />
        </pre>
      </ScrollArea>
      {lines.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
