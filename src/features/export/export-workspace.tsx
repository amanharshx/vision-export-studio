import { detectEnvironment } from "@/lib/tauri/environment";
import { captureAnalyticsEvent } from "@/lib/analytics";
import { checkDependencies, installDependencies } from "@/lib/tauri/deps";
import { cancelExport, startExport } from "@/lib/tauri/export";
import { defaultRouteForProvider, hasAllowedSourceExtension, providers, providerList, routesForProvider } from "@/lib/providers";
import { inspectRfDetrCheckpoint } from "@/lib/tauri/rfdetr";
import type {
  DepCheckResult,
  EnvironmentInfo,
  ExportCancelledPayload,
  ExportFailedPayload,
  ExportFinishedPayload,
  ExportLinePayload,
  ExportOptions,
  ExportOptionsSource,
  ExportStatus,
  InstallFailedPayload,
  InstallFinishedPayload,
  InstallLinePayload,
  InstallPhase,
  ProviderId,
  RfDetrInspectResult,
  RfDetrInspectStatus,
  RfDetrVariantMode,
  RouteOptionsState,
} from "@/lib/types";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileBox, FolderOpen, Info, RefreshCw, RotateCcw, X, CircleHelp, Loader2 } from "lucide-react";
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
import { loadSettings, savePythonOverride, saveOutputDirOverride } from "@/lib/tauri/setup";
import { openPythonExecutablePicker, openOutputDirPicker } from "@/lib/tauri/dialog";
import type { UpdaterController } from "@/features/updater/use-updater-controller";
import { DropZone } from "./drop-zone";
import { ExportModal } from "./export-modal";
import { RouteGrid } from "./route-grid";

type WorkspaceView = "drop" | "formats";
type RuntimeInstallPhase = "idle" | "installing" | "ready" | "failed";

export function getUltralyticsRuntimeDisabledReason(runtimeInstallPhase: RuntimeInstallPhase): string | undefined {
  return runtimeInstallPhase === "installing"
    ? undefined
    : "Install the Ultralytics runtime before choosing a YOLO export target.";
}

export function shouldShowUltralyticsRuntimeInstallDetails(
  runtimeInstallPhase: RuntimeInstallPhase,
  runtimeInstallDetailsOpen: boolean,
): boolean {
  return runtimeInstallPhase === "failed"
    || (runtimeInstallPhase === "installing" && runtimeInstallDetailsOpen);
}

export function getUltralyticsRuntimeReadyDescription(): string {
  return "YOLO export targets are enabled on this machine.";
}

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

export function withRfDetrDetectedDefaults(
  base: ExportOptions,
  providerId: ProviderId,
  inspect: RfDetrInspectResult | null,
): ExportOptions {
  if (providerId !== "rfdetr") return base;
  if (!inspect?.success || !inspect.recommended_imgsz) return base;
  return { ...base, imgsz: inspect.recommended_imgsz };
}

export function getRouteOptionsForOpen(
  saved: RouteOptionsState | null,
  routeId: string,
  providerId: ProviderId,
  inspect: RfDetrInspectResult | null,
  sourcePath: string,
): RouteOptionsState {
  if (saved && saved.sourcePath === sourcePath) return saved;

  const base = optionsForRoute(routeId);
  const detected = withRfDetrDetectedDefaults(base, providerId, inspect);

  return {
    options: detected,
    source: providerId === "rfdetr" && inspect?.success && inspect.recommended_imgsz ? "detected" : "default",
    sourcePath,
  };
}

function getInstallableMissingPackages(results: DepCheckResult[] | null): string[] {
  if (!results) {
    return [];
  }

  const pipMissing = results
    .filter((r) => r.status === "missing_package")
    .map((r) => r.install_package ?? r.item);
  const binaryViaPip = results
    .filter(
      (r) =>
        r.status === "missing_binary" &&
        r.install_hint.startsWith("pip install "),
    )
    .map((r) => r.install_hint.replace("pip install ", "").trim());

  return [...new Set([...pipMissing, ...binaryViaPip])];
}

function hasBlockingDependencies(results: DepCheckResult[] | null): boolean {
  if (!results) {
    return true;
  }

  return results.some((result) => result.status !== "ready" && result.status !== "warning");
}

export function applyDetectedRouteOptions(
  saved: RouteOptionsState | null,
  routeId: string,
  detectedImgsz: number,
  currentSourcePath: string,
): RouteOptionsState | null {
  if (!saved || saved.sourcePath !== currentSourcePath) {
    return {
      options: { ...optionsForRoute(routeId), imgsz: detectedImgsz },
      source: "detected",
      sourcePath: currentSourcePath,
    };
  }
  if (saved.source === "user") {
    return null;
  }
  return {
    options: { ...saved.options, imgsz: detectedImgsz },
    source: "detected",
    sourcePath: currentSourcePath,
  };
}

export function applyDetectedRouteOptionsToProviderRoutes(
  savedByRoute: Record<string, RouteOptionsState>,
  providerId: ProviderId,
  detectedImgsz: number,
  currentSourcePath: string,
): Record<string, RouteOptionsState> {
  if (providerId !== "rfdetr") return savedByRoute;

  const next = { ...savedByRoute };
  for (const route of routesForProvider(providerId)) {
    const updated = applyDetectedRouteOptions(
      next[route.id] ?? null,
      route.id,
      detectedImgsz,
      currentSourcePath,
    );
    if (updated) {
      next[route.id] = updated;
    }
  }
  return next;
}

function isRfDetrExportReady(
  inspectStatus: RfDetrInspectStatus,
  variantMode: RfDetrVariantMode,
  manualClassSymbol: string,
): boolean {
  if (variantMode === "manual") {
    return manualClassSymbol.trim().length > 0;
  }
  return inspectStatus === "detected";
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
  updatesEnabled: boolean;
  updater: UpdaterController;
}

export function ExportWorkspace({ onBack, updatesEnabled, updater }: ExportWorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>("drop");
  const [infoOpen, setInfoOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>("ultralytics");
  const selectedProvider = providers[selectedProviderId];
  const currentRoutes = useMemo(() => routesForProvider(selectedProviderId), [selectedProviderId]);
  const [selectedRouteId, setSelectedRouteId] = useState(defaultRouteForProvider("ultralytics").id);
  const selectedRoute = useMemo(
    () => currentRoutes.find((route) => route.id === selectedRouteId) ?? defaultRouteForProvider(selectedProviderId),
    [currentRoutes, selectedProviderId, selectedRouteId],
  );

  // Environment
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [pythonOverride, setPythonOverride] = useState("");
  const [redetecting, setRedetecting] = useState(false);

  // Output directory
  const [outputDirOverride, setOutputDirOverride] = useState("");
  const [outputDirInput, setOutputDirInput] = useState("");

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

  // Install phase state
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [runtimeInstallPhase, setRuntimeInstallPhase] = useState<RuntimeInstallPhase>("idle");
  const [runtimeInstallLines, setRuntimeInstallLines] = useState<string[]>([]);
  const [runtimeInstallError, setRuntimeInstallError] = useState<string | null>(null);
  const [runtimeInstallDetailsOpen, setRuntimeInstallDetailsOpen] = useState(false);
  const [runtimeInstalledThisSession, setRuntimeInstalledThisSession] = useState(false);

  // RF-DETR inspect state
  const [rfdetrInspectStatus, setRfDetrInspectStatus] = useState<RfDetrInspectStatus>("idle");
  const [rfdetrInspectResult, setRfDetrInspectResult] = useState<RfDetrInspectResult | null>(null);
  const [rfdetrTrustConfirmedPath, setRfDetrTrustConfirmedPath] = useState<string | null>(null);
  const [rfdetrVariantMode, setRfDetrVariantMode] = useState<RfDetrVariantMode>("auto");
  const [rfdetrManualClassSymbol, setRfDetrManualClassSymbol] = useState("");
  const rfdetrInspectRequestRef = useRef(0);
  const depRefreshRequestRef = useRef(0);
  const routeOptionsRef = useRef<Record<string, RouteOptionsState>>({});

  const setOptionsWithSource = useCallback(
    (next: ExportOptions, optsSource: ExportOptionsSource) => {
      setOptions(next);
      if (selectedRouteId) {
        routeOptionsRef.current[selectedRouteId] = {
          options: next,
          source: optsSource,
          sourcePath,
        };
      }
    },
    [selectedRouteId, sourcePath],
  );

  const missingPackageNames = useMemo(() => {
    return getInstallableMissingPackages(depResults);
  }, [depResults]);
  const ultralyticsRuntimeReady = selectedProviderId !== "ultralytics" || Boolean(envInfo?.yolo_path);
  const ultralyticsRuntimeInstalling = runtimeInstallPhase === "installing";
  const ultralyticsRuntimeBlocking =
    selectedProviderId === "ultralytics" && (!ultralyticsRuntimeReady || ultralyticsRuntimeInstalling);

  // Ref to current sessionId for use inside event listener closures
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const currentExportRouteRef = useRef<{ routeId: string; exportFormat: string } | null>(null);

  // Load settings + detect environment on mount
  useEffect(() => {
    loadSettings()
      .then((settings) => {
        const override = settings.python_path_override || "";
        if (override) setPythonOverride(override);
        const outOverride = settings.output_dir_override || "";
        if (outOverride) {
          setOutputDirOverride(outOverride);
          setOutputDirInput(outOverride);
        }
        return detectEnvironment(override.trim() || undefined);
      })
      .then(setEnvInfo)
      .catch((e: unknown) => setEnvError(String(e)));
  }, []);

  const refreshRouteDependencies = useCallback(async (routeId: string | null, pythonPath: string | null) => {
    const requestId = depRefreshRequestRef.current + 1;
    depRefreshRequestRef.current = requestId;

    if (!routeId || !pythonPath) {
      if (depRefreshRequestRef.current === requestId) {
        setDepResults(null);
        setDepCheckError(null);
        setDepCheckLoading(false);
      }
      return;
    }

    if (depRefreshRequestRef.current === requestId) {
      setDepResults(null);
      setDepCheckLoading(true);
      setDepCheckError(null);
    }

    try {
      const response = await checkDependencies(routeId, pythonPath);
      if (depRefreshRequestRef.current !== requestId) {
        return;
      }
      setDepResults(response.results);
    } catch (error) {
      if (depRefreshRequestRef.current !== requestId) {
        return;
      }
      setDepResults(null);
      setDepCheckError(String(error));
      throw error;
    } finally {
      if (depRefreshRequestRef.current === requestId) {
        setDepCheckLoading(false);
      }
    }
  }, []);

  // Check dependencies whenever the selected route or resolved python path changes
  useEffect(() => {
    const pythonPath = envInfo?.python_path;
    if (!pythonPath || !selectedRouteId) {
      setDepResults(null);
      return;
    }

    void refreshRouteDependencies(selectedRouteId, pythonPath).catch(() => {
      // State handled in helper; avoid unhandled promise noise.
    });
  }, [selectedRouteId, envInfo?.python_path, refreshRouteDependencies]);

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
          if (event.payload.artifact_warning) {
            setLogLines((prev) => [...prev, "[warning] " + event.payload.artifact_warning]);
          }
          const exportRoute = currentExportRouteRef.current;
          if (exportRoute) {
            captureAnalyticsEvent("export_completed", {
              route_id: exportRoute.routeId,
              export_format: exportRoute.exportFormat,
            });
          }
          setExportStatus("finished");
        }
      });
      unlisteners.push(ulFinished);

      const ulFailed = await listen<ExportFailedPayload>("export:failed", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          const exportRoute = currentExportRouteRef.current;
          if (exportRoute) {
            captureAnalyticsEvent("export_failed", {
              route_id: exportRoute.routeId,
              export_format: exportRoute.exportFormat,
              failure_stage: "export_run",
              failure_kind: "export_process_failed",
            });
          }
          setExportStatus("failed");
        }
      });
      unlisteners.push(ulFailed);

      const ulCancelled = await listen<ExportCancelledPayload>("export:cancelled", (event) => {
        if (event.payload.session_id === sessionIdRef.current) {
          const exportRoute = currentExportRouteRef.current;
          if (exportRoute) {
            captureAnalyticsEvent("export_cancelled", {
              route_id: exportRoute.routeId,
              export_format: exportRoute.exportFormat,
            });
          }
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

  useEffect(() => {
    routeOptionsRef.current = {};
  }, [sourcePath]);

  useEffect(() => {
    setRuntimeInstallPhase("idle");
    setRuntimeInstallLines([]);
    setRuntimeInstallError(null);
    setRuntimeInstallDetailsOpen(false);
  }, [selectedProviderId, sourcePath]);

  useEffect(() => {
    if (runtimeInstallPhase !== "ready") return;
    const timeoutId = window.setTimeout(() => {
      setRuntimeInstallPhase("idle");
    }, 4000);
    return () => window.clearTimeout(timeoutId);
  }, [runtimeInstallPhase]);

  useEffect(() => {
    if (runtimeInstallPhase === "failed") {
      setRuntimeInstallDetailsOpen(true);
      return;
    }
    if (runtimeInstallPhase === "idle" || runtimeInstallPhase === "ready") {
      setRuntimeInstallDetailsOpen(false);
    }
  }, [runtimeInstallPhase]);

  const streamDependencyInstall = useCallback(async (
    packages: string[],
    pythonPath: string,
    appendLine: (line: string) => void,
  ): Promise<"ok" | string> => {
    let installSessionId = "";
    let resolveInstall!: (result: "ok" | string) => void;
    const installPromise = new Promise<"ok" | string>((resolve) => {
      resolveInstall = resolve;
    });

    const [unOut, unErr, unDone, unFail] = await Promise.all([
      listen<InstallLinePayload>("install:stdout", (ev) => {
        if (!installSessionId || ev.payload.session_id !== installSessionId) return;
        appendLine("[stdout] " + ev.payload.line);
      }),
      listen<InstallLinePayload>("install:stderr", (ev) => {
        if (!installSessionId || ev.payload.session_id !== installSessionId) return;
        appendLine("[stderr] " + ev.payload.line);
      }),
      listen<InstallFinishedPayload>("install:finished", (ev) => {
        if (!installSessionId || ev.payload.session_id !== installSessionId) return;
        resolveInstall("ok");
      }),
      listen<InstallFailedPayload>("install:failed", (ev) => {
        if (!installSessionId || ev.payload.session_id !== installSessionId) return;
        resolveInstall(ev.payload.error);
      }),
    ]);

    const cleanup = () => {
      unOut();
      unErr();
      unDone();
      unFail();
    };

    try {
      installSessionId = await installDependencies(packages, pythonPath);
    } catch (error) {
      cleanup();
      throw error;
    }

    const result = await installPromise;
    cleanup();
    return result;
  }, []);

  const handleInstallUltralyticsRuntime = useCallback(async () => {
    const pythonPath = envInfo?.python_path;
    if (!pythonPath || ultralyticsRuntimeInstalling) return;

    setRuntimeInstallPhase("installing");
    setRuntimeInstallLines([]);
    setRuntimeInstallError(null);
    setRuntimeInstallDetailsOpen(false);
    setRuntimeInstalledThisSession(false);
    setDepCheckLoading(true);
    setDepCheckError(null);

    try {
      const result = await streamDependencyInstall(["ultralytics"], pythonPath, (line) => {
        setRuntimeInstallLines((prev) => [...prev, line]);
      });

      if (result !== "ok") {
        setRuntimeInstallPhase("failed");
        setRuntimeInstallError("Ultralytics runtime install failed: " + result);
        return;
      }

      const freshEnv = await detectEnvironment(pythonPath);
      setEnvInfo(freshEnv);

      if (!freshEnv.yolo_path) {
        setRuntimeInstallPhase("failed");
        setRuntimeInstallError("Ultralytics runtime install finished, but YOLO CLI was still not detected.");
        return;
      }

      try {
        await refreshRouteDependencies(selectedRoute.id, freshEnv.python_path);
      } catch (error) {
        setRuntimeInstallPhase("failed");
        setRuntimeInstallError("Ultralytics runtime installed, but dependency refresh failed. Re-detect environment and try again.");
        return;
      }

      setRuntimeInstalledThisSession(true);
      setRuntimeInstallPhase("ready");
    } catch (error) {
      setRuntimeInstallPhase("failed");
      setRuntimeInstallError(String(error));
    } finally {
      setDepCheckLoading(false);
    }
  }, [envInfo?.python_path, refreshRouteDependencies, selectedRoute.id, streamDependencyInstall, ultralyticsRuntimeInstalling]);

  // Core export invocation — call only when deps are satisfied
  const doStartExport = async (missingDepCount: number, envOverride?: EnvironmentInfo) => {
    const activeEnv = envOverride ?? envInfo;
    if (!sourcePath || !activeEnv?.python_path) return;
    if (selectedProviderId === "ultralytics" && !activeEnv.yolo_path) {
      setInvokeError("YOLO CLI not found. Install the Ultralytics runtime or re-detect the environment.");
      return;
    }
    if (selectedProviderId === "rfdetr" && rfdetrTrustConfirmedPath !== sourcePath) {
      setInvokeError("Confirm trusted RF-DETR checkpoint loading before export.");
      return;
    }
    if (
      selectedProviderId === "rfdetr" &&
      !isRfDetrExportReady(rfdetrInspectStatus, rfdetrVariantMode, rfdetrManualClassSymbol)
    ) {
      setInvokeError("Inspect RF-DETR checkpoint successfully or select a manual variant before export.");
      return;
    }
    if (selectedProviderId === "rfdetr" && rfdetrVariantMode === "manual" && !rfdetrManualClassSymbol) {
      setInvokeError("Select an RF-DETR variant before export.");
      return;
    }
    setInvokeError(null);
    setExportStatus("starting");
    setLogLines(["[info] Starting export..."]);
    const exportRoute = {
      routeId: selectedRoute.id,
      exportFormat: selectedRoute.targetFormat,
    };
    currentExportRouteRef.current = exportRoute;
    let outputDir = outputDirOverride.trim();
    if (!outputDir) {
      const sep = sourcePath.includes("/") ? "/" : "\\";
      const lastSep = sourcePath.lastIndexOf(sep);
      const parentDir = lastSep > 0 ? sourcePath.substring(0, lastSep) : "";
      outputDir = parentDir ? `${parentDir}${sep}vision-export-studio-exports` : "";
    }
    try {
      const id = await startExport({
        sourcePath,
        routeId: selectedRoute.id,
        outputDir,
        providerId: selectedProviderId,
        pythonPath: activeEnv.python_path,
        yoloPath: activeEnv.yolo_path ?? "",
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
        rfdetrTrustConfirmed: selectedProviderId === "rfdetr" && rfdetrTrustConfirmedPath === sourcePath,
        rfdetrVariantMode: selectedProviderId === "rfdetr" ? rfdetrVariantMode : null,
        rfdetrManualClassSymbol: selectedProviderId === "rfdetr" && rfdetrVariantMode === "manual" ? rfdetrManualClassSymbol : null,
      });
      sessionIdRef.current = id;
      setSessionId(id);
      setExportStatus("running");
      captureAnalyticsEvent("export_started", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        provider_id: selectedProviderId,
        rfdetr_variant_mode: selectedProviderId === "rfdetr" ? rfdetrVariantMode : undefined,
        rfdetr_detected_class: rfdetrInspectResult?.class_symbol ?? undefined,
        rfdetr_selected_class: rfdetrVariantMode === "manual" ? rfdetrManualClassSymbol : undefined,
        rfdetr_family: rfdetrInspectResult?.family ?? undefined,
        missing_dep_count: missingDepCount,
      });
    } catch (e: unknown) {
      captureAnalyticsEvent("export_failed", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        failure_stage: "start_export",
        failure_kind: "start_export_failed",
      });
      sessionIdRef.current = null;
      setSessionId(null);
      setExportStatus("failed");
      setInvokeError(String(e));
      setLogLines((prev) => [...prev, "[error] " + String(e)]);
    }
  };

  // Export handler — gates on missing deps before starting
  const handleExport = async () => {
    if (!sourcePath || !envInfo?.python_path || exportStatus === "running" || exportStatus === "starting") return;
    if (selectedProviderId === "ultralytics" && !envInfo.yolo_path) {
      setInvokeError("Install the Ultralytics runtime before starting a YOLO export.");
      return;
    }
    if (depCheckLoading) {
      setInvokeError("Dependency check still running. Wait for it to finish before export.");
      return;
    }
    if (depCheckError || depResults === null) {
      setInvokeError("Dependency check not ready. Resolve dependency check before export.");
      return;
    }

    if (missingPackageNames.length > 0) {
      setInvokeError(null);
      setInstallPhase("pending_consent");
      return;
    }
    if (hasBlockingDependencies(depResults)) {
      setInvokeError("Blocking dependencies still unresolved. Review dependency panel before export.");
      return;
    }

    setLogLines([]);
    await doStartExport(missingPackageNames.length);
  };

  // Install missing deps then auto-start export
  const handleInstallAndExport = async () => {
    const pythonPath = envInfo?.python_path;
    if (!pythonPath) return;
    const exportRoute = {
      routeId: selectedRoute.id,
      exportFormat: selectedRoute.targetFormat,
    };
    const missingPkgs = getInstallableMissingPackages(depResults);

    if (missingPkgs.length === 0) {
      setInstallPhase("idle");
      setLogLines([]);
      await doStartExport(missingPkgs.length);
      return;
    }

    setInstallPhase("installing");
    setLogLines([]);

    try {
      const result = await streamDependencyInstall(missingPkgs, pythonPath, (line) => {
        setLogLines((prev) => [...prev, line]);
      });

      if (result !== "ok") {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "install_dependencies",
          failure_kind: "install_failed",
        });
        setInstallPhase("failed");
        setLogLines((prev) => [...prev, "[error] Install failed: " + result]);
        return;
      }
    } catch (e: unknown) {
      captureAnalyticsEvent("export_failed", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        failure_stage: "install_dependencies",
        failure_kind: "install_start_failed",
      });
      setInstallPhase("failed");
      setLogLines((prev) => [...prev, "[error] Failed to start install: " + String(e)]);
      return;
    }

    setInstallPhase("done");
    setDepCheckLoading(true);
    setDepCheckError(null);
    let refreshedMissingPkgs: string[] = [];
    let freshEnv: EnvironmentInfo | undefined;
    try {
      const refreshed = await checkDependencies(selectedRoute.id, pythonPath);
      setDepResults(refreshed.results);
      refreshedMissingPkgs = getInstallableMissingPackages(refreshed.results);
      if (refreshedMissingPkgs.length > 0) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "recheck_dependencies",
          failure_kind: "deps_still_missing_after_install",
        });
        setInstallPhase("pending_consent");
        setInvokeError("Dependencies still missing after install. Review requirements before export.");
        return;
      }
      if (hasBlockingDependencies(refreshed.results)) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "recheck_dependencies",
          failure_kind: "blocking_dependencies_remaining_after_install",
        });
        setInstallPhase("failed");
        setInvokeError("Non-installable dependency blockers remain after install. Export blocked.");
        return;
      }

      if (selectedProviderId === "ultralytics") {
        try {
          freshEnv = await detectEnvironment(pythonOverride.trim() || pythonPath);
          setEnvInfo(freshEnv);
        } catch {
          captureAnalyticsEvent("export_failed", {
            route_id: exportRoute.routeId,
            export_format: exportRoute.exportFormat,
            failure_stage: "redetect_environment",
            failure_kind: "environment_redetect_failed_after_install",
          });
          setInstallPhase("failed");
          setInvokeError("Environment re-detect failed after install. Re-detect the environment before export.");
          return;
        }

        if (!freshEnv.yolo_path) {
          captureAnalyticsEvent("export_failed", {
            route_id: exportRoute.routeId,
            export_format: exportRoute.exportFormat,
            failure_stage: "redetect_environment",
            failure_kind: "yolo_missing_after_install",
          });
          setInstallPhase("failed");
          setInvokeError("YOLO CLI still missing after install. Re-detect the environment or reinstall the Ultralytics runtime.");
          return;
        }
      }
    } catch (e: unknown) {
      captureAnalyticsEvent("export_failed", {
        route_id: exportRoute.routeId,
        export_format: exportRoute.exportFormat,
        failure_stage: "recheck_dependencies",
        failure_kind: "dependency_recheck_failed",
      });
      setDepResults(null);
      setDepCheckError(String(e));
      setInstallPhase("failed");
      setInvokeError("Dependency re-check failed after install. Export blocked.");
      return;
    } finally {
      setDepCheckLoading(false);
    }

    await doStartExport(refreshedMissingPkgs.length, freshEnv);
  };

  // Cancel handler
  const handleCancel = async () => {
    if (sessionId === null || exportStatus !== "running") return;
    try {
      await cancelExport(sessionId);
    } catch (e: unknown) {
      const exportRoute = currentExportRouteRef.current;
      if (exportRoute) {
        captureAnalyticsEvent("export_failed", {
          route_id: exportRoute.routeId,
          export_format: exportRoute.exportFormat,
          failure_stage: "cancel_export",
          failure_kind: "cancel_export_failed",
        });
      }
      setInvokeError("Cancel failed: " + String(e));
    }
  };

  // Provider switch
  function resetExportStateForProvider(providerId: ProviderId) {
    setSelectedRouteId(defaultRouteForProvider(providerId).id);
    setDialogOpen(false);
    setSourcePath("");
    setView("drop");
    setLogLines([]);
    setInvokeError(null);
    setDepResults(null);
    setDepCheckLoading(false);
    setDepCheckError(null);
    setInstallPhase("idle");
    setExportStatus("idle");
    setSessionId(null);
    setRfDetrInspectStatus("idle");
    setRfDetrInspectResult(null);
    setRfDetrTrustConfirmedPath(null);
    setRfDetrVariantMode("auto");
    setRfDetrManualClassSymbol("");
    setRuntimeInstallPhase("idle");
    setRuntimeInstallLines([]);
    setRuntimeInstallError(null);
    setRuntimeInstallDetailsOpen(false);
    rfdetrInspectRequestRef.current += 1;
  }

  const handleProviderChange = (providerId: ProviderId) => {
    if (providerId === selectedProviderId) return;
    setSelectedProviderId(providerId);
    resetExportStateForProvider(providerId);
  };

  // File select — validate extension, then advance to formats view
  const handleFileSelect = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (!hasAllowedSourceExtension(trimmed, selectedProvider)) {
      setInvokeError(`${selectedProvider.displayName} accepts ${selectedProvider.sourceExtensions.join(", ")} files only.`);
      setSourcePath("");
      setView("drop");
      return;
    }
    setInvokeError(null);
    setSourcePath(trimmed);
    if (selectedProvider.id === "rfdetr") {
      setRfDetrInspectStatus("needs_trust");
      setRfDetrInspectResult(null);
      setRfDetrTrustConfirmedPath(null);
      setRfDetrVariantMode("auto");
      setRfDetrManualClassSymbol("");
    }
    setRuntimeInstallPhase("idle");
    setRuntimeInstallLines([]);
    setRuntimeInstallError(null);
    setView("formats");
  }, [selectedProvider]);

  const handleConfirmRfDetrTrust = async () => {
    if (!sourcePath || !envInfo?.python_path) return;
    const requestId = rfdetrInspectRequestRef.current + 1;
    rfdetrInspectRequestRef.current = requestId;
    setRfDetrTrustConfirmedPath(sourcePath);
    setRfDetrInspectStatus("inspecting");
    setRfDetrInspectResult(null);
    try {
      const result = await inspectRfDetrCheckpoint({
        checkpointPath: sourcePath,
        pythonPath: envInfo.python_path,
        trustConfirmed: true,
      });
      if (rfdetrInspectRequestRef.current !== requestId) return;
      setRfDetrInspectResult(result);
      setRfDetrInspectStatus(result.success ? "detected" : "failed");
      if (result.success && result.recommended_imgsz) {
        const recommended = result.recommended_imgsz;
        const nextRouteOptions = applyDetectedRouteOptionsToProviderRoutes(
          routeOptionsRef.current,
          "rfdetr",
          recommended,
          sourcePath,
        );
        routeOptionsRef.current = nextRouteOptions;

        if (selectedRouteId) {
          const selectedState = nextRouteOptions[selectedRouteId];
          if (selectedState && selectedState.source === "detected") {
            setOptions(selectedState.options);
          }
        }
      }
    } catch (error) {
      if (rfdetrInspectRequestRef.current !== requestId) return;
      setRfDetrInspectResult({
        success: false,
        class_symbol: null,
        family: null,
        size: null,
        requires_plus: false,
        is_legacy: false,
        recommended_imgsz: null,
        patch_size: null,
        token_grid: null,
        error: String(error),
      });
      setRfDetrInspectStatus("failed");
    }
  };

  // Route row clicked — open modal for that route
  const handleActivateRoute = (routeId: string) => {
    setSelectedRouteId(routeId);

    const saved = routeOptionsRef.current[routeId] ?? null;
    const routeState = getRouteOptionsForOpen(saved, routeId, selectedProvider.id, rfdetrInspectResult, sourcePath);
    setOptions(routeState.options);
    routeOptionsRef.current[routeId] = routeState;
    setLogLines([]);
    setInvokeError(null);
    setExportStatus("idle");
    setInstallPhase("idle");
    setDialogOpen(true);
  };

  // Clear file — back to drop view
  const handleClearFile = () => {
    setSourcePath("");
    setView("drop");
    setRfDetrInspectStatus("idle");
    setRfDetrInspectResult(null);
    setRfDetrTrustConfirmedPath(null);
    setRfDetrVariantMode("auto");
    setRfDetrManualClassSymbol("");
    setRuntimeInstallPhase("idle");
    setRuntimeInstallLines([]);
    setRuntimeInstallError(null);
    setRuntimeInstallDetailsOpen(false);
    rfdetrInspectRequestRef.current += 1;
  };

  // Re-detect environment with current override
  const handleRedetect = useCallback(async (overridePath?: string) => {
    const trimmedOverride = overridePath?.trim();
    setRedetecting(true);
    setEnvInfo(null);
    setEnvError(null);
    try {
      const info = await detectEnvironment(trimmedOverride || undefined);
      setEnvInfo(info);
      await refreshRouteDependencies(selectedRouteId, info.python_path || null);
      setRuntimeInstallPhase("idle");
      setRuntimeInstallLines([]);
      setRuntimeInstallError(null);
      setRuntimeInstallDetailsOpen(false);
      setRuntimeInstalledThisSession(false);
    } catch (e: unknown) {
      setEnvError(String(e));
    } finally {
      setRedetecting(false);
    }
  }, [refreshRouteDependencies, selectedRouteId]);

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

  // Save output dir override
  const handleSaveOutputDir = useCallback(async () => {
    const val = outputDirInput.trim();
    setOutputDirOverride(val);
    await saveOutputDirOverride(val || null);
  }, [outputDirInput]);

  // Browse for output directory
  const handleBrowseOutputDir = useCallback(async () => {
    const path = await openOutputDirPicker();
    if (path) setOutputDirInput(path);
  }, []);

  // Clear output dir override
  const handleClearOutputDir = useCallback(async () => {
    setOutputDirOverride("");
    setOutputDirInput("");
    await saveOutputDirOverride(null);
  }, []);

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

        {updatesEnabled ? <UpdateChecker updater={updater} /> : null}
      </div>

      {/* Settings slide-in panel */}
      <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-[340px] bg-zinc-50/80 p-0">
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
                      <TooltipContent side="top" className="whitespace-nowrap">
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
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[13px] font-semibold text-zinc-800">Python override</p>
                  {pythonOverride && (
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                      onClick={handleClearOverride}
                      title="Reset to auto-detect"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={pythonOverride}
                    onChange={(e) => setPythonOverride(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveAndRedetect(); }}
                    placeholder="Use managed Vision Export Studio runtime"
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
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  Leave empty to use Vision Export Studio&apos;s managed runtime in <code>~/.vision-export-studio/.venv</code>.
                </p>
                <div className="mt-2.5 flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 rounded-lg px-3 text-[12px]"
                    onClick={handleSaveAndRedetect}
                  >
                    Apply
                  </Button>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-200/80 bg-white p-4 shadow-sm">
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[13px] font-semibold text-zinc-800">Output directory</p>
                  {outputDirInput && (
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                      onClick={handleClearOutputDir}
                      title="Reset to auto"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={outputDirInput}
                    onChange={(e) => setOutputDirInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveOutputDir(); }}
                    placeholder="Auto (next to model file)"
                    className="h-8 flex-1 min-w-0 rounded-lg border-zinc-200 bg-zinc-50 font-mono text-[12px] placeholder:text-zinc-300 focus-visible:bg-white"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseOutputDir}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                    title="Browse for output directory"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2.5 flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 rounded-lg px-3 text-[12px]"
                    onClick={handleSaveOutputDir}
                  >
                    Apply
                  </Button>
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
            <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-white p-1">
              {providerList().map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => handleProviderChange(provider.id)}
                  className={[
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    provider.id === selectedProviderId
                      ? "bg-zinc-950 text-white"
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950",
                  ].join(" ")}
                >
                  {provider.displayName}
                </button>
              ))}
            </div>
            <DropZone
              path={sourcePath}
              title={selectedProvider.dropTitle}
              helper={selectedProvider.dropHelper}
              pickerFilterName={selectedProvider.pickerFilterName}
              pickerExtensions={selectedProvider.sourceExtensions}
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
          {selectedProviderId === "rfdetr" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {rfdetrInspectStatus === "needs_trust" && (
                <div className="space-y-3">
                  <p className="font-medium">Trusted checkpoint required</p>
                  <p>RF-DETR checkpoint inspection loads local PyTorch checkpoint data. Use checkpoints from trusted sources only.</p>
                  <Button size="sm" onClick={handleConfirmRfDetrTrust} disabled={!envInfo?.python_path}>
                    Trust and inspect
                  </Button>
                </div>
              )}
              {rfdetrInspectStatus === "inspecting" && <p>Inspecting RF-DETR checkpoint...</p>}
              {rfdetrInspectStatus === "detected" && rfdetrInspectResult && (
                <p>Detected: <span className="font-mono">{rfdetrInspectResult.class_symbol}</span>{rfdetrInspectResult.is_legacy ? " (legacy)" : ""}</p>
              )}
              {rfdetrInspectStatus === "failed" && (
                <div className="space-y-3">
                  <p>{rfdetrInspectResult?.error ?? "RF-DETR inspection failed."}</p>
                  <label className="block text-xs font-medium uppercase tracking-wide">Manual variant</label>
                  <select
                    value={rfdetrManualClassSymbol}
                    onChange={(event) => {
                      setRfDetrVariantMode("manual");
                      setRfDetrManualClassSymbol(event.target.value);
                    }}
                    className="h-9 w-full rounded-md border border-amber-300 bg-white px-3 text-sm"
                  >
                    <option value="">Select RF-DETR variant</option>
                    <optgroup label="Detection">
                      <option value="RFDETRNano">RFDETRNano</option>
                      <option value="RFDETRSmall">RFDETRSmall</option>
                      <option value="RFDETRMedium">RFDETRMedium</option>
                      <option value="RFDETRLarge">RFDETRLarge</option>
                    </optgroup>
                    <optgroup label="Detection legacy">
                      <option value="RFDETRBase">RFDETRBase (legacy)</option>
                    </optgroup>
                    <optgroup label="Segmentation">
                      <option value="RFDETRSegNano">RFDETRSegNano</option>
                      <option value="RFDETRSegSmall">RFDETRSegSmall</option>
                      <option value="RFDETRSegMedium">RFDETRSegMedium</option>
                      <option value="RFDETRSegLarge">RFDETRSegLarge</option>
                      <option value="RFDETRSegXLarge">RFDETRSegXLarge</option>
                      <option value="RFDETRSeg2XLarge">RFDETRSeg2XLarge</option>
                    </optgroup>
                  </select>
                </div>
              )}
            </div>
          )}
          {selectedProviderId === "ultralytics" && ultralyticsRuntimeInstalling && (
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-medium">
                <Loader2 className="h-4 w-4 animate-spin" />
                Installing Ultralytics runtime
              </div>
              <p>This may take a few minutes.</p>
              <button
                type="button"
                className="text-left text-xs font-medium text-amber-800 underline underline-offset-2"
                onClick={() => setRuntimeInstallDetailsOpen((open) => !open)}
              >
                {runtimeInstallDetailsOpen ? "Hide details" : "Show details"}
              </button>
              {shouldShowUltralyticsRuntimeInstallDetails(runtimeInstallPhase, runtimeInstallDetailsOpen) && (
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-amber-200 bg-white/80 p-3 font-mono text-xs text-amber-950">
                  {runtimeInstallLines.length > 0 ? runtimeInstallLines.join("\n") : "[info] Starting runtime install..."}
                </div>
              )}
            </div>
          )}
          {selectedProviderId === "ultralytics" && runtimeInstallPhase === "failed" && (
            <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <div>
                <p className="font-medium">Ultralytics runtime install failed</p>
                <p className="mt-1">{runtimeInstallError ?? "Runtime install failed."}</p>
              </div>
              {runtimeInstallLines.length > 0 && (
                <button
                  type="button"
                  className="text-left text-xs font-medium text-red-800 underline underline-offset-2"
                  onClick={() => setRuntimeInstallDetailsOpen((open) => !open)}
                >
                  {runtimeInstallDetailsOpen ? "Hide details" : "Show details"}
                </button>
              )}
              {runtimeInstallLines.length > 0 && shouldShowUltralyticsRuntimeInstallDetails(runtimeInstallPhase, runtimeInstallDetailsOpen) && (
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-red-200 bg-white/80 p-3 font-mono text-xs text-red-950">
                  {runtimeInstallLines.join("\n")}
                </div>
              )}
              <div>
                <Button size="sm" onClick={handleInstallUltralyticsRuntime} disabled={!envInfo?.python_path}>
                  Install Runtime
                </Button>
              </div>
            </div>
          )}
          {selectedProviderId === "ultralytics" && runtimeInstallPhase === "ready" && runtimeInstalledThisSession && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-medium">Ultralytics runtime ready</p>
              <p className="mt-1">{getUltralyticsRuntimeReadyDescription()}</p>
            </div>
          )}
          {selectedProviderId === "ultralytics" && !ultralyticsRuntimeReady && runtimeInstallPhase === "idle" && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div>
                <p className="font-medium">Ultralytics runtime required</p>
                <p className="mt-1">Install once to enable YOLO exports on this machine.</p>
              </div>
              <Button size="sm" onClick={handleInstallUltralyticsRuntime} disabled={!envInfo?.python_path}>
                Install Runtime
              </Button>
            </div>
          )}
          <div>
            <h2 className="mb-3 text-sm font-medium uppercase text-zinc-400">
              Export Target
            </h2>
            <RouteGrid
              routes={currentRoutes}
              onSelectRoute={handleActivateRoute}
              disabled={ultralyticsRuntimeBlocking}
              disabledReason={getUltralyticsRuntimeDisabledReason(runtimeInstallPhase)}
            />
          </div>
        </main>
      </div>

      <ExportModal
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setInstallPhase("idle");
            setInvokeError(null);
          }
        }}
        provider={selectedProvider}
        route={selectedRoute}
        sourcePath={sourcePath}
        exportStatus={exportStatus}
        logLines={logLines}
        options={options}
        onOptionsChange={(next) => setOptionsWithSource(next, "user")}
        onExport={handleExport}
        onStopExport={handleCancel}
        depResults={depResults ?? undefined}
        depCheckLoading={depCheckLoading}
        depCheckError={depCheckError}
        errorMsg={invokeError}
        installPhase={installPhase}
        missingPackageNames={missingPackageNames}
        onInstallAndExport={handleInstallAndExport}
        outputDir={(() => {
          const out = outputDirOverride.trim();
          if (out) return out;
          const sep = sourcePath.includes("/") ? "/" : "\\";
          const lastSep = sourcePath.lastIndexOf(sep);
          const parentDir = lastSep > 0 ? sourcePath.substring(0, lastSep) : "";
          return parentDir ? `${parentDir}${sep}vision-export-studio-exports` : "";
        })()}
        rfdetrSummary={selectedProviderId === "rfdetr" ? {
          variantMode: rfdetrVariantMode,
          detectedClass: rfdetrInspectResult?.class_symbol ?? null,
          selectedClass: rfdetrVariantMode === "manual" ? rfdetrManualClassSymbol : null,
          trusted: rfdetrTrustConfirmedPath === sourcePath,
          recommendedImgsz: rfdetrInspectResult?.recommended_imgsz ?? null,
          patchSize: rfdetrInspectResult?.patch_size ?? null,
        } : null}
      />
    </div>
  );
}
