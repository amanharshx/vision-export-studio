import { useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export interface UpdaterController {
  state: UpdateState;
  version: string;
  progress: number;
  error: string;
  hasDismissedAnnouncementThisSession: boolean;
  checkForUpdates: (opts?: { silent?: boolean }) => Promise<void>;
  beginInstall: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  dismissAnnouncement: () => void;
}

export function useUpdaterController(): UpdaterController {
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [hasDismissedAnnouncementThisSession, setHasDismissedAnnouncementThisSession] =
    useState(false);
  const resetRef = useRef<number | null>(null);
  const updateRef = useRef<Update | null>(null);

  const clearReset = () => {
    if (resetRef.current !== null) {
      window.clearTimeout(resetRef.current);
      resetRef.current = null;
    }
  };

  const scheduleReset = (ms: number) => {
    clearReset();
    resetRef.current = window.setTimeout(() => {
      setState("idle");
      resetRef.current = null;
    }, ms);
  };

  useEffect(() => {
    return () => {
      clearReset();
    };
  }, []);

  const checkForUpdates = async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;

    clearReset();
    setError("");

    if (!silent) {
      setState("checking");
    }

    try {
      const update = await check();

      if (update) {
        updateRef.current = update;
        setVersion(update.version);
        setProgress(0);
        setState("available");
        return;
      }

      updateRef.current = null;
      setVersion("");

      if (!silent) {
        setState("up-to-date");
        scheduleReset(3000);
      } else {
        setState("idle");
      }
    } catch (e) {
      updateRef.current = null;
      setError(e instanceof Error ? e.message : "Failed to check for updates");

      if (!silent) {
        setState("error");
        scheduleReset(5000);
      } else {
        setState("idle");
      }
    }
  };

  const beginInstall = async () => {
    clearReset();
    setHasDismissedAnnouncementThisSession(true);
    setState("downloading");
    setError("");
    setProgress(0);

    try {
      const update = updateRef.current;

      if (!update) {
        setState("idle");
        return;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setProgress(Math.round((downloaded / contentLength) * 100));
          }
        }
      });

      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to download update");
      setState("error");
      scheduleReset(5000);
    }
  };

  const restartToUpdate = async () => {
    clearReset();
    setError("");

    try {
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restart app");
      setState("error");
      scheduleReset(5000);
    }
  };

  return {
    state,
    version,
    progress,
    error,
    hasDismissedAnnouncementThisSession,
    checkForUpdates,
    beginInstall,
    restartToUpdate,
    dismissAnnouncement: () => setHasDismissedAnnouncementThisSession(true),
  };
}
