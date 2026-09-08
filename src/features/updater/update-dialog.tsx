import type { ReactNode } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  formatReleaseDate,
  type UpdaterController,
} from "./use-updater-controller";

export function UpdateDialog({
  open,
  updater,
  onOpenChange,
}: {
  open: boolean;
  updater: UpdaterController;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, version, releaseDate, releaseNotes, progress, error } = updater;
  const blocking = state === "checking" || state === "installing";
  const formattedDate = formatReleaseDate(releaseDate);

  // One branch per dialog state; each state owns its description, body, and
  // footer together so a state can never show another state's copy.
  let description: string | null = null;
  let body: ReactNode = null;
  let footer: ReactNode = null;
  switch (state) {
    case "checking":
      description = "Checking for updates…";
      body = (
        <div className="flex justify-center py-6">
          <RefreshCw
            className="h-5 w-5 animate-spin text-muted-foreground"
            aria-label="Checking for updates"
          />
        </div>
      );
      break;
    case "available":
      description = `Version ${version} is available. Download begins only after you choose Install and restart.`;
      body = (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="truncate font-mono">{version || "—"}</dd>
            {formattedDate ? (
              <>
                <dt className="text-muted-foreground">Released</dt>
                <dd className="truncate">{formattedDate}</dd>
              </>
            ) : null}
          </dl>
          {releaseNotes ? (
            <div
              className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words"
              aria-label="Release notes"
            >
              {releaseNotes}
            </div>
          ) : null}
        </div>
      );
      footer = (
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button onClick={() => void updater.installUpdate()}>Install and restart</Button>
        </DialogFooter>
      );
      break;
    case "installing":
      description = "Downloading and installing…";
      body = (
        <div className="space-y-3 py-2">
          {progress !== null ? (
            <div className="space-y-2">
              <Progress value={progress} aria-label={`Downloading update ${progress}%`} />
              <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
                Downloading… {progress}%
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">Downloading…</span>
            </div>
          )}
        </div>
      );
      break;
    case "up-to-date":
      description = "The installed version is current. You're up to date.";
      body = (
        <div className="flex items-center gap-2 py-2">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
          <p className="text-sm">The installed version is current.</p>
        </div>
      );
      footer = (
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      );
      break;
    case "error":
      description = `Update failed: ${error}`;
      body = (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
          <p className="text-sm break-words">{error}</p>
        </div>
      );
      footer = (
        <DialogFooter>
          <Button onClick={() => void updater.checkForUpdates()}>Try again</Button>
        </DialogFooter>
      );
      break;
    default:
      break;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        showCloseButton={!blocking}
        onEscapeKeyDown={(event) => {
          if (blocking) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (blocking) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (blocking) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Updates</DialogTitle>
          <DialogDescription aria-live="polite">{description}</DialogDescription>
        </DialogHeader>

        {body}

        {footer}
      </DialogContent>
    </Dialog>
  );
}
