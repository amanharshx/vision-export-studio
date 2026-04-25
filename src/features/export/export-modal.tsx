import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formats } from "@/lib/routes";
import type {
  DepCheckResult,
  ExportOptions,
  ExportStatus,
  RouteSpec,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronDown, Play, Square } from "lucide-react";
import { DependencyPanel } from "./dependency-panel";
import { ExportLog } from "./export-log";
import { OptionsPanel } from "./options-panel";
import { formatIconMap } from "@/components/format-icons";
import { getOS, incompatibleReason, isCompatible, platformTags } from "@/lib/platform";
import { categoryBg, categoryIcon } from "./route-card";

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route: RouteSpec;
  sourcePath: string;
  exportStatus: ExportStatus;
  logLines: string[];
  options: ExportOptions;
  onOptionsChange: (opts: ExportOptions) => void;
  onExport: () => void;
  onStopExport: () => void;
  depResults?: DepCheckResult[];
  depCheckLoading?: boolean;
  depCheckError?: string | null;
}

export function ExportModal({
  open,
  onOpenChange,
  route,
  sourcePath,
  exportStatus,
  logLines,
  options,
  onOptionsChange,
  onExport,
  onStopExport,
  depResults,
  depCheckLoading,
  depCheckError,
}: ExportModalProps) {
  const format = formats[route.targetFormat];
  const formatIcon = formatIconMap[format.id];
  const Icon = formatIcon ?? categoryIcon(format.category);
  const bg = formatIcon ? "bg-white text-zinc-800" : categoryBg(format.category);
  const tags = platformTags(route.platformLock);
  const os = getOS();
  const unsupportedReason = !isCompatible(route.platformLock, os)
    ? (route.unsupportedNote ?? incompatibleReason(route.platformLock, os))
    : null;
  const exportDisabled = exportStatus === "running" || !sourcePath;
  const showLog = exportStatus !== "idle" || logLines.length > 0;
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (open) setAdvancedOpen(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[720px] w-[450px] sm:max-w-none flex-col gap-0 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* Header */}
        <DialogHeader className="border-b px-6 py-4">
          <div className="flex items-center gap-3">
            {formatIcon ? (
              <Icon className="h-12 w-12 shrink-0" />
            ) : (
              <div
                className={cn(
                  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
                  bg,
                )}
              >
                <Icon className="h-6 w-6" />
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle className="text-lg">
                  Export to {route.title}
                </DialogTitle>
                {tags.map((t) => (
                  <Badge key={t} variant="outline" className="rounded text-xs">
                    {t}
                  </Badge>
                ))}
              </div>
              <p className="font-mono text-xs text-zinc-400">
                format={route.targetFormat}
              </p>
            </div>
          </div>
          {unsupportedReason && (
            <div className="mt-3 flex gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <p className="text-sm text-red-800">{unsupportedReason}</p>
            </div>
          )}
          <p className="mt-2 text-sm leading-6 text-zinc-500">{route.notes}</p>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-6 px-6 py-5">
            {/* Dependencies — always visible */}
            <div>
              <p className="mb-2 text-sm font-medium text-zinc-700">
                Dependencies
              </p>
              <DependencyPanel
                route={route}
                depResults={depResults}
                depCheckLoading={depCheckLoading}
                depCheckError={depCheckError}
              />
            </div>

            {/* Default options notice + advanced toggle */}
            <div className="space-y-3">
              {!advancedOpen && (
                <p className="text-sm text-zinc-500 text-center">
                  Converting with default options
                </p>
              )}
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
              >
                Advanced Options
                <ChevronDown
                  className={cn(
                    "size-4 transition-transform duration-200",
                    advancedOpen && "rotate-180",
                  )}
                />
              </button>

              {advancedOpen && (
                <OptionsPanel
                  route={route}
                  options={options}
                  onOptionsChange={onOptionsChange}
                />
              )}
            </div>

            {showLog && (
              <div className="rounded-md bg-zinc-950 p-4">
                <ExportLog lines={logLines} status={exportStatus} route={route} />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t px-6 py-4">
          {exportStatus === "running" ? (
            <Button variant="outline" onClick={onStopExport}>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          <Button
            disabled={exportDisabled}
            onClick={onExport}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Play className="mr-2 h-4 w-4" />
            Start Export
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
