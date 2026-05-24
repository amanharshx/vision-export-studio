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
import { ArrowLeft, FileBox, Info, X } from "lucide-react";
import { UpdateChecker } from "@/components/update-checker";
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

  // Detect environment on mount
  useEffect(() => {
    detectEnvironment()
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
    const outputDir = sourcePath.includes("/")
      ? sourcePath.substring(0, sourcePath.lastIndexOf("/"))
      : "";
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

  // Back button per view
  const handleBack = () => {
    if (view === "drop") onBack();
    else handleClearFile();
  };

  const backLabel = "Back";
  const baseName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;

  const pythonLabel = envInfo?.python_version ?? (envError ? "Error" : "Detecting…");
  const yoloLabel = envInfo?.yolo_path ?? (envError ? "Error" : "Detecting…");

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
        {/* (i) env info popover */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title="Environment info"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          {infoOpen && (
            <>
              {/* backdrop to close */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setInfoOpen(false)}
              />
              <div className="absolute right-0 top-6 z-20 w-64 rounded-md border border-zinc-200 bg-white p-3 shadow-md">
                <p className="mb-2 text-xs font-medium text-zinc-400 uppercase tracking-wide">
                  Environment
                </p>
                <div className="space-y-2">
                  <div className="flex justify-between gap-2">
                    <span className="text-xs text-zinc-500">Python</span>
                    <span className="max-w-[150px] truncate text-xs font-medium text-zinc-900 text-right">
                      {pythonLabel}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-xs text-zinc-500">YOLO CLI</span>
                    <span className="max-w-[150px] truncate text-xs font-medium text-zinc-900 text-right" title={yoloLabel}>
                      {yoloLabel}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <UpdateChecker />
      </div>
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
