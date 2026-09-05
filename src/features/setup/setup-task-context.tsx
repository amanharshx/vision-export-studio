import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { installDependencies } from "@/lib/tauri/deps";
import { detectEnvironment } from "@/lib/tauri/environment";
import { resolveBootstrapPython, type BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";
import { loadSettings, savePythonOverride } from "@/lib/tauri/setup";
import {
  createSetupTaskOwner,
  getSetupCloseWarning,
  isSetupTaskActive,
  type InstallOutcome,
  type InstallStreamDeps,
  type PendingPythonSetup,
  type PythonRequiredDeps,
  type PythonRequiredState,
  type RuntimeInstallRequest,
  type SetupTask,
} from "./setup-task";

export interface SetupTaskContextValue {
  task: SetupTask | null;
  startRuntimeInstall: (request: RuntimeInstallRequest) => Promise<InstallOutcome>;
  openDetails: () => void;
  closeDetails: () => void;
  dismissTask: () => void;
  pythonGate: PythonRequiredState;
  requirePythonForSetup: (
    routeId: string,
    result: BootstrapPythonResult,
    run: () => Promise<unknown>,
  ) => boolean;
  cancelPythonGate: () => void;
  choosePythonForSetup: (
    chosenPath: string,
    expectedPending?: PendingPythonSetup | null,
  ) => Promise<void>;
  checkAgainPythonGate: () => Promise<void>;
  clearPythonGateOverride: () => Promise<void>;
}

const SetupTaskContext = createContext<SetupTaskContextValue | null>(null);

const realDeps: InstallStreamDeps = {
  listenInstallEvent: (event, handler) => listen(event, handler),
  startInstall: (routeId, packages, pythonPath) =>
    installDependencies(routeId, packages, pythonPath),
  verifyEnvironment: async (pythonPath) => {
    const info = await detectEnvironment(pythonPath);
    return { yoloPath: info.yolo_path ?? null };
  },
};

const realGateDeps: PythonRequiredDeps = {
  resolveBootstrap: (routeId, override) => resolveBootstrapPython(routeId, override),
  saveOverride: (path) => savePythonOverride(path),
  loadOverride: async () => (await loadSettings()).python_path_override ?? null,
};

export function SetupTaskProvider({ children }: { children: React.ReactNode }) {
  const ownerRef = useRef<ReturnType<typeof createSetupTaskOwner> | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = createSetupTaskOwner(realDeps);
  }
  const owner = ownerRef.current;
  const task = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);
  const pythonGate = useSyncExternalStore(
    owner.subscribe,
    owner.getPythonGate,
    owner.getPythonGate,
  );

  useEffect(() => () => owner.dispose(), [owner]);

  // Warn before closing while setup owns the guard. No in-app Cancel.
  // Retry stays available after restart; stale progress is discarded.
  const active = isSetupTaskActive(task);
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined") return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const current = getSetupCloseWarning(taskRef.current);
      if (!current) return;
      event.preventDefault();
      event.returnValue = current;
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      // Native dialog: window.confirm is unreliable inside the webview, and a
      // failed dialog must keep the app open rather than let it close.
      // On confirm, the unload guard is dropped first so teardown cannot
      // trigger a second prompt that would jam the close.
      const promise = getCurrentWindow().onCloseRequested(async (event) => {
        const current = getSetupCloseWarning(taskRef.current);
        if (!current) return;
        let confirmed = false;
        try {
          confirmed = await confirm(current, { title: "Setup in progress", kind: "warning" });
        } catch {
          confirmed = false;
        }
        if (!confirmed) {
          event.preventDefault();
          return;
        }
        window.removeEventListener("beforeunload", handleBeforeUnload);
      });
      void promise
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {
          // Non-Tauri browser: beforeunload already covers this case.
        });
    } catch {
      // Non-Tauri browser: beforeunload already covers this case.
    }

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unlisten?.();
    };
  }, [active]);

  const value = useMemo<SetupTaskContextValue>(
    () => ({
      task,
      startRuntimeInstall: (request) => owner.startRuntimeInstall(request),
      openDetails: () => owner.openDetails(),
      closeDetails: () => owner.closeDetails(),
      dismissTask: () => owner.dismissTask(),
      pythonGate,
      requirePythonForSetup: (routeId, result, run) =>
        owner.requirePythonForSetup(routeId, result, run),
      cancelPythonGate: () => owner.cancelPythonGate(),
      choosePythonForSetup: (chosenPath, expectedPending) =>
        owner.choosePythonForSetup(realGateDeps, chosenPath, expectedPending),
      checkAgainPythonGate: () => owner.checkAgainPythonGate(realGateDeps),
      clearPythonGateOverride: () => owner.clearPythonGateOverride(realGateDeps),
    }),
    [owner, task, pythonGate],
  );

  return (
    <SetupTaskContext.Provider value={value}>
      {children}
    </SetupTaskContext.Provider>
  );
}

export function useSetupTask(): SetupTaskContextValue {
  const value = useContext(SetupTaskContext);
  if (!value) {
    throw new Error("useSetupTask must be used within SetupTaskProvider");
  }
  return value;
}
