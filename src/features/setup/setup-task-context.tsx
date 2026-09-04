import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { installDependencies } from "@/lib/tauri/deps";
import { detectEnvironment } from "@/lib/tauri/environment";
import {
  createSetupTaskOwner,
  getSetupCloseWarning,
  isSetupTaskActive,
  type InstallOutcome,
  type InstallStreamDeps,
  type RuntimeInstallRequest,
  type SetupTask,
} from "./setup-task";

export interface SetupTaskContextValue {
  task: SetupTask | null;
  startRuntimeInstall: (request: RuntimeInstallRequest) => Promise<InstallOutcome>;
  openDetails: () => void;
  closeDetails: () => void;
  dismissTask: () => void;
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

export function SetupTaskProvider({ children }: { children: React.ReactNode }) {
  const ownerRef = useRef<ReturnType<typeof createSetupTaskOwner> | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = createSetupTaskOwner(realDeps);
  }
  const owner = ownerRef.current;
  const task = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);

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
      const promise = getCurrentWindow().onCloseRequested((event) => {
        const current = getSetupCloseWarning(taskRef.current);
        if (!current) return;
        const confirmed = window.confirm(current);
        if (!confirmed) event.preventDefault();
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
    }),
    [owner, task],
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
