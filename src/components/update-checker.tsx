import { useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  AlertCircle,
  CheckCircle,
  Download,
  RefreshCw,
} from "lucide-react";

type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export function UpdateChecker() {
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const resetRef = useRef<number | null>(null);

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

  const checkForUpdates = async () => {
    clearReset();
    setState("checking");
    setError("");

    try {
      const update = await check();

      if (update) {
        setVersion(update.version);
        setProgress(0);
        setState("available");
      } else {
        setState("up-to-date");
        scheduleReset(3000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to check for updates");
      setState("error");
      scheduleReset(5000);
    }
  };

  const downloadAndInstall = async () => {
    clearReset();
    setState("downloading");
    setError("");
    setProgress(0);

    try {
      const update = await check();

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
    }
  };

  if (state === "idle") {
    return (
      <button
        onClick={checkForUpdates}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        title="Check for updates"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Updates
      </button>
    );
  }

  if (state === "checking") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Checking...
      </span>
    );
  }

  if (state === "up-to-date") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-green-600">
        <CheckCircle className="h-3.5 w-3.5" />
        Up to date
      </span>
    );
  }

  if (state === "available") {
    return (
      <button
        onClick={downloadAndInstall}
        className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
      >
        <Download className="h-3.5 w-3.5" />
        Update to {version}
      </button>
    );
  }

  if (state === "downloading") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Downloading... {progress}%
      </span>
    );
  }

  if (state === "ready") {
    return (
      <button
        onClick={() => relaunch()}
        className="flex items-center gap-1.5 text-xs font-medium text-green-600 hover:text-green-700"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Restart to update
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-red-500" title={error}>
      <AlertCircle className="h-3.5 w-3.5" />
      Update failed
    </span>
  );
}
