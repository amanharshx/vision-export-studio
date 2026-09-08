import { useCallback, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

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

function captureRelease(update: {
  version?: string | null;
  date?: string | null;
  body?: string | null;
}): ReleaseSnapshot {
  return {
    version: update.version ?? "",
    date: update.date ?? "",
    notes: update.body ?? "",
  };
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
  const updateRef = useRef<Update | null>(null);

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

  const setDialogOpen = useCallback(
    (open: boolean) => {
      if (!open && (stateRef.current === "checking" || stateRef.current === "installing")) {
        return;
      }
      setDialogOpenState(open);
    },
    [],
  );

  const checkForUpdates = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;

      if (silent) {
        // Never disturb a user-visible operation or the dialog.
        if (operationRef.current !== "idle") return;
        const requestId = ++requestRef.current;
        try {
          const update = await check();
          if (requestId !== requestRef.current) return;
          if (update) {
            updateRef.current = update;
            setRelease(captureRelease(update));
            setError("");
            syncState("available");
          } else {
            updateRef.current = null;
            clearRelease();
            setError("");
            syncState("idle");
          }
        } catch {
          if (requestId !== requestRef.current) return;
          updateRef.current = null;
          setError("");
          syncState("idle");
        }
        return;
      }

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
        const update = await check();
        if (requestId !== requestRef.current) return;

        if (update) {
          updateRef.current = update;
          setRelease(captureRelease(update));
          setError("");
          syncState("available");
        } else {
          updateRef.current = null;
          clearRelease();
          syncState("up-to-date");
        }
      } catch (e) {
        if (requestId !== requestRef.current) return;
        updateRef.current = null;
        const message = e instanceof Error ? e.message : "Failed to check for updates";
        setError(message);
        syncState("error");
      } finally {
        if (requestRef.current === requestId) operationRef.current = "idle";
      }
    },
    [syncState, setRelease, clearRelease],
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

    try {
      const update = updateRef.current;
      if (!update) {
        throw new Error("No update available to install");
      }

      let downloaded = 0;
      let contentLength = 0;
      let sawContentLength = false;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          sawContentLength = contentLength > 0;
          downloaded = 0;
          setProgress(sawContentLength ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (sawContentLength && contentLength > 0) {
            setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          } else {
            setProgress(null);
          }
        }
      });

      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to install update");
      syncState("error");
    } finally {
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
