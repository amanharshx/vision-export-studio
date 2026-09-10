import { lazy, Suspense, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
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

const ReleaseNotes = lazy(() =>
  import("./release-notes").then((module) => ({ default: module.ReleaseNotes })),
);

function ReleaseDetails({
  version,
  releaseDate,
  releaseNotes,
  buildDate,
}: {
  version: string;
  releaseDate: string;
  releaseNotes: string;
  buildDate: string;
}) {
  const formattedDate = formatReleaseDate(releaseDate);
  return (
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
        {buildDate ? (
          <>
            <dt className="text-muted-foreground">Built</dt>
            <dd className="truncate">{buildDate}</dd>
          </>
        ) : null}
      </dl>
      {releaseNotes ? (
        <section className="max-h-72 overflow-y-auto border-t pt-3 text-sm">
          <Suspense
            fallback={
              <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            }
          >
            <ReleaseNotes source={releaseNotes} />
          </Suspense>
        </section>
      ) : null}
    </div>
  );
}

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
  // Build-time constant from package.json; read at render so test setups
  // that define it can observe it. The controller no longer carries the
  // installed version over IPC.
  const installedVersion = typeof __APP_VERSION__ === "undefined" ? "" : __APP_VERSION__;
  const blocking = state === "checking" || state === "installing";

  // One branch per dialog state; each state owns its description, body, and
  // footer together so a state can never show another state's copy.
  let description: string | null = null;
  let body: ReactNode = null;
  let footer: ReactNode = null;
  switch (state) {
    case "checking":
      description = "Checking GitHub for the latest release…";
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
      description = `Vision Export Studio ${version} is ready to install. The app will restart automatically.`;
      body = (
        <ReleaseDetails
          version={version}
          releaseDate={releaseDate}
          releaseNotes={releaseNotes}
          buildDate={updater.buildDate}
        />
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
      description = "Downloading and installing the update…";
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
      description = "You have the latest version of Vision Export Studio.";
      body = (
        <ReleaseDetails
          version={installedVersion}
          releaseDate={releaseDate}
          releaseNotes={releaseNotes}
          buildDate={updater.buildDate}
        />
      );
      footer = (
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      );
      break;
    case "error":
      description = `Update failed: ${error}`;
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
          <DialogTitle>Vision Export Studio updates</DialogTitle>
          <DialogDescription aria-live="polite">{description}</DialogDescription>
        </DialogHeader>

        {body}

        {footer}
      </DialogContent>
    </Dialog>
  );
}
