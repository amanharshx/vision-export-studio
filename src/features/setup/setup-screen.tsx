import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Box, FolderOpen, Loader2 } from "lucide-react";
import {
  createRuntimeVenv,
  installUltralytics,
  markSetupComplete,
} from "@/lib/tauri/setup";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SetupLinePayload {
  session_id: string;
  line: string;
}

interface SetupFinishedPayload {
  session_id: string;
}

interface SetupFailedPayload {
  session_id: string;
  error: string;
}

type SetupPhase = "idle" | "venv" | "pip" | "done" | "error";

interface SetupScreenProps {
  defaultRuntimeDir: string;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SetupScreen({ defaultRuntimeDir, onComplete }: SetupScreenProps) {
  const [runtimeDir, setRuntimeDir] = useState(defaultRuntimeDir);
  const [phase, setPhase] = useState<SetupPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Countdown → auto-redirect after setup completes.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) { onComplete(); return; }
    const t = setTimeout(() => setCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [countdown, onComplete]);


  async function browseDirPicker() {
    const result = await open({ directory: true, multiple: false });
    if (typeof result === "string" && result.length > 0) {
      setRuntimeDir(result);
    }
  }

  async function runSetup() {
    if (!mountedRef.current) return;
    setErrorMessage(null);
    setPhase("venv");

    // ------------------------------------------------------------------
    // Step 1: create venv
    // Register listeners BEFORE spawning so setup:finished cannot arrive
    // before anyone is listening. sessionId starts empty; callbacks ignore
    // events until it is set (JS assignment is synchronous after await, so
    // setup:finished can only be dispatched as a macrotask — after sessionId
    // is already set).
    // ------------------------------------------------------------------
    let venvSessionId = "";
    let venvResolve!: (v: "ok" | string) => void;
    const venvResultPromise = new Promise<"ok" | string>((r) => { venvResolve = r; });

    const [unVenvOut, unVenvErr, unVenvDone, unVenvFail] = await Promise.all([
      listen<SetupLinePayload>("setup:stdout", () => {}),
      listen<SetupLinePayload>("setup:stderr", () => {}),
      listen<SetupFinishedPayload>("setup:finished", (ev) => {
        if (venvSessionId && ev.payload.session_id === venvSessionId) {
          cleanupVenv(); venvResolve("ok");
        }
      }),
      listen<SetupFailedPayload>("setup:failed", (ev) => {
        if (venvSessionId && ev.payload.session_id === venvSessionId) {
          cleanupVenv(); venvResolve(ev.payload.error);
        }
      }),
    ]);
    const cleanupVenv = () => { unVenvOut(); unVenvErr(); unVenvDone(); unVenvFail(); };

    try {
      venvSessionId = await createRuntimeVenv(runtimeDir);
    } catch (e: unknown) {
      cleanupVenv();
      if (!mountedRef.current) return;
      setPhase("error");
      setErrorMessage(String(e));
      return;
    }

    const venvResult = await venvResultPromise;

    if (venvResult !== "ok") {
      if (!mountedRef.current) return;
      setPhase("error");
      setErrorMessage(`venv creation failed: ${venvResult}`);
      return;
    }

    // ------------------------------------------------------------------
    // Step 2: install ultralytics
    // ------------------------------------------------------------------
    if (!mountedRef.current) return;
    setPhase("pip");

    let pipSessionId = "";
    let pipResolve!: (v: "ok" | string) => void;
    const pipResultPromise = new Promise<"ok" | string>((r) => { pipResolve = r; });

    const [unPipOut, unPipErr, unPipDone, unPipFail] = await Promise.all([
      listen<SetupLinePayload>("setup:stdout", () => {}),
      listen<SetupLinePayload>("setup:stderr", () => {}),
      listen<SetupFinishedPayload>("setup:finished", (ev) => {
        if (pipSessionId && ev.payload.session_id === pipSessionId) {
          cleanupPip(); pipResolve("ok");
        }
      }),
      listen<SetupFailedPayload>("setup:failed", (ev) => {
        if (pipSessionId && ev.payload.session_id === pipSessionId) {
          cleanupPip(); pipResolve(ev.payload.error);
        }
      }),
    ]);
    const cleanupPip = () => { unPipOut(); unPipErr(); unPipDone(); unPipFail(); };

    try {
      pipSessionId = await installUltralytics(runtimeDir);
    } catch (e: unknown) {
      cleanupPip();
      if (!mountedRef.current) return;
      setPhase("error");
      setErrorMessage(String(e));
      return;
    }

    const pipResult = await pipResultPromise;

    if (pipResult !== "ok") {
      if (!mountedRef.current) return;
      setPhase("error");
      setErrorMessage(`ultralytics install failed: ${pipResult}`);
      return;
    }

    // ------------------------------------------------------------------
    // Step 3: mark complete
    // ------------------------------------------------------------------
    try {
      await markSetupComplete(runtimeDir);
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      setPhase("error");
      setErrorMessage(`failed to save settings: ${String(e)}`);
      return;
    }

    if (!mountedRef.current) return;
    setPhase("done");
    setCountdown(3);
  }

  const isRunning = phase === "venv" || phase === "pip";

  const phaseLabel: Record<SetupPhase, string> = {
    idle: "",
    venv: "Creating Python virtual environment...",
    pip: "Installing ultralytics...",
    done: "Setup complete.",
    error: "Setup failed.",
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-lg space-y-8">
        {/* Header */}
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary shadow-lg">
            <Box className="h-8 w-8 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Set up YOLO Export Studio
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose where YOLO Export Studio will install Python packages.
            </p>
            <span className="mt-3 inline-block rounded-full bg-zinc-100 px-3 py-0.5 text-xs text-zinc-500">
              One-time setup · can be changed later in settings
            </span>
          </div>
        </div>

        {/* Directory picker */}
        <div className="space-y-2">
          <Label htmlFor="runtime-dir">Runtime directory</Label>
          <div className="flex gap-2">
            <Input
              id="runtime-dir"
              value={runtimeDir}
              onChange={(e) => setRuntimeDir(e.target.value)}
              disabled={isRunning}
              placeholder="/path/to/runtime"
              className="flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={browseDirPicker}
              disabled={isRunning}
              aria-label="Browse for directory"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A <code>.venv</code> folder will be created here.
          </p>
        </div>

        {/* Set Up button / countdown */}
        {phase === "done" && countdown !== null ? (
          <div className="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-50 py-3 text-sm font-medium text-emerald-700">
            <span>✓ Setup complete — redirecting in {countdown}…</span>
          </div>
        ) : (
          <Button
            type="button"
            className={`w-full${isRunning ? " animate-glow-pulse" : ""}`}
            onClick={runSetup}
            disabled={isRunning || runtimeDir.trim().length === 0}
          >
            {isRunning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {phaseLabel[phase]}
              </>
            ) : phase === "error" ? (
              "Retry"
            ) : (
              "Set Up"
            )}
          </Button>
          {isRunning && (
            <p className="text-center text-xs text-muted-foreground">
              This may take a few minutes on first install.
            </p>
          )}
        )}


        {/* Error message */}
        {phase === "error" && errorMessage && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}
