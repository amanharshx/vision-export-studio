import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, RefreshCw } from "lucide-react";
import { AppIcon } from "@/components/app-icon";
import { GitHubLogomark } from "@/components/github-logomark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UpdaterController } from "./use-updater-controller";

const repository = "github.com/amanharshx/vision-export-studio";
const repositoryUrl = `https://${repository}`;

export function AboutButton({
  onClick,
  updateAvailable = false,
}: {
  onClick: () => void;
  updateAvailable?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      title="About Vision Export Studio"
    >
      About
      {updateAvailable ? (
        <span
          className="absolute -right-1.5 -top-1 size-2 rounded-full bg-blue-500 ring-2 ring-white"
          aria-label="Update available"
        />
      ) : null}
    </button>
  );
}

export function AboutDialog({
  open,
  updatesEnabled,
  updater,
  onOpenChange,
}: {
  open: boolean;
  updatesEnabled: boolean;
  updater: UpdaterController;
  onOpenChange: (open: boolean) => void;
}) {
  const checkForUpdates = () => {
    onOpenChange(false);
    void updater.checkForUpdates();
  };
  // Build-time constant from package.json; read at render so test setups
  // that define it can observe it. The controller no longer carries the
  // installed version over IPC.
  const installedVersion = typeof __APP_VERSION__ === "undefined" ? "" : __APP_VERSION__;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>About</DialogTitle>
          <DialogDescription>About Vision Export Studio and application updates.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center py-3 text-center">
          <AppIcon className="size-14 drop-shadow-sm" />
          <div className="mt-3 flex items-center gap-2">
            <h2 className="text-xl font-semibold">Vision Export Studio</h2>
            <button
              type="button"
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                updater.state === "available"
                  ? "bg-amber-50 text-amber-700"
                  : "bg-green-50 text-green-600"
              }`}
              title={updatesEnabled ? "Check for updates" : undefined}
              onClick={updatesEnabled ? checkForUpdates : undefined}
              disabled={!updatesEnabled}
            >
              {installedVersion || "—"}
            </button>
          </div>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Local export for Ultralytics YOLO and Roboflow RF-DETR. Fast, private, and entirely on
            your machine.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-xl border p-4">
          <GitHubLogomark className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Open source</p>
            <p className="truncate text-sm text-muted-foreground">MIT · {repository}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void invoke("open_url", { url: repositoryUrl })}
          >
            View repository
            <ExternalLink />
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4">
          {updater.buildDate ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs">
              <dt className="text-muted-foreground">Built</dt>
              <dd>{updater.buildDate}</dd>
            </dl>
          ) : (
            <span />
          )}
          {updatesEnabled ? (
            <Button variant="outline" size="sm" onClick={checkForUpdates}>
              <RefreshCw />
              Check for Updates
            </Button>
          ) : null}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
