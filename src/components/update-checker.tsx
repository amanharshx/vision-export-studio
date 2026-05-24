import { AlertCircle, CheckCircle, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

type UpdateState = "idle" | "checking" | "up-to-date" | "error";

export function UpdateChecker() {
  const [state, setState] = useState<UpdateState>("idle");
  const resetRef = useRef<number | null>(null);

  const scheduleReset = (ms: number) => {
    if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    resetRef.current = window.setTimeout(() => setState("idle"), ms);
  };

  const handleClick = () => {
    if (state !== "idle") return;
    setState("checking");
    // Stub: no updater plugin wired yet — always resolves to up-to-date
    window.setTimeout(() => {
      setState("up-to-date");
      scheduleReset(3000);
    }, 1200);
  };

  if (state === "idle") {
    return (
      <button
        onClick={handleClick}
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
        Checking…
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

  return (
    <span className="flex items-center gap-1.5 text-xs text-red-500">
      <AlertCircle className="h-3.5 w-3.5" />
      Update failed
    </span>
  );
}
