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
  type RuntimeInstallRequest,
  type SetupTaskOwner,
} from "./setup-task";

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
