import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { installDependencies } from "@/lib/tauri/deps";
import {
  createSetupTaskOwner,
  type InstallOutcome,
  type InstallStreamDeps,
  type RuntimeInstallRequest,
  type SetupTask,
} from "./setup-task";

export interface SetupTaskContextValue {
  task: SetupTask | null;
  startRuntimeInstall: (request: RuntimeInstallRequest) => Promise<InstallOutcome>;
  succeedTask: (summary?: string) => void;
  failTask: (error: string) => void;
  openDetails: () => void;
  closeDetails: () => void;
  dismissTask: () => void;
}

const SetupTaskContext = createContext<SetupTaskContextValue | null>(null);

const realDeps: InstallStreamDeps = {
  listenInstallEvent: (event, handler) => listen(event, handler),
  startInstall: (routeId, packages, pythonPath) =>
    installDependencies(routeId, packages, pythonPath),
};

export function SetupTaskProvider({ children }: { children: React.ReactNode }) {
  const ownerRef = useRef<ReturnType<typeof createSetupTaskOwner> | null>(null);
  if (!ownerRef.current) {
    ownerRef.current = createSetupTaskOwner(realDeps);
  }
  const owner = ownerRef.current;
  const task = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);

  useEffect(() => () => owner.dispose(), [owner]);

  const value = useMemo<SetupTaskContextValue>(
    () => ({
      task,
      startRuntimeInstall: (request) => owner.startRuntimeInstall(request),
      succeedTask: (summary) => owner.succeedTask(summary),
      failTask: (error) => owner.failTask(error),
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
