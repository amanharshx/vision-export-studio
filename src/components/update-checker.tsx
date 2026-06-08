import {
  AlertCircle,
  CheckCircle,
  Download,
  RefreshCw,
} from "lucide-react";
import type { UpdaterController } from "@/features/updater/use-updater-controller";

export function UpdateChecker({
  updater,
}: {
  updater: UpdaterController;
}) {
  const {
    state,
    version,
    progress,
    error,
    checkForUpdates,
    beginInstall,
    restartToUpdate,
  } = updater;

  if (state === "idle") {
    return (
      <button
        onClick={() => void checkForUpdates()}
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
        onClick={() => void beginInstall()}
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
        onClick={() => void restartToUpdate()}
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
