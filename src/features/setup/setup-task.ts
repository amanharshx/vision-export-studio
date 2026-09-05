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
import type { BootstrapPythonResult, PythonRequiredResult } from "@/lib/tauri/bootstrap-python";
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
  // True when the managed environment may not exist yet and the backend will
  // create it from the bootstrap interpreter before installing. The task
  // reports creating-environment until the install session starts, then
  // installing-packages; terminal refresh publishes the managed interpreter.
  createsEnvironment?: boolean;
}

export interface SetupTask {
  provider: ProviderId;
  routeId: string | null;
  environmentKey: ManagedEnvironmentKey;
  pythonPath: string;
  createsEnvironment: boolean;
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
  const initialPhase: SetupTaskPhase = input.createsEnvironment
    ? "creating-environment"
    : "installing-packages";
  return {
    provider: input.provider,
    routeId: input.routeId,
    environmentKey: input.environmentKey,
    pythonPath: input.pythonPath,
    createsEnvironment: input.createsEnvironment ?? false,
    phase: initialPhase,
    summary: setupTaskSummaryForPhase(initialPhase, input.provider),
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
  // Managed interpreter to verify after install when the bootstrap Python
  // differs (on-demand creation). Defaults to pythonPath.
  verifyPythonPath?: string;
  // Runs inside the setup lifecycle after verification, before the task
  // succeeds; a throw fails the task so persistence failure cannot coexist
  // with success. Recreate marks setup complete here.
  finalize?: () => Promise<unknown>;
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
  choosePythonForSetup: (
    gateDeps: PythonRequiredDeps,
    chosenPath: string,
    expectedPending?: PendingPythonSetup | null,
  ) => Promise<void>;
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
  // Serializes every gate settings write (plus its staleness
  // reconciliation) so overlapping choose/clear flows cannot interleave
  // writes: each unit completes fully before the next begins. Without this,
  // a stale flow finishing after its replacement would leave its own write
  // persisted last, and no post-hoc check could put the winner's back.
  let saveLock: Promise<void> = Promise.resolve();

  const withSaveLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = saveLock;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    saveLock = mine;
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const setPythonGate = (next: PythonRequiredState) => {
    pythonGate = next;
    emit();
  };

  const closePythonGate = () => {
    setPythonGate({ pending: null, result: null, dialogOpen: false, choiceError: null, busy: false });
  };

  // Close the gate and run only when nothing replaced or canceled it while
  // closing: subscribers run synchronously inside the close emit, so the
  // ownership check must happen after closePythonGate returns, not before.
  const closeGateAndRunIfCurrent = async (
    generation: number,
    pending: PendingPythonSetup,
  ): Promise<void> => {
    const run = pending.run;
    closePythonGate();
    if (pythonGeneration !== generation) return;
    await run();
  };

  const isGateCurrent = (generation: number, pending: PendingPythonSetup) =>
    generation === pythonGeneration && pythonGate.pending === pending;

  // Single entry sequence shared by every gate action: guard, capture the
  // generation plus pending identity, then mark busy. Callers snapshot the
  // returned triple and re-check it after each await so a canceled or
  // replaced pending can never be resumed, saved for, or retried.
  const beginGateAction = (): {
    generation: number;
    pending: PendingPythonSetup;
    previous: PythonRequiredResult;
  } | null => {
    const started = pythonGate;
    if (!started.dialogOpen || !started.pending || !started.result || started.busy) return null;
    const action = {
      generation: pythonGeneration,
      pending: started.pending,
      previous: started.result,
    };
    setPythonGate({ ...started, busy: true, choiceError: null });
    return action;
  };

  const failPythonGate = (
    generation: number,
    pending: PendingPythonSetup,
    message: string,
  ) => {
    if (!isGateCurrent(generation, pending)) return;
    setPythonGate({ ...pythonGate, busy: false, choiceError: message });
  };

  // Restore the override a stale flow persisted, unless something else
  // already wrote after it. A gate action that never reaches retry leaves
  // settings exactly as it found them; whatever wrote last always stands,
  // so this re-reads before touching anything. Callers run it inside the
  // save lock, which keeps overlapping flows from interleaving with it.
  const reconcileStaleSave = async (
    gateDeps: PythonRequiredDeps,
    myWrite: string | null,
    previousOverride: string | null,
  ): Promise<void> => {
    let current: string | null;
    try {
      current = await gateDeps.loadOverride();
    } catch {
      return;
    }
    if (current !== myWrite) return;
    try {
      await gateDeps.saveOverride(previousOverride);
    } catch {
      // No live dialog owns this error: the stale flow is closed and the
      // replacement, if any, shows its own state.
    }
  };

  // The complete settings transaction as one serialized owner operation:
  // acquire the lock, re-check currency, snapshot, save, then reconcile a
  // stale write — all before the next queued flow begins. Checking before
  // waiting for the lock is not enough: a flow can go stale while queued
  // and must then perform no write at all. Returns true only when still
  // live after the unit.
  const runGateSaveUnit = async (
    gateDeps: PythonRequiredDeps,
    generation: number,
    pending: PendingPythonSetup,
    value: string | null,
  ): Promise<boolean> => {
    return withSaveLock(async () => {
      if (!isGateCurrent(generation, pending)) return false;
      let previousOverride: string | null;
      try {
        previousOverride = await gateDeps.loadOverride();
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return false;
      }
      if (!isGateCurrent(generation, pending)) return false;
      try {
        await gateDeps.saveOverride(value);
      } catch (error) {
        failPythonGate(generation, pending, String(error));
        return false;
      }
      if (!isGateCurrent(generation, pending)) {
        await reconcileStaleSave(gateDeps, value, previousOverride);
      }
      return isGateCurrent(generation, pending);
    });
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
      await closeGateAndRunIfCurrent(generation, pending);
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
      const initial = createSetupTask(request);
      setTask({
        ...initial,
        summary: request.summary ?? initial.summary,
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
              if (!current) return;
              // Backend venv creation finishes before the install session is
              // assigned, so the session marks the honest creation → install
              // transition for on-demand setups.
              if (current.createsEnvironment && current.phase === "creating-environment") {
                setTask({
                  ...current,
                  sessionId,
                  phase: "installing-packages",
                  summary: setupTaskSummaryForPhase("installing-packages", current.provider),
                });
              } else {
                setTask({ ...current, sessionId });
              }
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
        verified = await deps.verifyEnvironment(request.verifyPythonPath ?? request.pythonPath);
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
      if (request.finalize) {
        try {
          await request.finalize();
        } catch (error) {
          const message = String(error);
          failActiveTask(message);
          return { ok: false, error: message };
        }
        const afterFinalize = task;
        if (!afterFinalize || afterFinalize.status !== "active") return outcome;
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
      // Bump even when already closed: a finishing flow may be sitting
      // between its final check and its run, and that run must not happen.
      pythonGeneration += 1;
      if (!pythonGate.dialogOpen && !pythonGate.pending) return;
      closePythonGate();
    },

    choosePythonForSetup: async (gateDeps, chosenPath, expectedPending) => {
      // A native picker resolves outside the race-safe boundary: the pending
      // action may have been canceled or replaced while it was open. The
      // caller captures the pending it chose for and passes it back; a
      // mismatch means this choice belongs to a dead dialog.
      if (expectedPending !== undefined && pythonGate.pending !== expectedPending) return;
      const started = beginGateAction();
      if (!started) return;
      const { generation, pending } = started;
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
      // validation was in flight; the save unit re-checks after acquiring
      // the lock, so a stale choice still never saves.
      if (!isGateCurrent(generation, pending)) return;
      const live = await runGateSaveUnit(gateDeps, generation, pending, chosenPath);
      if (!live || !isGateCurrent(generation, pending)) return;
      await closeGateAndRunIfCurrent(generation, pending);
    },

    checkAgainPythonGate: async (gateDeps) => {
      const started = beginGateAction();
      if (!started) return;
      const { generation, pending, previous } = started;
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
      const started = beginGateAction();
      if (!started) return;
      const { generation, pending, previous } = started;
      const live = await runGateSaveUnit(gateDeps, generation, pending, null);
      if (!live || !isGateCurrent(generation, pending)) return;
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
  loadOverride: () => Promise<string | null>;
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
