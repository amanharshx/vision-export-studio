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
import type { BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";
import { isPythonRequiredResult } from "@/lib/tauri/bootstrap-python";

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
  // Bootstrap interpreter captured when setup starts. Terminal refresh uses
  // this stable path, never the live editable Python input.
  pythonPath: string;
}

export interface SetupTask {
  provider: ProviderId;
  routeId: string | null;
  environmentKey: ManagedEnvironmentKey;
  pythonPath: string;
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

/** Single consistent message for every action blocked while setup owns the guard. */
export const SETUP_CONFLICT_MESSAGE =
  "Setup is in progress. Wait for it to finish before starting another operation.";

/** Warning shown before closing the app while setup is active. */
export const SETUP_CLOSE_WARNING_MESSAGE =
  "Setup is still in progress. Closing now will interrupt it. You can retry setup after restart.";

/** True while a setup task owns the runtime operation guard. */
export function isSetupTaskActive(task: SetupTask | null): boolean {
  return task?.status === "active";
}

/** Close warning while setup is active, or null when idle. */
export function getSetupCloseWarning(task: SetupTask | null): string | null {
  return isSetupTaskActive(task) ? SETUP_CLOSE_WARNING_MESSAGE : null;
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
    pythonPath: input.pythonPath,
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
  deps: InstallEventDeps,
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
  summary?: string;
}

export interface InstallEventDeps {
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

export interface InstallStreamDeps extends InstallEventDeps {
  verifyEnvironment: (pythonPath: string) => Promise<{ yoloPath: string | null }>;
}

export interface SetupTaskOwner {
  getState: () => SetupTask | null;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
  startRuntimeInstall: (request: RuntimeInstallRequest) => Promise<InstallOutcome>;
  openDetails: () => void;
  closeDetails: () => void;
  dismissTask: () => void;
  getPythonGate: () => PythonRequiredState;
  /** Store a Python-blocked setup and open the dialog. Replaces any pending action. */
  requirePythonForSetup: (
    routeId: string,
    result: BootstrapPythonResult,
    run: () => Promise<unknown>,
  ) => boolean;
  /** Cancel without creating an environment or changing package state. */
  cancelPythonGate: () => void;
  /** Validate a chosen executable, save it, then retry the pending setup once. */
  choosePythonForSetup: (gateDeps: PythonRequiredDeps, chosenPath: string) => Promise<void>;
  /** Re-detect with the saved override, then retry once when available. */
  checkAgainPythonGate: (gateDeps: PythonRequiredDeps) => Promise<void>;
  /** Clear a saved invalid override, then re-detect and retry once when available. */
  clearPythonGateOverride: (gateDeps: PythonRequiredDeps) => Promise<void>;
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

  // Python-required pending gate (ticket 06). Lives in this owner so there
  // is one app-wide setup store, not a parallel one. A generation token plus
  // pending identity rejects stale async completions: cancel or replacement
  // bumps the generation, and any in-flight validation/redetection that
  // resumes against an old generation or a replaced pending is discarded
  // without running anything or touching the new state.
  let pythonGate: PythonRequiredState = emptyPythonRequiredState();
  let pythonGeneration = 0;

  const setPythonGate = (next: PythonRequiredState) => {
    pythonGate = next;
    emit();
  };

  const closePythonGate = () => {
    setPythonGate({ pending: null, result: null, dialogOpen: false, choiceError: null, busy: false });
  };

  const isGateCurrent = (generation: number, pending: PendingPythonSetup) =>
    generation === pythonGeneration && pythonGate.pending === pending;

  const failPythonGate = (
    generation: number,
    pending: PendingPythonSetup,
    message: string,
  ) => {
    if (!isGateCurrent(generation, pending)) return;
    setPythonGate({ ...pythonGate, busy: false, choiceError: message });
  };

  // Single redetect/retry transition shared by check-again and
  // clear-override so the two paths cannot drift.
  const settleRedetected = async (
    generation: number,
    pending: PendingPythonSetup,
    previous: PythonRequiredResult,
    redetected: BootstrapPythonResult,
  ): Promise<void> => {
    if (!isGateCurrent(generation, pending)) return;
    if (redetected.status === "available") {
      const run = pending.run;
      closePythonGate();
      await run();
      return;
    }
    if (isPythonRequiredResult(redetected)) {
      setPythonGate({ pending, result: redetected, dialogOpen: true, busy: false, choiceError: null });
      return;
    }
    setPythonGate({
      pending,
      result: previous,
      dialogOpen: true,
      busy: false,
      choiceError: pythonRequiredReasonOf(redetected),
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
          error: SETUP_CONFLICT_MESSAGE,
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
      // Own the full install → verify → terminal lifecycle so an unmounted
      // producer (e.g. Landing navigation) cannot strand completion.
      setTask({
        ...current,
        phase: "checking-environment",
        summary: setupTaskSummaryForPhase("checking-environment", current.provider),
      });
      let verified: { yoloPath: string | null };
      try {
        verified = await deps.verifyEnvironment(request.pythonPath);
      } catch (error) {
        const message = String(error);
        failActiveTask(message);
        return { ok: false, error: message };
      }
      const afterVerify = task;
      if (!afterVerify || afterVerify.status !== "active") return outcome;
      if (!verified.yoloPath) {
        const message =
          "Ultralytics runtime install finished, but YOLO CLI was still not detected.";
        failActiveTask(message);
        return { ok: false, error: message };
      }
      setTask({
        ...afterVerify,
        phase: "ready",
        status: "succeeded",
        error: null,
        summary: setupTaskSummaryForPhase("ready", afterVerify.provider),
      });
      return { ok: true };
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

    getPythonGate: () => pythonGate,

    requirePythonForSetup: (routeId, result, run) => {
      if (!isPythonRequiredResult(result)) return false;
      pythonGeneration += 1;
      setPythonGate({
        pending: { routeId, run },
        result,
        dialogOpen: true,
        choiceError: null,
        busy: false,
      });
      return true;
    },

    cancelPythonGate: () => {
      if (!pythonGate.dialogOpen && !pythonGate.pending) return;
      pythonGeneration += 1;
      closePythonGate();
    },

    choosePythonForSetup: async (gateDeps, chosenPath) => {
      const started = pythonGate;
      if (!started.dialogOpen || !started.pending || !started.result || started.busy) return;
      const generation = pythonGeneration;
      const pending = started.pending;
      setPythonGate({ ...started, busy: true, choiceError: null });
      let validated: BootstrapPythonResult;
      try {
        validated = await gateDeps.resolveBootstrap(pending.routeId, chosenPath);
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return;
      }
      if (validated.status !== "available") {
        failPythonGate(generation, pending, pythonRequiredReasonOf(validated));
        return;
      }
      // The pending action may have been canceled or replaced while
      // validation was in flight; never save for a stale choice.
      if (!isGateCurrent(generation, pending)) return;
      try {
        await gateDeps.saveOverride(chosenPath);
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return;
      }
      if (!isGateCurrent(generation, pending)) return;
      const run = pending.run;
      closePythonGate();
      await run();
    },

    checkAgainPythonGate: async (gateDeps) => {
      const started = pythonGate;
      if (!started.dialogOpen || !started.pending || !started.result || started.busy) return;
      const generation = pythonGeneration;
      const pending = started.pending;
      const previous = started.result;
      setPythonGate({ ...started, busy: true, choiceError: null });
      let redetected: BootstrapPythonResult;
      try {
        redetected = await gateDeps.resolveBootstrap(pending.routeId);
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return;
      }
      await settleRedetected(generation, pending, previous, redetected);
    },

    clearPythonGateOverride: async (gateDeps) => {
      const started = pythonGate;
      if (!started.dialogOpen || !started.pending || !started.result || started.busy) return;
      const generation = pythonGeneration;
      const pending = started.pending;
      const previous = started.result;
      setPythonGate({ ...started, busy: true, choiceError: null });
      try {
        await gateDeps.saveOverride(null);
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return;
      }
      if (!isGateCurrent(generation, pending)) return;
      let redetected: BootstrapPythonResult;
      try {
        redetected = await gateDeps.resolveBootstrap(pending.routeId);
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return;
      }
      await settleRedetected(generation, pending, previous, redetected);
    },
  };
}

// ---------------------------------------------------------------------------
// Python-required pending gate (ticket 06): holds at most one
// Python-blocked setup action. The dialog opens only after an explicit setup
// attempt reports missing/incompatible Python, never on launch or upload. A
// valid choice or successful redetection retries the stored action exactly
// once; cancel and replacement never run the old action.
// ---------------------------------------------------------------------------

export type PythonRequiredResult = Extract<
  BootstrapPythonResult,
  { status: "missing" | "invalid_override" }
>;

export interface PendingPythonSetup {
  routeId: string;
  run: () => Promise<unknown>;
}

export interface PythonRequiredDeps {
  resolveBootstrap: (
    routeId: string,
    override?: string,
  ) => Promise<BootstrapPythonResult>;
  saveOverride: (path: string | null) => Promise<void>;
}

export interface PythonRequiredState {
  pending: PendingPythonSetup | null;
  result: PythonRequiredResult | null;
  dialogOpen: boolean;
  choiceError: string | null;
  busy: boolean;
}

function emptyPythonRequiredState(): PythonRequiredState {
  return { pending: null, result: null, dialogOpen: false, choiceError: null, busy: false };
}

function pythonRequiredReasonOf(result: BootstrapPythonResult): string {
  if (result.status === "missing" || result.status === "invalid_override") {
    return result.reason;
  }
  if (result.status === "error") return result.reason;
  return "";
}
