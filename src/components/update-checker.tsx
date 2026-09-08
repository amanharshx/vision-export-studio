import type { ReactNode } from "react";
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
  const { state, version, progress, error, checkForUpdates } = updater;

  const handleClick = () => {
    void checkForUpdates();
  };

  let icon: ReactNode;
  let label: string;
  let className: string;
  let title: string;
  switch (state) {
    case "available":
      icon = <Download className="h-3.5 w-3.5" />;
      label = version ? `Update to ${version}` : "Update available";
      className = "text-xs font-medium text-blue-600 hover:text-blue-700";
      title = "Check for updates";
      break;
    case "checking":
      icon = <RefreshCw className="h-3.5 w-3.5 animate-spin" />;
      label = "Checking...";
      className = "text-xs text-muted-foreground transition-colors hover:text-foreground";
      title = "Checking for updates";
      break;
    case "installing":
      icon = <RefreshCw className="h-3.5 w-3.5 animate-spin" />;
      label = progress !== null ? `Downloading... ${progress}%` : "Downloading...";
      className = "text-xs text-muted-foreground transition-colors hover:text-foreground";
      title = "Downloading and installing update";
      break;
    case "up-to-date":
      icon = <CheckCircle className="h-3.5 w-3.5" />;
      label = "Up to date";
      className = "text-xs text-green-600 transition-colors hover:text-green-700";
      title = "Check for updates";
      break;
    case "error":
      icon = <AlertCircle className="h-3.5 w-3.5" />;
      label = "Update failed";
      className = "text-xs text-red-500 transition-colors hover:text-red-600";
      title = error || "Check for updates";
      break;
    default:
      icon = <RefreshCw className="h-3.5 w-3.5" />;
      label = "Updates";
      className = "text-xs text-muted-foreground transition-colors hover:text-foreground";
      title = "Check for updates";
      break;
  }

  return (
    <button
      onClick={handleClick}
      className={`flex items-center gap-1.5 ${className}`}
      title={title}
    >
      {icon}
      {label}
    </button>
  );
}
