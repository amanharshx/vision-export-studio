import { Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatSetupTaskScope,
  isSetupTaskVisible,
  setupTaskPhaseLabel,
  type SetupTask,
} from "./setup-task";

// Exported separately: Radix portals render nothing in SSR; this keeps the dialog body testable.
export function SetupActivityDetailsBody({
  task,
  onDismiss,
}: {
  task: SetupTask;
  onDismiss: () => void;
}) {
  const isActive = task.status === "active";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Setup details</DialogTitle>
        <DialogDescription>
          {formatSetupTaskScope(task)} · {setupTaskPhaseLabel(task.phase)}
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm text-zinc-700">{task.summary}</p>
      {task.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {task.error}
        </p>
      )}
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
        {task.logs.length > 0 ? task.logs.join("\n") : "No setup output yet."}
      </div>
      <DialogFooter showCloseButton>
        {!isActive && (
          <Button variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

export function SetupActivityBar({
  task,
  onOpenDetails,
  onCloseDetails,
  onDismiss,
}: {
  task: SetupTask | null;
  onOpenDetails: () => void;
  onCloseDetails: () => void;
  onDismiss: () => void;
}) {
  if (!isSetupTaskVisible(task) || !task) return null;

  const isActive = task.status === "active";

  return (
    <>
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 shadow-[0_-2px_12px_rgba(0,0,0,0.06)] backdrop-blur"
      >
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-5 py-2.5">
          {isActive ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" aria-hidden="true" />
          ) : task.status === "succeeded" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-zinc-900">
              {setupTaskPhaseLabel(task.phase)} · {task.summary}
            </p>
            <p className="truncate text-[11px] text-zinc-500">
              {formatSetupTaskScope(task)}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onOpenDetails}>
            View details
          </Button>
          {!isActive && (
            <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss setup status">
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <Dialog open={task.detailsOpen} onOpenChange={(open) => (open ? onOpenDetails() : onCloseDetails())}>
        <DialogContent className="sm:max-w-lg">
          <SetupActivityDetailsBody task={task} onDismiss={onDismiss} />
        </DialogContent>
      </Dialog>
    </>
  );
}
