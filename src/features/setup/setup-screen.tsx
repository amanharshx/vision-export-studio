import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppIcon } from "@/components/app-icon";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { detectEnvironment } from "@/lib/tauri/environment";
import { captureAnalyticsEvent } from "@/lib/analytics";
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

type SetupPhase = "idle" | "venv" | "pip" | "verify" | "done" | "error";

interface SetupScreenProps {
  defaultRuntimeDir: string;
  onComplete: () => void;
}

function verifyEnvironmentReadyMessage() {
  return "runtime verification failed after install; retry setup";
}

function captureSetupFailed(failureStage: string, failureKind: string) {
  captureAnalyticsEvent("setup_failed", {
    setup_phase: failureStage,
    failure_stage: failureStage,
    failure_kind: failureKind,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SetupScreen({ defaultRuntimeDir, onComplete }: SetupScreenProps) {
  const [phase, setPhase] = useState<SetupPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const startedRef = useRef(false);

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

  async function runSetup() {
    if (!mountedRef.current) return;
    if (defaultRuntimeDir.trim().length === 0) {
      captureSetupFailed("preflight", "missing_runtime_dir");
      setPhase("error");
      setErrorMessage("managed runtime path missing");
      return;
    }
    captureAnalyticsEvent("setup_started", {
      setup_phase: "venv",
    });
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
      // Keep stdout/stderr listeners registered so stream events are drained even
      // when this screen does not render setup logs.
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
      venvSessionId = await createRuntimeVenv(defaultRuntimeDir);
    } catch (e: unknown) {
      cleanupVenv();
      if (!mountedRef.current) return;
      captureSetupFailed("venv", "venv_start_failed");
      setPhase("error");
      setErrorMessage(String(e));
      return;
    }

    const venvResult = await venvResultPromise;

    if (venvResult !== "ok") {
      if (!mountedRef.current) return;
      captureSetupFailed("venv", "venv_create_failed");
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
      // Keep stdout/stderr listeners registered so stream events are drained even
      // when this screen does not render setup logs.
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
      pipSessionId = await installUltralytics(defaultRuntimeDir);
    } catch (e: unknown) {
      cleanupPip();
      if (!mountedRef.current) return;
      captureSetupFailed("pip", "pip_install_start_failed");
      setPhase("error");
      setErrorMessage(String(e));
      return;
    }

    const pipResult = await pipResultPromise;

    if (pipResult !== "ok") {
      if (!mountedRef.current) return;
      captureSetupFailed("pip", "pip_install_failed");
      setPhase("error");
      setErrorMessage(`ultralytics install failed: ${pipResult}`);
      return;
    }

    // ------------------------------------------------------------------
    // Step 3: mark complete
    // ------------------------------------------------------------------
    try {
      await markSetupComplete(defaultRuntimeDir);
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      captureSetupFailed("save_settings", "settings_save_failed");
      setPhase("error");
      setErrorMessage(`failed to save settings: ${String(e)}`);
      return;
    }

    // ------------------------------------------------------------------
    // Step 4: verify environment is actually ready before redirect
    // ------------------------------------------------------------------
    if (!mountedRef.current) return;
    setPhase("verify");

    try {
      const envInfo = await detectEnvironment();
      if (!envInfo.python_path || !envInfo.ultralytics_version || !envInfo.yolo_path) {
        throw new Error(verifyEnvironmentReadyMessage());
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      captureSetupFailed("verify", "environment_verify_failed");
      setPhase("error");
      setErrorMessage(`environment verify failed: ${String(e)}`);
      return;
    }

    if (!mountedRef.current) return;
    captureAnalyticsEvent("setup_completed", {
      setup_phase: "done",
    });
    setPhase("done");
    setCountdown(3);
  }

  useEffect(() => {
    if (startedRef.current) return;
    if (defaultRuntimeDir.trim().length === 0) return;
    startedRef.current = true;
    runSetup().catch((e: unknown) => {
      captureSetupFailed("run_setup", "unexpected_setup_error");
      setPhase("error");
      setErrorMessage(String(e));
      startedRef.current = false;
    });
  }, [defaultRuntimeDir]);

  const isRunning = phase === "venv" || phase === "pip";
  const managedVenvPath = defaultRuntimeDir.trim()
    ? `${defaultRuntimeDir}/.venv`
    : "~/.yolo-export-studio/.venv";

  const phaseLabel: Record<SetupPhase, string> = {
    idle: "Preparing managed runtime...",
    venv: "Creating Python virtual environment...",
    pip: "Installing ultralytics...",
    verify: "Verifying managed runtime...",
    done: "Setup complete.",
    error: "Setup failed.",
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-lg space-y-8">
        {/* Header */}
        <div className="flex flex-col items-center gap-4">
          <AppIcon className="h-16 w-16 drop-shadow-md" />
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Set up YOLO Export Studio
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              YOLO Export Studio is preparing its managed runtime for first use.
            </p>
            <span className="mt-3 inline-block rounded-full bg-zinc-100 px-3 py-0.5 text-xs text-zinc-500">
              One-time setup · override optional later in settings
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200/80 bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Managed runtime
          </p>
          <p className="mt-2 font-mono text-sm text-zinc-800">{managedVenvPath}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            YOLO Export Studio creates this environment automatically and installs Ultralytics here.
          </p>
        </div>

        {phase === "done" && countdown !== null ? (
          <div className="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-50 py-3 text-sm font-medium text-emerald-700">
            <span>✓ Setup complete — redirecting in {countdown}…</span>
          </div>
        ) : (
          <>
            <div className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 py-3 text-sm font-medium text-zinc-700">
              <Loader2 className={`h-4 w-4 ${phase === "error" ? "" : "animate-spin"}`} />
              <span>{phaseLabel[phase]}</span>
            </div>
            {(isRunning || phase === "idle") && (
              <p className="text-center text-xs text-muted-foreground">
                This may take a few minutes on first install.
              </p>
            )}
            {phase === "error" && (
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  startedRef.current = false;
                  runSetup().catch((e: unknown) => {
                    captureSetupFailed("run_setup", "unexpected_setup_error");
                    setPhase("error");
                    setErrorMessage(String(e));
                  });
                }}
              >
                Retry setup
              </Button>
            )}
          </>
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
