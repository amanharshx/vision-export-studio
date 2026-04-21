import { EnvironmentStatus } from "@/features/environment/environment-status";
import { detectEnvironment } from "@/lib/tauri/environment";
import { cancelExport, startExport } from "@/lib/tauri/export";
import { defaultRoute, ultralyticsRoutes } from "@/lib/routes";
import type {
  EnvironmentInfo,
  ExportCancelledPayload,
  ExportFailedPayload,
  ExportFinishedPayload,
  ExportLinePayload,
  ExportOptions,
  ExportStatus,
} from "@/lib/types";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone } from "./drop-zone";
import { RouteDetails } from "./route-details";
import { RouteGrid } from "./route-grid";

const defaultOptions: ExportOptions = {
  imgsz: 640,
  batch: 1,
  half: false,
  int8: false,
  dynamic: false,
  simplify: false,
  nms: false,
  opset: null,
  data: "",
  name: "",
};

export function ExportWorkspace() {
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

  // Ref to current sessionId for use inside event listener closures
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  // Detect environment on mount
  useEffect(() => {
    detectEnvironment()
      .then(setEnvInfo)
      .catch((e: unknown) => setEnvError(String(e)));
  }, []);

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
        source_path: sourcePath,
        route_id: selectedRoute.id,
        output_dir: outputDir,
        yolo_path: envInfo.yolo_path,
        imgsz: options.imgsz,
        batch: options.batch,
        half: options.half,
        dynamic: options.dynamic,
        simplify: options.simplify,
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

  return (
    <main className="min-h-screen px-5 py-5 text-zinc-950 md:px-8 md:py-7">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-5 border-b border-zinc-900/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase text-teal-700">Local export studio</p>
            <h1 className="text-4xl font-semibold text-zinc-950 md:text-6xl">YOLO Export Studio</h1>
            <p className="max-w-2xl text-base leading-7 text-zinc-700">
              High-fidelity desktop wrapper for Ultralytics export routes, dependency checks,
              and local `yolo export` runs.
            </p>
          </div>
          <EnvironmentStatus envInfo={envInfo} loadError={envError} />
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_390px]">
          <div className="space-y-5">
            <DropZone
              path={sourcePath}
              onFileSelect={setSourcePath}
              errorMsg={invokeError}
            />
            <RouteGrid selectedRouteId={selectedRoute.id} onSelectRoute={setSelectedRouteId} />
          </div>
          <RouteDetails
            route={selectedRoute}
            sourcePath={sourcePath}
            exportStatus={exportStatus}
            logLines={logLines}
            options={options}
            onOptionsChange={setOptions}
            onExport={handleExport}
            onCancel={handleCancel}
          />
        </section>
      </div>
    </main>
  );
}
