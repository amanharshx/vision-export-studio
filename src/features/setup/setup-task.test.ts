// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  canDismissSetupTask,
  createSetupTask,
  createSetupTaskOwner,
  getSetupCloseWarning,
  isSetupTaskVisible,
  SETUP_CLOSE_WARNING_MESSAGE,
  SETUP_CONFLICT_MESSAGE,
  setupTaskPhaseLabel,
  setupTaskSummaryForPhase,
  type InstallStreamDeps,
  type PythonRequiredDeps,
  type RuntimeInstallRequest,
  type SetupTaskOwner,
} from "./setup-task";
import type { BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";

const request: RuntimeInstallRequest = {
  provider: "ultralytics",
  routeId: null,
  environmentKey: "ultralytics-managed",
  packages: [{ package: "ultralytics", prerelease: false }],
  pythonPath: "/tmp/python",
};

function createFakeDeps(options?: {
  sessionId?: string;
  startError?: string;
  yoloPath?: string | null;
  verifyError?: string;
}) {
  const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
  let verifyCalls = 0;
  const deps: InstallStreamDeps = {
    listenInstallEvent: async (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler as (ev: { payload: unknown }) => void);
      handlers.set(event, list);
      return () => {};
    },
    startInstall: async () => {
      if (options?.startError) throw new Error(options.startError);
      return options?.sessionId ?? "session-1";
    },
    verifyEnvironment: async () => {
      verifyCalls += 1;
      if (options?.verifyError) throw new Error(options.verifyError);
      return { yoloPath: options?.yoloPath === undefined ? "/tmp/.venv/bin/yolo" : options.yoloPath };
    },
  };
  return { deps, handlers, verifyCalls: () => verifyCalls };
}

function fire(
  handlers: Map<string, Array<(ev: { payload: unknown }) => void>>,
  event: string,
  payload: unknown,
) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

async function waitForSession(owner: SetupTaskOwner) {
  for (let i = 0; i < 20 && !owner.getState()?.sessionId; i++) {
    await Promise.resolve();
  }
  expect(owner.getState()?.sessionId).toBe("session-1");
}

describe("setup task representation", () => {
  test("carries provider, route, environment key, phase, summary, logs, and terminal result", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);

    const started = owner.getState()!;
    expect(started.provider).toBe("ultralytics");
    expect(started.routeId).toBeNull();
    expect(started.environmentKey).toBe("ultralytics-managed");
    expect(started.phase).toBe("installing-packages");
    expect(started.summary).toBe("Installing ultralytics runtime…");
    expect(started.logs).toEqual([]);
    expect(started.status).toBe("active");

    fire(handlers, "install:stdout", { session_id: "session-1", line: "Collecting ultralytics" });
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });

    const done = owner.getState()!;
    expect(done.logs).toEqual(["[stdout] Collecting ultralytics"]);
    expect(done.phase).toBe("ready");
    expect(done.status).toBe("succeeded");
    expect(done.error).toBeNull();
  });

  test("uses honest named phases without percentages", () => {
    expect(setupTaskPhaseLabel("installing-packages")).toBe("Installing packages");
    expect(setupTaskPhaseLabel("checking-environment")).toBe("Checking environment");
    expect(setupTaskPhaseLabel("ready")).toBe("Ready");
    for (const phase of [
      "finding-python",
      "creating-environment",
      "installing-packages",
      "checking-environment",
      "ready",
      "failed",
    ] as const) {
      expect(setupTaskPhaseLabel(phase)).not.toContain("%");
      expect(setupTaskSummaryForPhase(phase, "ultralytics")).not.toContain("%");
    }
  });

  test("createSetupTask defaults to the installing-packages phase", () => {
    const task = createSetupTask({
      provider: "ultralytics",
      routeId: null,
      environmentKey: "ultralytics-managed",
      pythonPath: "/tmp/python",
    });
    expect(task.phase).toBe("installing-packages");
    expect(task.status).toBe("active");
    expect(task.pythonPath).toBe("/tmp/python");
    expect(task.detailsOpen).toBe(false);
    expect(task.dismissed).toBe(false);
  });
});

describe("setup task event pipeline", () => {
  test("early events are buffered until the session is assigned", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);

    fire(handlers, "install:stdout", { session_id: "session-1", line: "early line" });
    expect(owner.getState()!.logs).toEqual([]);

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(owner.getState()!.phase).toBe("ready");
    expect(owner.getState()!.logs).toEqual(["[stdout] early line"]);
  });

  test("stale session events are ignored", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);
    await waitForSession(owner);

    fire(handlers, "install:stdout", { session_id: "stale-session", line: "old output" });
    fire(handlers, "install:failed", { session_id: "stale-session", error: "old failure" });

    const state = owner.getState()!;
    expect(state.logs).toEqual([]);
    expect(state.status).toBe("active");

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
  });

  test("install failure marks terminal failure and skips verification", async () => {
    const { deps, handlers } = createFakeDeps({ yoloPath: "/tmp/yolo" });
    let verified = 0;
    const countingDeps: InstallStreamDeps = {
      ...deps,
      verifyEnvironment: async (pythonPath) => {
        verified += 1;
        return deps.verifyEnvironment(pythonPath);
      },
    };
    const owner = createSetupTaskOwner(countingDeps);
    const promise = owner.startRuntimeInstall(request);

    fire(handlers, "install:failed", { session_id: "session-1", error: "pip exited with code 1" });
    expect(await promise).toEqual({ ok: false, error: "pip exited with code 1" });

    const failed = owner.getState()!;
    expect(failed.status).toBe("failed");
    expect(failed.phase).toBe("failed");
    expect(failed.error).toBe("pip exited with code 1");
    expect(verified).toBe(0);

    fire(handlers, "install:stdout", { session_id: "session-1", line: "late output" });
    expect(owner.getState()!.status).toBe("failed");
    expect(owner.getState()!.logs).toEqual([]);
  });

  test("missing YOLO after pip success marks failure in the owner", async () => {
    const { deps, handlers } = createFakeDeps({ yoloPath: null });
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({
      ok: false,
      error: "Ultralytics runtime install finished, but YOLO CLI was still not detected.",
    });

    const failed = owner.getState()!;
    expect(failed.status).toBe("failed");
    expect(failed.phase).toBe("failed");
    expect(failed.error).toBe(
      "Ultralytics runtime install finished, but YOLO CLI was still not detected.",
    );
  });

  test("verification throw marks failure in the owner", async () => {
    const { deps, handlers } = createFakeDeps({ verifyError: "detect crashed" });
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);

    fire(handlers, "install:finished", { session_id: "session-1" });
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    expect(owner.getState()!.status).toBe("failed");
  });

  test("an undismissed terminal result blocks replacement until acknowledged", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const first = owner.startRuntimeInstall(request);

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await first).toEqual({ ok: true });

    const refused = await owner.startRuntimeInstall(request);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("Dismiss the previous setup result");
    }
    expect(owner.getState()?.summary).toBe("ultralytics runtime ready");

    owner.dismissTask();
    const retry = owner.startRuntimeInstall(request);
    await waitForSession(owner);
    expect(owner.getState()?.status).toBe("active");
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await retry).toEqual({ ok: true });
  });

  test("a second start while active is refused and preserves the running task", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const first = owner.startRuntimeInstall(request);
    await waitForSession(owner);

    const refused = await owner.startRuntimeInstall(request);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBe(SETUP_CONFLICT_MESSAGE);
    }
    expect(owner.getState()?.sessionId).toBe("session-1");

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await first).toEqual({ ok: true });
    expect(owner.getState()?.status).toBe("succeeded");
  });
});

describe("setup task visibility and details", () => {
  test("terminal success stays visible until dismissed", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);
    expect(isSetupTaskVisible(owner.getState())).toBe(true);

    fire(handlers, "install:finished", { session_id: "session-1" });
    await promise;
    expect(isSetupTaskVisible(owner.getState())).toBe(true);

    owner.dismissTask();
    expect(isSetupTaskVisible(owner.getState())).toBe(false);
  });

  test("terminal failure stays visible until dismissed", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);

    fire(handlers, "install:failed", { session_id: "session-1", error: "boom" });
    await promise;
    expect(isSetupTaskVisible(owner.getState())).toBe(true);

    owner.dismissTask();
    expect(isSetupTaskVisible(owner.getState())).toBe(false);
  });

  test("reopening details preserves provider, route, and environment key", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);

    fire(handlers, "install:stdout", { session_id: "session-1", line: "hello" });
    fire(handlers, "install:finished", { session_id: "session-1" });
    await promise;

    owner.openDetails();
    const opened = owner.getState()!;
    expect(opened.detailsOpen).toBe(true);
    expect(opened.provider).toBe("ultralytics");
    expect(opened.routeId).toBeNull();
    expect(opened.environmentKey).toBe("ultralytics-managed");
    expect(opened.logs).toEqual(["[stdout] hello"]);

    owner.closeDetails();
    const closed = owner.getState()!;
    expect(closed.detailsOpen).toBe(false);
    expect(closed.provider).toBe("ultralytics");
    expect(closed.routeId).toBeNull();
    expect(closed.environmentKey).toBe("ultralytics-managed");
  });

  test("active tasks cannot be dismissed", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);
    await waitForSession(owner);

    owner.dismissTask();
    expect(isSetupTaskVisible(owner.getState())).toBe(true);

    fire(handlers, "install:failed", { session_id: "session-1", error: "cleanup" });
    expect(await promise).toEqual({ ok: false, error: "cleanup" });
    expect(canDismissSetupTask(owner.getState()!)).toBe(true);
  });
});

describe("safe setup navigation (ticket 04)", () => {
  test("owner holds install listeners across screen subscribe and unsubscribe", async () => {
    const { deps, handlers } = createFakeDeps({ yoloPath: "/tmp/yolo" });
    const owner = createSetupTaskOwner(deps);
    const seen: Array<string | null> = [];
    const unsubscribe = owner.subscribe(() => {
      seen.push(owner.getState()?.status ?? null);
    });
    const promise = owner.startRuntimeInstall(request);
    await waitForSession(owner);
    unsubscribe();
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(owner.getState()!.status).toBe("succeeded");
    expect(seen).toContain("active");
    const remounted: Array<string | null> = [];
    const unsubscribeRemount = owner.subscribe(() => {
      remounted.push(owner.getState()?.status ?? null);
    });
    expect(owner.getState()!.status).toBe("succeeded");
    owner.openDetails();
    expect(remounted).toEqual(["succeeded"]);
    expect(owner.getState()!.detailsOpen).toBe(true);
    unsubscribeRemount();
  });

  test("terminal task captures the stable bootstrap path", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);
    await waitForSession(owner);
    const task = owner.getState()!;
    expect(task.provider).toBe("ultralytics");
    expect(task.routeId).toBeNull();
    expect(task.environmentKey).toBe("ultralytics-managed");
    expect(task.pythonPath).toBe("/tmp/python");
    expect("sourcePath" in task).toBe(false);
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(owner.getState()!.status).toBe("succeeded");
  });

  test("close warning message shared by web and native handlers", async () => {
    expect(getSetupCloseWarning(null)).toBeNull();

    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);
    await waitForSession(owner);

    const warning = getSetupCloseWarning(owner.getState());
    expect(warning).toBe(SETUP_CLOSE_WARNING_MESSAGE);
    expect(warning).toContain("retry");
    expect(warning).toContain("restart");

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(getSetupCloseWarning(owner.getState())).toBeNull();
  });

  test("restart discards in-memory progress; incomplete comes from the environment", async () => {
    const { deps, handlers } = createFakeDeps();
    const owner = createSetupTaskOwner(deps);
    const promise = owner.startRuntimeInstall(request);
    await waitForSession(owner);
    expect(owner.getState()).not.toBeNull();

    // Fresh owner after restart holds no task.
    const restarted = createSetupTaskOwner(deps);
    expect(restarted.getState()).toBeNull();

    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
  });
});

describe("python-required pending setup (ticket 06)", () => {
  function missingResult(
    requirement = "Python 3.10 through 3.13",
  ): BootstrapPythonResult {
    return {
      status: "missing",
      requirement,
      reason: "no compatible Python 3.10 through 3.13 interpreter found",
      incompatible: [
        { source: "ultralytics-managed", python_path: "/tmp/managed/bin/python", version: "3.9.6" },
        { source: "discovered-system", python_path: "/usr/bin/python3", version: "3.14.0" },
      ],
    };
  }

  function invalidResult(reason = "Python path does not exist: /bad/python"): BootstrapPythonResult {
    return {
      status: "invalid_override",
      python_path: "/bad/python",
      source: "explicit-override",
      reason,
      version: null,
      requirement: "Python 3.10 through 3.13",
    };
  }

  function availableResult(): BootstrapPythonResult {
    return {
      status: "available",
      python_path: "/valid/python",
      source: "explicit-override",
      version: "3.12.1",
    };
  }

  function createPythonHarness(options?: {
    resolveImpl?: (routeId: string, override?: string) => Promise<BootstrapPythonResult>;
    saveImpl?: (path: string | null) => Promise<void>;
    beforeSave?: (path: string | null) => Promise<void>;
    loadImpl?: () => Promise<string | null>;
    initialOverride?: string | null;
  }) {
    const saves: Array<string | null> = [];
    let runs = 0;
    let stored: string | null = options?.initialOverride ?? null;
    const gateDeps: PythonRequiredDeps = {
      resolveBootstrap: async (routeId, override) => {
        if (options?.resolveImpl) return options.resolveImpl(routeId, override);
        return availableResult();
      },
      saveOverride: async (path) => {
        saves.push(path);
        if (options?.beforeSave) await options.beforeSave(path);
        if (options?.saveImpl) return options.saveImpl(path);
        stored = path;
      },
      loadOverride: async () => {
        if (options?.loadImpl) return options.loadImpl();
        return stored;
      },
    };
    const owner = createSetupTaskOwner(createFakeDeps().deps);
    const run = async () => {
      runs += 1;
    };
    return { owner, gateDeps, saves, stored: () => stored, runs: () => runs, run };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test("starts closed: never shown on launch without a blocked setup", () => {
    const { owner } = createPythonHarness();
    const state = owner.getPythonGate();
    expect(state.dialogOpen).toBe(false);
    expect(state.pending).toBeNull();
    expect(state.result).toBeNull();
  });

  test("valid choice saves and retries the pending setup exactly once", async () => {
    const { owner, gateDeps, saves, runs, run } = createPythonHarness();
    expect(owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run)).toBe(true);
    expect(owner.getPythonGate().dialogOpen).toBe(true);

    await owner.choosePythonForSetup(gateDeps, "/valid/python");

    expect(saves).toEqual(["/valid/python"]);
    expect(runs()).toBe(1);
    expect(owner.getPythonGate().dialogOpen).toBe(false);
    expect(owner.getPythonGate().pending).toBeNull();

    // A second choice with no pending retries nothing.
    await owner.choosePythonForSetup(gateDeps, "/valid/python");
    expect(runs()).toBe(1);
    expect(saves).toEqual(["/valid/python"]);
  });

  test("invalid choice keeps the dialog open with the exact reason", async () => {
    const reason = "provided Python failed validation: /bad/python failed validation: crashed";
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      resolveImpl: async () => invalidResult(reason),
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePythonForSetup(gateDeps, "/bad/python");

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    const state = owner.getPythonGate();
    expect(state.dialogOpen).toBe(true);
    expect(state.choiceError).toBe(reason);
    expect(state.pending).not.toBeNull();
  });

  test("incompatible version keeps the dialog open without saving", async () => {
    const reason =
      "Python 3.9.6 is not supported for ultralytics.pt.onnx; requires Python 3.10 through 3.13.";
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      resolveImpl: async () => ({
        status: "invalid_override",
        python_path: "/py39/bin/python",
        source: "explicit-override",
        reason,
        version: "3.9.6",
        requirement: "Python 3.10 through 3.13",
      }),
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePythonForSetup(gateDeps, "/py39/bin/python");

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    expect(owner.getPythonGate().dialogOpen).toBe(true);
    expect(owner.getPythonGate().choiceError).toContain("not supported");
  });

  test("cleared override redetects and retries when a compatible Python appears", async () => {
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      resolveImpl: async (_route, override) => {
        if (override !== undefined) return invalidResult();
        return availableResult();
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", invalidResult(), run);

    await owner.clearPythonGateOverride(gateDeps);

    expect(saves).toEqual([null]);
    expect(runs()).toBe(1);
    expect(owner.getPythonGate().dialogOpen).toBe(false);
  });

  test("cleared override stays open with fresh missing state when still nothing compatible", async () => {
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      resolveImpl: async () => missingResult(),
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", invalidResult(), run);

    await owner.clearPythonGateOverride(gateDeps);

    expect(saves).toEqual([null]);
    expect(runs()).toBe(0);
    const state = owner.getPythonGate();
    expect(state.dialogOpen).toBe(true);
    expect(state.result?.status).toBe("missing");
  });

  test("redetection retries once on success and updates the dialog on continued failure", async () => {
    const success = createPythonHarness();
    success.owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), success.run);
    await success.owner.checkAgainPythonGate(success.gateDeps);
    expect(success.runs()).toBe(1);
    expect(success.owner.getPythonGate().dialogOpen).toBe(false);

    const stillMissing = createPythonHarness({
      resolveImpl: async () => missingResult(),
    });
    stillMissing.owner.requirePythonForSetup(
      "ultralytics.pt.onnx",
      missingResult(),
      stillMissing.run,
    );
    await stillMissing.owner.checkAgainPythonGate(stillMissing.gateDeps);
    expect(stillMissing.runs()).toBe(0);
    expect(stillMissing.owner.getPythonGate().dialogOpen).toBe(true);
    expect(stillMissing.owner.getPythonGate().result?.status).toBe("missing");
  });

  test("cancellation creates nothing and changes no package state", async () => {
    const { owner, saves, runs, run } = createPythonHarness();
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);
    expect(owner.getPythonGate().dialogOpen).toBe(true);

    owner.cancelPythonGate();

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    const state = owner.getPythonGate();
    expect(state.dialogOpen).toBe(false);
    expect(state.pending).toBeNull();
    expect(state.result).toBeNull();
  });

  test("pending-action replacement discards the old setup without running it", async () => {
    let firstRuns = 0;
    let secondRuns = 0;
    const { owner, gateDeps, saves } = createPythonHarness();
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      firstRuns += 1;
    });
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      secondRuns += 1;
    });

    expect(owner.getPythonGate().pending?.routeId).toBe("rfdetr.pth.tflite");
    await owner.checkAgainPythonGate(gateDeps);

    expect(firstRuns).toBe(0);
    expect(secondRuns).toBe(1);
    expect(saves).toEqual([]);
  });

  test("save failure keeps the dialog open with the exact reason and no retry", async () => {
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      saveImpl: async () => {
        throw new Error("provided Python failed validation: crashed");
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePythonForSetup(gateDeps, "/valid/python");

    expect(saves).toEqual(["/valid/python"]);
    expect(runs()).toBe(0);
    expect(owner.getPythonGate().dialogOpen).toBe(true);
    expect(owner.getPythonGate().choiceError).toContain("failed validation");
  });

  test("cancel during redetection discards the stale success without running", async () => {
    const gate = deferred<BootstrapPythonResult>();
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      resolveImpl: () => gate.promise,
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    const pending = owner.checkAgainPythonGate(gateDeps);
    owner.cancelPythonGate();
    gate.resolve(availableResult());
    await pending;

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    const state = owner.getPythonGate();
    expect(state.dialogOpen).toBe(false);
    expect(state.pending).toBeNull();
  });

  test("replacement during redetection runs the new action, never the stale one", async () => {
    const gate = deferred<BootstrapPythonResult>();
    let firstRuns = 0;
    let secondRuns = 0;
    const { owner, gateDeps } = createPythonHarness({
      resolveImpl: () => gate.promise,
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      firstRuns += 1;
    });

    const stale = owner.checkAgainPythonGate(gateDeps);
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      secondRuns += 1;
    });
    gate.resolve(availableResult());
    await stale;

    expect(firstRuns).toBe(0);
    expect(secondRuns).toBe(0);
    expect(owner.getPythonGate().pending?.routeId).toBe("rfdetr.pth.tflite");
    expect(owner.getPythonGate().dialogOpen).toBe(true);
  });

  test("cancel during a validated choice runs nothing and saves nothing", async () => {
    const validation = deferred<BootstrapPythonResult>();
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      resolveImpl: () => validation.promise,
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    const pending = owner.choosePythonForSetup(gateDeps, "/valid/python");
    owner.cancelPythonGate();
    validation.resolve(availableResult());
    await pending;

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    expect(owner.getPythonGate().pending).toBeNull();
  });

  test("replacement during a validated choice never runs the stale action", async () => {
    const validation = deferred<BootstrapPythonResult>();
    let firstRuns = 0;
    const { owner, gateDeps, saves } = createPythonHarness({
      resolveImpl: () => validation.promise,
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      firstRuns += 1;
    });

    const stale = owner.choosePythonForSetup(gateDeps, "/valid/python");
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {});
    validation.resolve(availableResult());
    await stale;

    expect(firstRuns).toBe(0);
    expect(saves).toEqual([]);
    expect(owner.getPythonGate().pending?.routeId).toBe("rfdetr.pth.tflite");
  });

  test("stale picker choice for a replaced pending saves and runs nothing", async () => {
    let runsA = 0;
    let runsB = 0;
    const { owner, gateDeps, saves } = createPythonHarness();
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      runsA += 1;
    });
    const staleExpected = owner.getPythonGate().pending;
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      runsB += 1;
    });

    await owner.choosePythonForSetup(gateDeps, "/stale-pick/python", staleExpected);

    expect(saves).toEqual([]);
    expect(runsA).toBe(0);
    expect(runsB).toBe(0);
    expect(owner.getPythonGate().pending?.routeId).toBe("rfdetr.pth.tflite");
    expect(owner.getPythonGate().dialogOpen).toBe(true);
    expect(owner.getPythonGate().busy).toBe(false);
  });

  test("picker choice matching the live pending retries normally", async () => {
    const { owner, gateDeps, saves, runs, run } = createPythonHarness();
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);
    const expected = owner.getPythonGate().pending;

    await owner.choosePythonForSetup(gateDeps, "/valid/python", expected);

    expect(saves).toEqual(["/valid/python"]);
    expect(runs()).toBe(1);
    expect(owner.getPythonGate().dialogOpen).toBe(false);
  });

  test("cancel during override clearing skips redetection and runs nothing", async () => {
    const saving = deferred<void>();
    const started = deferred<void>();
    let resolves = 0;
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      beforeSave: async () => {
        started.resolve();
        await saving.promise;
      },
      resolveImpl: () => {
        resolves += 1;
        return Promise.resolve(availableResult());
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", invalidResult(), run);

    const pending = owner.clearPythonGateOverride(gateDeps);
    await started.promise;
    owner.cancelPythonGate();
    saving.resolve();
    await pending;

    expect(saves).toEqual([null, null]);
    expect(runs()).toBe(0);
    expect(resolves).toBe(0);
    expect(owner.getPythonGate().pending).toBeNull();
  });

  test("cancel during save restores the previous override and runs nothing", async () => {
    const saving = deferred<void>();
    const started = deferred<void>();
    const { owner, gateDeps, saves, stored, runs, run } = createPythonHarness({
      initialOverride: "/user/python",
      beforeSave: async (path) => {
        if (path === "/valid/python") {
          started.resolve();
          await saving.promise;
        }
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    const pending = owner.choosePythonForSetup(gateDeps, "/valid/python");
    await started.promise;
    owner.cancelPythonGate();
    saving.resolve();
    await pending;

    expect(saves).toEqual(["/valid/python", "/user/python"]);
    expect(stored()).toBe("/user/python");
    expect(runs()).toBe(0);
    expect(owner.getPythonGate().pending).toBeNull();
  });

  test("replacement during save restores the previous override and keeps the new pending", async () => {
    const saving = deferred<void>();
    const started = deferred<void>();
    let runsA = 0;
    let runsB = 0;
    const { owner, gateDeps, saves, stored } = createPythonHarness({
      beforeSave: async (path) => {
        if (path === "/choice-a/python") {
          started.resolve();
          await saving.promise;
        }
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      runsA += 1;
    });

    const stale = owner.choosePythonForSetup(gateDeps, "/choice-a/python");
    await started.promise;
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      runsB += 1;
    });
    saving.resolve();
    await stale;

    expect(saves).toEqual(["/choice-a/python", null]);
    expect(stored()).toBeNull();
    expect(runsA).toBe(0);
    expect(runsB).toBe(0);
    expect(owner.getPythonGate().pending?.routeId).toBe("rfdetr.pth.tflite");
    expect(owner.getPythonGate().dialogOpen).toBe(true);
  });

  test("a replacement that saves while the old save is in flight wins", async () => {
    const savingA = deferred<void>();
    const startedA = deferred<void>();
    let runsA = 0;
    let runsB = 0;
    const { owner, gateDeps, saves, stored } = createPythonHarness({
      beforeSave: async (path) => {
        if (path === "/choice-a/python") {
          startedA.resolve();
          await savingA.promise;
        }
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      runsA += 1;
    });
    const stale = owner.choosePythonForSetup(gateDeps, "/choice-a/python");
    await startedA.promise;

    // The replacement queues behind the in-flight save: the stale unit
    // finishes first and puts back what it found, then the live unit saves
    // its own choice and retries. Writes: /choice-a, null, /choice-b.
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      runsB += 1;
    });
    const live = owner.choosePythonForSetup(gateDeps, "/choice-b/python");
    savingA.resolve();
    await stale;
    await live;

    expect(saves).toEqual(["/choice-a/python", null, "/choice-b/python"]);
    expect(stored()).toBe("/choice-b/python");
    expect(runsA).toBe(0);
    expect(runsB).toBe(1);
    expect(owner.getPythonGate().pending).toBeNull();
  });

  test("stale clear restores the previous override instead of leaving it cleared", async () => {
    const saving = deferred<void>();
    const started = deferred<void>();
    const { owner, gateDeps, saves, stored, runs, run } = createPythonHarness({
      initialOverride: "/bad/python",
      beforeSave: async (path) => {
        if (path === null) {
          started.resolve();
          await saving.promise;
        }
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", invalidResult(), run);

    const pending = owner.clearPythonGateOverride(gateDeps);
    await started.promise;
    owner.cancelPythonGate();
    saving.resolve();
    await pending;

    expect(saves).toEqual([null, "/bad/python"]);
    expect(stored()).toBe("/bad/python");
    expect(runs()).toBe(0);
    expect(owner.getPythonGate().pending).toBeNull();
  });

  test("override read failure shows the exact reason without saving", async () => {
    const { owner, gateDeps, saves, runs, run } = createPythonHarness({
      loadImpl: async () => {
        throw new Error("settings file is corrupt");
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePythonForSetup(gateDeps, "/valid/python");

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    expect(owner.getPythonGate().dialogOpen).toBe(true);
    expect(owner.getPythonGate().choiceError).toContain("settings file is corrupt");
  });

  test("canceled queued choose performs no write while the live save reconciles", async () => {
    const savingA = deferred<void>();
    const startedA = deferred<void>();
    let runsA = 0;
    let runsB = 0;
    const { owner, gateDeps, saves, stored } = createPythonHarness({
      initialOverride: "/original",
      beforeSave: async (path) => {
        if (path === "/a") {
          startedA.resolve();
          await savingA.promise;
        }
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      runsA += 1;
    });
    const liveSave = owner.choosePythonForSetup(gateDeps, "/a");
    await startedA.promise;

    // B queues behind A's in-flight unit, then is canceled before acquiring.
    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      runsB += 1;
    });
    const queuedStale = owner.choosePythonForSetup(gateDeps, "/b");
    owner.cancelPythonGate();
    savingA.resolve();
    await liveSave;
    await queuedStale;

    expect(saves).toEqual(["/a", "/original"]);
    expect(stored()).toBe("/original");
    expect(runsA).toBe(0);
    expect(runsB).toBe(0);
    expect(owner.getPythonGate().pending).toBeNull();
  });

  test("canceled queued clear performs no write and skips redetection", async () => {
    const savingA = deferred<void>();
    const startedA = deferred<void>();
    let resolves = 0;
    let runsA = 0;
    const { owner, gateDeps, saves, stored } = createPythonHarness({
      initialOverride: "/original",
      beforeSave: async (path) => {
        if (path === "/a") {
          startedA.resolve();
          await savingA.promise;
        }
      },
      resolveImpl: async (routeId, override) => {
        resolves += 1;
        return availableResult();
      },
    });
    owner.requirePythonForSetup("ultralytics.pt.onnx", missingResult(), async () => {
      runsA += 1;
    });
    const liveSave = owner.choosePythonForSetup(gateDeps, "/a");
    await startedA.promise;

    owner.requirePythonForSetup("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {});
    const queuedStale = owner.clearPythonGateOverride(gateDeps);
    owner.cancelPythonGate();
    savingA.resolve();
    await liveSave;
    await queuedStale;

    // One resolve for A's validation; the stale clear never loads, saves,
    // or redetects.
    expect(resolves).toBe(1);
    expect(saves).toEqual(["/a", "/original"]);
    expect(stored()).toBe("/original");
    expect(runsA).toBe(0);
    expect(owner.getPythonGate().pending).toBeNull();
  });
});
