import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  BootstrapIncompatible,
  PythonRequiredResult,
} from "@/lib/tauri/bootstrap-python";

export const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";

function IncompatibleList({ entries }: { entries: BootstrapIncompatible[] }) {
  if (entries.length === 0) return null;
  const visible = entries.slice(0, 3);
  const hiddenCount = Math.max(0, entries.length - visible.length);
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        Found but incompatible
      </p>
      <ul className="mt-1 space-y-1">
        {visible.map((entry) => (
          <li
            key={`${entry.source}:${entry.python_path}:${entry.version}`}
            className="flex min-w-0 items-center gap-2 text-xs text-zinc-600"
          >
            <span className="shrink-0 font-mono">Python {entry.version}</span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400"
              title={entry.python_path}
            >
              {entry.python_path}
            </span>
            <span className="shrink-0 text-[11px] text-zinc-400">{entry.source}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <p className="mt-1 text-[11px] text-zinc-400">and {hiddenCount} more</p>
      )}
    </div>
  );
}

// Exported separately: Radix portals render nothing in SSR; this keeps the dialog body testable.
export function PythonRequiredDialogBody({
  routeId,
  result,
  choiceError,
  busy,
  showClearOverride,
  onCancel,
  onChoosePython,
  onCheckAgain,
  onClearOverride,
}: {
  routeId: string;
  result: PythonRequiredResult;
  choiceError: string | null;
  busy: boolean;
  showClearOverride: boolean;
  onCancel: () => void;
  onChoosePython: () => void;
  onCheckAgain: () => void;
  onClearOverride: () => void;
}) {
  const reason = choiceError?.trim() ? choiceError.trim() : result.reason;
  const title =
    result.status === "invalid_override" ? "Python override needs attention" : "Python required";
  const invalidPath =
    result.status === "invalid_override" ? result.python_path : null;
  const incompatible =
    result.status === "missing" ? result.incompatible : [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="space-y-2">
          <p>
            Setup for <span className="font-mono">{routeId}</span> needs{" "}
            <span className="font-medium text-foreground">{result.requirement}</span>.
          </p>
          <p>{reason}</p>
          <p>
            Choose a compatible Python, check again after installing one, or
            cancel. Vision Export Studio never downloads Python automatically.{" "}
            <a href={PYTHON_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              Get Python from python.org
            </a>
            .
          </p>
        </DialogDescription>
      </DialogHeader>
      {invalidPath && (
        <p
          className="truncate rounded-md border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-[11px] text-amber-900"
          title={invalidPath}
        >
          {invalidPath}
        </p>
      )}
      <IncompatibleList entries={incompatible} />
      {choiceError?.trim() && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {choiceError.trim()}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {showClearOverride && (
          <Button variant="outline" onClick={onClearOverride} disabled={busy}>
            Clear override
          </Button>
        )}
        <Button variant="outline" onClick={onCheckAgain} disabled={busy}>
          {busy ? "Checking…" : "Check again"}
        </Button>
        <Button onClick={onChoosePython} disabled={busy}>
          Choose Python
        </Button>
      </DialogFooter>
    </>
  );
}

export function PythonRequiredDialog({
  open,
  onOpenChange,
  ...bodyProps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<Parameters<typeof PythonRequiredDialogBody>[0], "onCancel"> & {
    onCancel: () => void;
  }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <PythonRequiredDialogBody {...bodyProps} />
      </DialogContent>
    </Dialog>
  );
}
