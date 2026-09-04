// App-wide environment-setup task model for ticket 03.
//
// Represents one active setup operation (provider, route, environment key,
// honest named phase, summary, logs, terminal result). The install event
// pipeline (session-isolated buffering) lives here as the single shared
// implementation, and createSetupTaskOwner holds the listener lifecycle so
// producer unmount cannot terminate the event stream. No numeric percentages
// are used anywhere in this slice.

import type {
  InstallableDependency,
  InstallFailedPayload,
  InstallFinishedPayload,
  InstallLinePayload,
  ManagedEnvironmentKey,
  ProviderId,
} from "@/lib/types";
import { createListenerGroup, type ListenerGroup } from "@/lib/tauri/listener-group";

export type SetupTaskPhase =
  | "finding-python"
  | "creating-environment"
  | "installing-packages"
  | "checking-environment"
  | "ready"
  | "failed";

export type SetupTaskStatus = "active" | "succeeded" | "failed";

export interface SetupTaskInput {
  provider: ProviderId;
  routeId: string | null;
  environmentKey: ManagedEnvironmentKey;
}

export interface SetupTask {
  provider: ProviderId;
  routeId: string | null;
  environmentKey: ManagedEnvironmentKey;
  phase: SetupTaskPhase;
  summary: string;
  logs: string[];
  sessionId: string;
  status: SetupTaskStatus;
  error: string | null;
  detailsOpen: boolean;
  dismissed: boolean;
}

// Named future phases stay declared (the ticket names them explicitly); only
// the phases a flow reaches are ever assigned.
const SETUP_TASK_PHASE_META: Record<
  SetupTaskPhase,
  { label: string; summary: (provider: string) => string }
> = {
  "finding-python": {
    label: "Finding Python",
    summary: (provider) => `Finding Python for ${provider}…`,
  },
  "creating-environment": {
    label: "Creating environment",
    summary: (provider) => `Creating ${provider} environment…`,
  },
  "installing-packages": {
    label: "Installing packages",
    summary: (provider) => `Installing ${provider} runtime…`,
  },
  "checking-environment": {
    label: "Checking environment",
    summary: (provider) => `Checking ${provider} environment…`,
  },
  ready: {
    label: "Ready",
    summary: (provider) => `${provider} runtime ready`,
  },
  failed: {
    label: "Failed",
    summary: (provider) => `${provider} setup failed`,
  },
};

export function setupTaskPhaseLabel(phase: SetupTaskPhase): string {
  return SETUP_TASK_PHASE_META[phase].label;
}

export function setupTaskSummaryForPhase(
  phase: SetupTaskPhase,
  providerLabel: string,
): string {
  return SETUP_TASK_PHASE_META[phase].summary(providerLabel);
}

/** Visible while active and after terminal until explicitly dismissed. */
export function isSetupTaskVisible(task: SetupTask | null): boolean {
  if (!task) return false;
  return !task.dismissed;
}

/** Only terminal tasks can be dismissed; active setup stays visible. */
export function canDismissSetupTask(task: SetupTask): boolean {
  return task.status !== "active";
}

export function createSetupTask(input: SetupTaskInput): SetupTask {
  return {
    provider: input.provider,
    routeId: input.routeId,
    environmentKey: input.environmentKey,
    phase: "installing-packages",
    summary: setupTaskSummaryForPhase("installing-packages", input.provider),
    logs: [],
    sessionId: "",
    status: "active",
    error: null,
    detailsOpen: false,
    dismissed: false,
  };
}

export function formatSetupTaskScope(
  task: Pick<SetupTask, "provider" | "routeId" | "environmentKey">,
): string {
  return `${task.provider} · ${task.routeId ?? "base runtime"} · ${task.environmentKey}`;
}

// ---------------------------------------------------------------------------
// Single install event pipeline (moved from export-workspace).
// ---------------------------------------------------------------------------
type BufferedInstallEvent =
  | { kind: "stdout"; payload: InstallLinePayload }
  | { kind: "stderr"; payload: InstallLinePayload }
  | { kind: "finished"; payload: InstallFinishedPayload }
  | { kind: "failed"; payload: InstallFailedPayload };

export type InstallOutcome = { ok: true } | { ok: false; error: string };

export interface InstallStreamInput {
  routeId: string | null;
  packages: InstallableDependency[];
  pythonPath: string;
}

export interface InstallStreamSink {
  onLine: (line: string) => void;
  onSession?: (sessionId: string) => void;
}

/**
 * Single shared install stream runner: registers the four install events,
 * starts the install, assigns the session (replaying early events), and
 * resolves with a discriminated terminal outcome. Listener disposal stays
 * with the caller (app-wide owner or screen), so producer-unmount policy
 * is explicit at each call site.
 */
export async function runInstallStream(
  deps: InstallStreamDeps,
  group: ListenerGroup,
  input: InstallStreamInput,
  sink: InstallStreamSink,
): Promise<InstallOutcome> {
  let sessionId = "";
  let terminalHandled = false;
  const pending: BufferedInstallEvent[] = [];
  let resolveTerminal!: (outcome: InstallOutcome) => void;
  const terminal = new Promise<InstallOutcome>((resolve) => {
    resolveTerminal = resolve;
  });

  const handle = (event: BufferedInstallEvent) => {
    if (terminalHandled || event.payload.session_id !== sessionId) return;
    if (event.kind === "stdout") sink.onLine("[stdout] " + event.payload.line);
    if (event.kind === "stderr") sink.onLine("[stderr] " + event.payload.line);
    if (event.kind === "finished") {
      terminalHandled = true;
      resolveTerminal({ ok: true });
    } else if (event.kind === "failed") {
      terminalHandled = true;
      resolveTerminal({ ok: false, error: event.payload.error });
    }
  };
  const receive = (event: BufferedInstallEvent) => {
    if (sessionId) handle(event);
    else pending.push(event);
  };

  await Promise.all([
    group.add(
      deps.listenInstallEvent<InstallLinePayload>("install:stdout", (ev) => {
        receive({ kind: "stdout", payload: ev.payload });
      }),
    ),
    group.add(
      deps.listenInstallEvent<InstallLinePayload>("install:stderr", (ev) => {
        receive({ kind: "stderr", payload: ev.payload });
      }),
    ),
    group.add(
      deps.listenInstallEvent<InstallFinishedPayload>("install:finished", (ev) => {
        receive({ kind: "finished", payload: ev.payload });
      }),
    ),
    group.add(
      deps.listenInstallEvent<InstallFailedPayload>("install:failed", (ev) => {
        receive({ kind: "failed", payload: ev.payload });
      }),
    ),
  ]);
  const assignedSessionId = await deps.startInstall(
    input.routeId,
    input.packages,
    input.pythonPath,
  );
  sessionId = assignedSessionId;
  for (const event of pending) handle(event);
  pending.length = 0;
  sink.onSession?.(assignedSessionId);
  return terminal;
}

// ---------------------------------------------------------------------------
// App-wide owner: holds the task and the listener lifecycle. Listeners are
// disposed only here (terminal, replacement, or app teardown), never by a
// producing screen's unmount.
// ---------------------------------------------------------------------------

export interface RuntimeInstallRequest extends SetupTaskInput {
  packages: InstallableDependency[];
  pythonPath: string;
  summary?: string;
}

export interface InstallStreamDeps {
  listenInstallEvent: <T>(
    event: string,
    handler: (ev: { payload: T }) => void,
  ) => Promise<() => void>;
  startInstall: (
    routeId: string | null,
    packages: InstallableDependency[],
    pythonPath: string,
  ) => Promise<string>;
}

export interface SetupTaskOwner {
  getState: () => SetupTask | null;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
  startRuntimeInstall: (request: RuntimeInstallRequest) => Promise<InstallOutcome>;
  succeedTask: (summary?: string) => void;
  failTask: (error: string) => void;
  openDetails: () => void;
  closeDetails: () => void;
  dismissTask: () => void;
}

export function createSetupTaskOwner(deps: InstallStreamDeps): SetupTaskOwner {
  let task: SetupTask | null = null;
  const subscribers = new Set<() => void>();
  let installGroup: ReturnType<typeof createListenerGroup> | null = null;

  const emit = () => {
    for (const listener of [...subscribers]) listener();
  };

  const setTask = (next: SetupTask | null) => {
    task = next;
    emit();
  };

  const teardownInstallListeners = () => {
    installGroup?.dispose();
    installGroup = null;
  };

  const failActiveTask = (error: string) => {
    if (!task || task.status !== "active") return;
    setTask({
      ...task,
      phase: "failed",
      status: "failed",
      error,
      summary: setupTaskSummaryForPhase("failed", task.provider),
    });
  };

  return {
    getState: () => task,

    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    dispose: () => {
      teardownInstallListeners();
      subscribers.clear();
    },

    startRuntimeInstall: async (request) => {
      if (task?.status === "active") {
        return {
          ok: false,
          error:
            "Another runtime operation is in progress. Wait for it to finish before installing dependencies.",
        };
      }
      // Terminal results stay until viewed or dismissed; a replacement must
      // explicitly acknowledge them first (the retry path dismisses below).
      if (task && !task.dismissed) {
        return {
          ok: false,
          error: "Dismiss the previous setup result before starting a new setup.",
        };
      }
      teardownInstallListeners();
      setTask({
        ...createSetupTask(request),
        summary:
          request.summary ?? setupTaskSummaryForPhase("installing-packages", request.provider),
      });

      const group = createListenerGroup();
      installGroup = group;
      let outcome: InstallOutcome;
      try {
        outcome = await runInstallStream(
          deps,
          group,
          {
            routeId: request.routeId,
            packages: request.packages,
            pythonPath: request.pythonPath,
          },
          {
            onLine: (line) => {
              const current = task;
              if (current && current.status === "active") {
                setTask({ ...current, logs: [...current.logs, line] });
              }
            },
            onSession: (sessionId) => {
              const current = task;
              if (current) setTask({ ...current, sessionId });
            },
          },
        );
      } catch (error) {
        teardownInstallListeners();
        const message = String(error);
        failActiveTask(message);
        return { ok: false, error: message };
      }
      teardownInstallListeners();

      const current = task;
      if (!current || current.status !== "active") return outcome;
      if (!outcome.ok) {
        failActiveTask(outcome.error);
        return outcome;
      }
      setTask({
        ...current,
        phase: "checking-environment",
        summary: setupTaskSummaryForPhase("checking-environment", current.provider),
      });
      return outcome;
    },

    succeedTask: (summary) => {
      if (!task || task.status !== "active") return;
      setTask({
        ...task,
        phase: "ready",
        status: "succeeded",
        error: null,
        summary: summary ?? setupTaskSummaryForPhase("ready", task.provider),
      });
    },

    failTask: (error) => {
      failActiveTask(error);
    },

    openDetails: () => {
      if (!task) return;
      setTask({ ...task, detailsOpen: true });
    },

    closeDetails: () => {
      if (!task) return;
      setTask({ ...task, detailsOpen: false });
    },

    dismissTask: () => {
      if (!task || !canDismissSetupTask(task)) return;
      setTask({ ...task, dismissed: true, detailsOpen: false });
    },
  };
}
