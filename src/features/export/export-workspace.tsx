import { detectEnvironment } from "@/lib/tauri/environment";
import { checkDependencies } from "@/lib/tauri/deps";
import { cancelExport, startExport } from "@/lib/tauri/export";
import { defaultRoute, ultralyticsRoutes } from "@/lib/routes";
import type {
  DepCheckResult,
  EnvironmentInfo,
  ExportCancelledPayload,
  ExportFailedPayload,
  ExportFinishedPayload,
  ExportLinePayload,
  ExportOptions,
  ExportStatus,
} from "@/lib/types";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileBox, FolderOpen, Info, RefreshCw, X, CircleHelp } from "lucide-react";
import { UpdateChecker } from "@/components/update-checker";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { loadSettings, savePythonOverride } from "@/lib/tauri/setup";
import { openPythonExecutablePicker } from "@/lib/tauri/dialog";
import { DropZone } from "./drop-zone";
import { ExportModal } from "./export-modal";
import { RouteGrid } from "./route-grid";

type WorkspaceView = "drop" | "formats";

const defaultOptions: ExportOptions = {
  imgsz: 640,
  batch: 1,
  half: false,
  int8: false,
  dynamic: false,
  simplify: false,
  optimize: false,
  nms: false,
  endToEnd: false,
  keras: false,
  opset: null,
  workspace: null,
  chip: "rk3588",
};

const routeDefaults: Partial<Record<string, Partial<ExportOptions>>> = {
  "ultralytics.pt.onnx": { half: true, simplify: true },
  "ultralytics.pt.openvino": { half: true },
  "ultralytics.pt.engine": { half: true, simplify: true },
  "ultralytics.pt.coreml": { half: true },
  "ultralytics.pt.tflite": { half: true },
  "ultralytics.pt.tfjs": { half: true },
  "ultralytics.pt.mnn": { half: true },
  "ultralytics.pt.ncnn": { half: true },
  "ultralytics.pt.imx": { int8: true },
  "ultralytics.pt.axelera": { int8: true },
};

function optionsForRoute(routeId: string): ExportOptions {
  return { ...defaultOptions, ...(routeDefaults[routeId] ?? {}) };
}

type EnvCardStatus = "ok" | "error" | "loading";

function EnvCard({
  title,
  status,
  version,
  path,
  hint,
  children,
}: {
  title: string;
  status: EnvCardStatus;
  version: string;
  path?: string;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const borderColor =
    status === "ok"
      ? "border-l-emerald-500"
      : status === "error"
        ? "border-l-red-400"
        : "border-l-zinc-300";
  const badgeBg =
    status === "ok"
      ? "bg-emerald-50 text-emerald-700"
      : status === "error"
        ? "bg-red-50 text-red-600"
        : "bg-zinc-100 text-zinc-400";

  return (
    <div
      className={`rounded-xl border border-zinc-200/80 border-l-[3px] bg-white p-4 shadow-sm ${borderColor}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-800">
          {title}
          {hint}
        </span>
        <span
          className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-medium ${badgeBg} ${status === "loading" ? "animate-pulse" : ""}`}
        >
          {version}
        </span>
      </div>
      {path && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-400" title={path}>
          {path}
        </p>
      )}
      {children}
    </div>
  );
}

interface ExportWorkspaceProps {
  onBack: () => void;
}

export function ExportWorkspace({ onBack }: ExportWorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>("drop");
  const [infoOpen, setInfoOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [selectedRouteId, setSelectedRouteId] = useState(defaultRoute.id);
  const selectedRoute = useMemo(
    () => ultralyticsRoutes.find((route) => route.id === selectedRouteId) ?? defaultRoute,
    [selectedRouteId],
  );

  // Environment
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [pythonOverride, setPythonOverride] = useState("");
  const [redetecting, setRedetecting] = useState(false);

  // Source model path
  const [sourcePath, setSourcePath] = useState("");

  // Export session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [invokeError, setInvokeError] = useState<string | null>(null);

  // Export options
  const [options, setOptions] = useState<ExportOptions>(defaultOptions);

  // Dependency check state
  const [depResults, setDepResults] = useState<DepCheckResult[] | null>(null);
  const [depCheckLoading, setDepCheckLoading] = useState(false);
  const [depCheckError, setDepCheckError] = useState<string | null>(null);

  // Ref to current sessionId for use inside event listener closures
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  // Load settings + detect environment on mount
  useEffect(() => {
    loadSettings()
      .then((settings) => {
        const override = settings.python_path_override || "";
        if (override) setPythonOverride(override);
        return detectEnvironment(override || undefined);
      })
      .then(setEnvInfo)
      .catch((e: unknown) => setEnvError(String(e)));
  }, []);

  // Check dependencies whenever the selected route or resolved python path changes
  useEffect(() => {
    const pythonPath = envInfo?.python_path;
    if (!pythonPath || !selectedRouteId) {
      setDepResults(null);
      return;
    }

    let cancelled = false;
    setDepResults(null);
    setDepCheckLoading(true);
    setDepCheckError(null);

    checkDependencies(selectedRouteId, pythonPath)
      .then((response) => {
        if (!cancelled) {
          setDepResults(response.results);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setDepCheckError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDepCheckLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRouteId, envInfo?.python_path]);

  // Set up event listeners; re-register when sessionId changes
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const ulStdout = await listen<ExportLinePayload>("export:stdout", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setLogLines((prev) => [...prev, "[stdout] " + event.payload.line]);
        }
      });
      unlisteners.push(ulStdout);

      const ulStderr = await listen<ExportLinePayload>("export:stderr", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setLogLines((prev) => [...prev, "[stderr] " + event.payload.line]);
        }
      });
      unlisteners.push(ulStderr);

      const ulFinished = await listen<ExportFinishedPayload>("export:finished", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setExportStatus("finished");
        }
      });
      unlisteners.push(ulFinished);

      const ulFailed = await listen<ExportFailedPayload>("export:failed", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setExportStatus("failed");
        }
      });
      unlisteners.push(ulFailed);

      const ulCancelled = await listen<ExportCancelledPayload>("export:cancelled", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          setExportStatus("cancelled");
        }
      });
      unlisteners.push(ulCancelled);
    };

    setup().catch((e: unknown) => {
      setInvokeError("Failed to set up export listeners: " + String(e));
    });

    return () => {
      for (const ul of unlisteners) ul();
    };
  }, []);

  // Export handler
  const handleExport = async () => {
    if (!sourcePath || !envInfo?.yolo_path || exportStatus === "running") return;
    setInvokeError(null);
    setLogLines([]);
    const sep = sourcePath.includes("/") ? "/" : "\\";
    const lastSep = sourcePath.lastIndexOf(sep);
    const parentDir = lastSep > 0 ? sourcePath.substring(0, lastSep) : "";
    const outputDir = parentDir ? `${parentDir}/yolo-export-studio-exports` : "";
    try {
      const id = await startExport({
        sourcePath,
        routeId: selectedRoute.id,
        outputDir,
        yoloPath: envInfo.yolo_path,
        imgsz: options.imgsz,
        batch: options.batch,
        half: options.half,
        int8: options.int8,
        dynamic: options.dynamic,
        simplify: options.simplify,
        optimize: options.optimize,
        nms: options.nms,
        endToEnd: options.endToEnd,
        keras: options.keras,
        opset: options.opset,
        workspace: options.workspace,
        chip: options.chip,
      });
      setSessionId(id);
      setExportStatus("running");
    } catch (e: unknown) {
      setInvokeError(String(e));
    }
  };

  // Cancel handler
  const handleCancel = async () => {
    if (sessionId === null || exportStatus !== "running") return;
    try {
      await cancelExport(sessionId);
    } catch (e: unknown) {
      setInvokeError("Cancel failed: " + String(e));
    }
  };

  // File select — advance to formats view
  const handleFileSelect = useCallback((path: string) => {
    setSourcePath(path);
    if (path.trim()) setView("formats");
  }, []);

  // Route row clicked — open modal for that route
  const handleActivateRoute = (routeId: string) => {
    setSelectedRouteId(routeId);
    setOptions(optionsForRoute(routeId));
    setLogLines([]);
    setExportStatus("idle");
    setDialogOpen(true);
  };

  // Clear file — back to drop view
  const handleClearFile = () => {
    setSourcePath("");
    setView("drop");
  };

  // Re-detect environment with current override
  const handleRedetect = useCallback(async (overridePath?: string) => {
    setRedetecting(true);
    setEnvInfo(null);
    setEnvError(null);
    try {
      const info = await detectEnvironment(overridePath || undefined);
      setEnvInfo(info);
    } catch (e: unknown) {
      setEnvError(String(e));
    } finally {
      setRedetecting(false);
    }
  }, []);

  // Save python path override and re-detect
  const handleSaveAndRedetect = useCallback(async () => {
    const val = pythonOverride.trim();
    await savePythonOverride(val || null);
    handleRedetect(val);
  }, [pythonOverride, handleRedetect]);

  // Browse for python executable
  const handleBrowsePython = useCallback(async () => {
    const path = await openPythonExecutablePicker();
    if (path) setPythonOverride(path);
  }, []);

  // Clear python override
  const handleClearOverride = useCallback(async () => {
    setPythonOverride("");
    await savePythonOverride(null);
    handleRedetect();
  }, [handleRedetect]);

  // Back button per view
  const handleBack = () => {
    if (view === "drop") onBack();
    else handleClearFile();
  };

  const backLabel = "Back";
  const baseName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;

  const header = (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-900/10 bg-white px-5 py-3">
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-950"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </button>

      <div className="flex items-center gap-4">
        {/* (i) settings panel trigger */}
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          title="Environment & settings"
        >
          <Info className="h-3.5 w-3.5" />
        </button>

        <UpdateChecker />
      </div>

      {/* Settings slide-in panel */}
      <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
        <SheetContent side="right" className="w-[340px] bg-zinc-50/80 p-0">
          {/* Panel header */}
          <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-4">
            <SheetHeader className="p-0">
              <SheetTitle className="text-[15px]">Environment</SheetTitle>
            </SheetHeader>
            <button
              type="button"
              onClick={() => handleRedetect(pythonOverride.trim())}
              disabled={redetecting}
              className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 disabled:opacity-50"
              title="Re-detect environment"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${redetecting ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="space-y-5 px-5 py-5">
            {/* Status cards */}
            <div className="space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                Status
              </p>

              <EnvCard
                title="Python"
                status={
                  redetecting || (!envInfo && !envError)
                    ? "loading"
                    : envError || !envInfo?.python_version
                      ? "error"
                      : "ok"
                }
                version={envInfo?.python_version || (envError ? "Error" : "...")}
                path={envInfo?.python_path}
                hint={
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleHelp className="h-3 w-3 text-zinc-300 transition-colors hover:text-zinc-500" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[200px]">
                        Recommended: Python 3.8 &ndash; 3.12
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                }
              />

              <EnvCard
                title="Ultralytics"
                status={
                  redetecting || (!envInfo && !envError)
                    ? "loading"
                    : envInfo?.ultralytics_version
                      ? "ok"
                      : "error"
                }
                version={envInfo?.ultralytics_version || (redetecting ? "..." : "Not found")}
                path={envInfo?.yolo_path || undefined}
              />
            </div>

            {/* Configuration */}
            <div className="space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                Configuration
              </p>

              <div className="rounded-xl border border-zinc-200/80 bg-white p-4 shadow-sm">
                <p className="mb-2.5 text-[13px] font-semibold text-zinc-800">Python path</p>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={pythonOverride}
                    onChange={(e) => setPythonOverride(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveAndRedetect(); }}
                    placeholder="Auto-detect"
                    className="h-8 flex-1 min-w-0 rounded-lg border-zinc-200 bg-zinc-50 font-mono text-[12px] placeholder:text-zinc-300 focus-visible:bg-white"
                  />
                  <button
                    type="button"
                    onClick={handleBrowsePython}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                    title="Browse for Python executable"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <Button
                    size="sm"
                    className="h-7 rounded-lg px-3 text-[12px]"
                    onClick={handleSaveAndRedetect}
                  >
                    Apply
                  </Button>
                  {pythonOverride && (
                    <button
                      type="button"
                      className="text-[12px] text-zinc-400 transition-colors hover:text-zinc-600"
                      onClick={handleClearOverride}
                    >
                      Reset to auto
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Warnings */}
            {envInfo?.warnings && envInfo.warnings.length > 0 && (
              <div className="rounded-xl border border-amber-200/60 bg-amber-50/50 p-4">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-amber-600/80">
                  Warnings
                </p>
                <div className="space-y-1.5">
                  {envInfo.warnings.map((w, i) => (
                    <p key={i} className="text-[12px] leading-relaxed text-amber-700">{w}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );

  const filePill = (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-900/10 bg-white/85 p-4 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <FileBox className="h-5 w-5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-950">{baseName}</p>
        <p className="text-xs text-zinc-500">Ready to export</p>
      </div>
      <button
        type="button"
        onClick={handleClearFile}
        className="text-zinc-400 hover:text-zinc-950"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  if (view === "drop") {
    return (
      <div className="flex min-h-screen flex-col">
        {header}
        <main className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md">
            <DropZone
              path={sourcePath}
              onFileSelect={handleFileSelect}
              errorMsg={invokeError}
            />
          </div>
        </main>
      </div>
    );
  }

  // formats view
  return (
    <div className="flex h-dvh flex-col">
      {header}
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-2xl space-y-6 px-5 py-8">
          {filePill}
          <div>
            <h2 className="mb-3 text-sm font-medium uppercase text-zinc-400">
              Export Target
            </h2>
            <RouteGrid onSelectRoute={handleActivateRoute} />
          </div>
        </main>
      </div>

      <ExportModal
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        route={selectedRoute}
        sourcePath={sourcePath}
        exportStatus={exportStatus}
        logLines={logLines}
        options={options}
        onOptionsChange={setOptions}
        onExport={handleExport}
        onStopExport={handleCancel}
        depResults={depResults ?? undefined}
        depCheckLoading={depCheckLoading}
        depCheckError={depCheckError}
      />
    </div>
  );
}
