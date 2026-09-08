import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "installing"
  | "up-to-date"
  | "error";

export interface UpdaterController {
  state: UpdateState;
  dialogOpen: boolean;
  version: string;
  releaseDate: string;
  releaseNotes: string;
  progress: number | null;
  error: string;
  checkForUpdates: (opts?: { silent?: boolean }) => Promise<void>;
  installUpdate: () => Promise<void>;
  setDialogOpen: (open: boolean) => void;
}

export function formatReleaseDate(raw: string): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type ReleaseSnapshot = { version: string; date: string; notes: string };

interface BackendUpdateInfo {
  available: boolean;
  version: string;
  date: string;
  notes: string;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

export function useUpdaterController(): UpdaterController {
  const [state, setState] = useState<UpdateState>("idle");
  const [dialogOpen, setDialogOpenState] = useState(false);
  const [version, setVersion] = useState("");
  const [releaseDate, setReleaseDate] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  // Tracks only user-visible operations. A silent startup check never owns
  // this: it must neither block a manual check nor ever touch the dialog.
  const operationRef = useRef<"idle" | "manual" | "installing">("idle");
  // Monotonic request id so a stale silent result can never overwrite a
  // newer manual one (or close a dialog the user opened mid-flight).
  const requestRef = useRef(0);
  const stateRef = useRef<UpdateState>("idle");

  const syncState = useCallback((next: UpdateState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const setRelease = useCallback((next: { version: string; date: string; notes: string }) => {
    setVersion(next.version);
    setReleaseDate(next.date);
    setReleaseNotes(next.notes);
  }, []);

  const clearRelease = useCallback(() => {
    setVersion("");
    setReleaseDate("");
    setReleaseNotes("");
  }, []);

  const setDialogOpen = useCallback((open: boolean) => {
    if (!open && (stateRef.current === "checking" || stateRef.current === "installing")) {
      return;
    }
    setDialogOpenState(open);
  }, []);

  const rememberRelease = useCallback(
    (info: BackendUpdateInfo) => {
      setRelease({ version: info.version ?? "", date: info.date ?? "", notes: info.notes ?? "" });
    },
    [setRelease],
  );

  const runSilentCheck = useCallback(async () => {
    // Never disturb a user-visible operation or the dialog.
    if (operationRef.current !== "idle") return;
    const requestId = ++requestRef.current;
    try {
      const info = await invoke<BackendUpdateInfo | null>("check_update");
      if (requestId !== requestRef.current) return;
      if (info?.available) {
        rememberRelease(info);
        setError("");
        syncState("available");
      } else {
        clearRelease();
        setError("");
        syncState("idle");
      }
    } catch {
      if (requestId !== requestRef.current) return;
      clearRelease();
      setError("");
      syncState("idle");
    }
  }, [rememberRelease, clearRelease, syncState]);

  const runManualCheck = useCallback(async () => {
    if (operationRef.current === "manual" || operationRef.current === "installing") {
      setDialogOpenState(true);
      return;
    }
    operationRef.current = "manual";
    const requestId = ++requestRef.current;

    setDialogOpenState(true);
    syncState("checking");
    setError("");
    setProgress(null);
    clearRelease();

    try {
      const info = await invoke<BackendUpdateInfo | null>("check_update");
      if (requestId !== requestRef.current) return;

      if (info?.available) {
        rememberRelease(info);
        setError("");
        syncState("available");
      } else if (info) {
        rememberRelease(info);
        setError("");
        syncState("up-to-date");
      } else {
        clearRelease();
        setError("");
        syncState("up-to-date");
      }
    } catch (e) {
      if (requestId !== requestRef.current) return;
      clearRelease();
      setError(errorMessage(e, "Failed to check for updates"));
      syncState("error");
    } finally {
      if (requestRef.current === requestId) operationRef.current = "idle";
    }
  }, [rememberRelease, clearRelease, syncState]);

  const checkForUpdates = useCallback(
    (opts?: { silent?: boolean }) => (opts?.silent ? runSilentCheck() : runManualCheck()),
    [runSilentCheck, runManualCheck],
  );

  const installUpdate = useCallback(async () => {
    if (operationRef.current === "manual" || operationRef.current === "installing") return;
    if (stateRef.current !== "available") return;

    operationRef.current = "installing";
    // Invalidate any in-flight silent check so it can never overwrite this flow.
    ++requestRef.current;
    setDialogOpenState(true);
    syncState("installing");
    setError("");
    setProgress(null);

    let stopListening: (() => void) | undefined;
    try {
      try {
        stopListening = await listen<number>("update-progress", (event) => {
          const percent = event.payload;
          if (typeof percent === "number" && Number.isFinite(percent)) {
            setProgress(Math.min(100, Math.max(0, Math.round(percent))));
          }
        });
      } catch {
        stopListening = undefined;
      }
      await invoke("install_update");
    } catch (e) {
      setError(errorMessage(e, "Failed to install the update"));
      syncState("error");
    } finally {
      try {
        stopListening?.();
      } catch {
        // Releasing the progress listener must never mask the install result.
      }
      operationRef.current = "idle";
    }
  }, [syncState]);

  return {
    state,
    dialogOpen,
    version,
    releaseDate,
    releaseNotes,
    progress,
    error,
    checkForUpdates,
    installUpdate,
    setDialogOpen,
  };
}
