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
  InstallPhase,
  ProviderSpec,
  RfDetrVariantMode,
  RouteSpec,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronDown, Download, Loader2, Play, Square } from "lucide-react";
import { buildCommandPreview } from "./command-preview";
import { DependencyPanel } from "./dependency-panel";
import { ExportLog } from "./export-log";
import { OptionsPanel } from "./options-panel";
import { formatIconMap } from "@/components/format-icons";
import { getOS, incompatibleReason, isCompatible, platformTags } from "@/lib/platform";
import { categoryBg, categoryIcon } from "./route-card";

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderSpec;
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
  errorMsg?: string | null;
  installPhase: InstallPhase;
  missingPackageNames: string[];
  onInstallAndExport: () => void;
  outputDir?: string;
  rfdetrSummary?: {
    variantMode: RfDetrVariantMode;
    detectedClass?: string | null;
    selectedClass?: string | null;
    trusted: boolean;
    recommendedImgsz?: number | null;
    patchSize?: number | null;
  } | null;
}

export function ExportModal({
  open,
  onOpenChange,
  provider,
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
  errorMsg,
  installPhase,
  missingPackageNames,
  onInstallAndExport,
  outputDir,
  rfdetrSummary,
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
  const isPendingConsent = installPhase === "pending_consent";
  const isInstalling = installPhase === "installing";
  const isStarting = exportStatus === "starting";
  const isRunning = exportStatus === "running";
  const exportDisabled = isRunning || isStarting || !sourcePath || isInstalling;
  const showLog = exportStatus !== "idle" || logLines.length > 0;
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const collapsedSummary = (() => {
    if (provider.id !== "rfdetr" || !rfdetrSummary?.recommendedImgsz) {
      return "Converting with current options";
    }
    const patch = rfdetrSummary.patchSize ? ` \u00b7 patch ${rfdetrSummary.patchSize}` : "";
    if (options.imgsz === rfdetrSummary.recommendedImgsz) {
      return `Native settings applied: ${options.imgsz}px${patch}`;
    }
    return `Override active: ${options.imgsz}px \u00b7 native ${rfdetrSummary.recommendedImgsz}px${patch}`;
  })();

  const commandPreview = buildCommandPreview({
    providerId: provider.id,
    routeId: route.id,
    targetFormat: route.targetFormat,
    sourcePath,
    options,
    outputDir,
    rfdetrVariantMode: rfdetrSummary?.variantMode,
    rfdetrManualClassSymbol:
      rfdetrSummary?.variantMode === "manual" ? rfdetrSummary.selectedClass ?? "" : undefined,
  });

  useEffect(() => {
    if (open) setAdvancedOpen(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next === false && isStarting) return; onOpenChange(next); }}>
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
          {rfdetrSummary && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                RF-DETR variant:{" "}
                <span className="font-mono">
                  {rfdetrSummary.variantMode === "manual"
                    ? rfdetrSummary.selectedClass
                    : rfdetrSummary.detectedClass ?? "Auto"}
                </span>
                {rfdetrSummary.recommendedImgsz
                  ? ` · native ${rfdetrSummary.recommendedImgsz}px${rfdetrSummary.patchSize ? ` · patch ${rfdetrSummary.patchSize}` : ""}`
                  : ""}
              </p>
              <p className="mt-1">Use checkpoints from trusted sources only. Local checkpoint loading may execute Python pickle data.</p>
              {route.id === "rfdetr.pth.tflite" && (
                <p className="mt-1">TFLite is experimental. Validate FP32 and FP16 outputs before deployment.</p>
              )}
            </div>
          )}
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
                provider={provider}
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
                  {collapsedSummary}
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
                  recommendedImgsz={rfdetrSummary?.recommendedImgsz}
                  patchSize={rfdetrSummary?.patchSize}
                />
              )}
            </div>

            {isPendingConsent && missingPackageNames.length > 0 && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                <p className="mb-1 text-sm font-medium text-blue-800">
                  Missing packages
                </p>
                <p className="mb-2 text-xs text-blue-700">
                  These will be installed into your Python environment before export:
                </p>
                <ul className="space-y-0.5">
                  {missingPackageNames.map((pkg) => (
                    <li key={pkg} className="font-mono text-xs text-blue-900">
                      • {pkg}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-800">{errorMsg}</p>
              </div>
            )}

            {showLog && (
              <div className="rounded-md bg-zinc-950 p-4">
                <ExportLog lines={logLines} status={exportStatus} preview={commandPreview} />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t px-6 py-4">
          {isRunning ? (
            <Button variant="outline" onClick={onStopExport}>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          ) : isStarting ? (
            <Button variant="outline" disabled>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Starting…
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isInstalling}>
              Cancel
            </Button>
          )}
          <Button
            disabled={exportDisabled}
            onClick={isPendingConsent ? onInstallAndExport : onExport}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isInstalling ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Installing...
              </>
            ) : isPendingConsent ? (
              <>
                <Download className="mr-2 h-4 w-4" />
                Install &amp; Export
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Start Export
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
