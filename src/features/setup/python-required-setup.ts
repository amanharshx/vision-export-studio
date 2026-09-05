// Pending-setup owner for ticket 06.
//
// Holds at most one Python-dependent setup action. The dialog opens only
// after an explicit setup attempt reports missing/incompatible Python, never
// on launch or upload. A valid choice or successful redetection retries the
// stored action exactly once; cancel and replacement never run the old action.

import type { BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";
import { isPythonRequiredResult } from "@/lib/tauri/bootstrap-python";

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

function emptyState(): PythonRequiredState {
  return { pending: null, result: null, dialogOpen: false, choiceError: null, busy: false };
}

function reasonOf(result: BootstrapPythonResult): string {
  if (result.status === "missing" || result.status === "invalid_override") {
    return result.reason;
  }
  if (result.status === "error") return result.reason;
  return "";
}

export function createPythonRequiredSetupOwner(deps: PythonRequiredDeps) {
  let state: PythonRequiredState = emptyState();
  const subscribers = new Set<() => void>();

  const emit = () => {
    for (const listener of [...subscribers]) listener();
  };

  const setState = (next: PythonRequiredState) => {
    state = next;
    emit();
  };

  const clearToClosed = () => {
    setState({ pending: null, result: null, dialogOpen: false, choiceError: null, busy: false });
  };

  return {
    getState: () => state,

    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    /** Store a Python-blocked setup and open the dialog. Replaces any pending action. */
    requirePython: (
      routeId: string,
      result: BootstrapPythonResult,
      run: () => Promise<unknown>,
    ): boolean => {
      if (!isPythonRequiredResult(result)) return false;
      setState({
        pending: { routeId, run },
        result,
        dialogOpen: true,
        choiceError: null,
        busy: false,
      });
      return true;
    },

    /** Cancel without creating an environment or changing package state. */
    cancel: () => {
      if (!state.dialogOpen && !state.pending) return;
      clearToClosed();
    },

    /** Validate a chosen executable, save it, then retry the pending setup once. */
    choosePython: async (chosenPath: string): Promise<void> => {
      const current = state;
      if (!current.dialogOpen || !current.pending || !current.result || current.busy) return;
      setState({ ...current, busy: true, choiceError: null });
      let validated: BootstrapPythonResult;
      try {
        validated = await deps.resolveBootstrap(current.pending.routeId, chosenPath);
      } catch (error) {
        setState({ ...current, busy: false, choiceError: String(error) });
        return;
      }
      if (validated.status !== "available") {
        setState({ ...current, busy: false, choiceError: reasonOf(validated) });
        return;
      }
      try {
        await deps.saveOverride(chosenPath);
      } catch (error) {
        setState({ ...current, busy: false, choiceError: String(error) });
        return;
      }
      const pending = current.pending;
      clearToClosed();
      await pending.run();
    },

    /** Re-detect with the saved override, then retry once when available. */
    checkAgain: async (): Promise<void> => {
      const current = state;
      if (!current.dialogOpen || !current.pending || !current.result || current.busy) return;
      setState({ ...current, busy: true, choiceError: null });
      let redetected: BootstrapPythonResult;
      try {
        redetected = await deps.resolveBootstrap(current.pending.routeId);
      } catch (error) {
        setState({ ...current, busy: false, choiceError: String(error) });
        return;
      }
      if (redetected.status === "available") {
        const pending = current.pending;
        clearToClosed();
        await pending.run();
        return;
      }
      if (isPythonRequiredResult(redetected)) {
        setState({
          ...current,
          result: redetected,
          busy: false,
          choiceError: null,
        });
        return;
      }
      setState({ ...current, busy: false, choiceError: reasonOf(redetected) });
    },

    /** Clear a saved invalid override, then re-detect and retry once when available. */
    clearOverride: async (): Promise<void> => {
      const current = state;
      if (!current.dialogOpen || !current.pending || !current.result || current.busy) return;
      setState({ ...current, busy: true, choiceError: null });
      try {
        await deps.saveOverride(null);
      } catch (error) {
        setState({ ...current, busy: false, choiceError: String(error) });
        return;
      }
      let redetected: BootstrapPythonResult;
      try {
        redetected = await deps.resolveBootstrap(current.pending.routeId);
      } catch (error) {
        setState({ ...current, busy: false, choiceError: String(error) });
        return;
      }
      if (redetected.status === "available") {
        const pending = current.pending;
        clearToClosed();
        await pending.run();
        return;
      }
      if (isPythonRequiredResult(redetected)) {
        setState({
          ...current,
          result: redetected,
          busy: false,
          choiceError: null,
        });
        return;
      }
      setState({ ...current, busy: false, choiceError: reasonOf(redetected) });
    },
  };
}

export type PythonRequiredSetupOwner = ReturnType<typeof createPythonRequiredSetupOwner>;
