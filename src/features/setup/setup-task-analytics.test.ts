// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { createSetupTaskOwner, type InstallStreamDeps } from "./setup-task";
import { ENVIRONMENT_SETUP_EVENT } from "./setup-analytics";

function createFakeDeps(options?: {
  sessionId?: string;
  startError?: string;
  yoloPath?: string | null;
  verifyError?: string;
}) {
  const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
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
      if (options?.verifyError) throw new Error(options.verifyError);
      return { yoloPath: options?.yoloPath === undefined ? "/tmp/.venv/bin/yolo" : options.yoloPath };
    },
  };
  return { deps, handlers };
}

function fire(
  handlers: Map<string, Array<(ev: { payload: unknown }) => void>>,
  event: string,
  payload: unknown,
) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

type CapturedEvent = { eventName: string; properties: Record<string, unknown> };

function createCapture(options?: { enabled?: boolean; throwOnCapture?: boolean }) {
  const events: CapturedEvent[] = [];
  const analytics = {
    now: (() => {
      let t = 1000;
      return () => (t += 250);
    })(),
    enabled: () => options?.enabled ?? true,
    capture: (eventName: string, properties: Record<string, unknown>) => {
      if (options?.throwOnCapture) throw new Error("posthog down");
      events.push({ eventName, properties });
    },
  };
  return { events, analytics };
}

const baseRequest = {
  provider: "ultralytics" as const,
  routeId: "ultralytics.pt.onnx",
  environmentKey: "ultralytics-managed" as const,
  packages: [{ package: "ultralytics", prerelease: false }],
  pythonPath: "/tmp/sensitive-bootstrap-python",
};

describe("setup task terminal analytics (ticket 16)", () => {
  test("success emits exactly one terminal event with the allowed fields", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture();
    const owner = createSetupTaskOwner(deps, { analytics });
    const promise = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe(ENVIRONMENT_SETUP_EVENT);
    expect(events[0].properties).toEqual({
      provider: "ultralytics",
      environment_key: "ultralytics-managed",
      route_id: "ultralytics.pt.onnx",
      setup_result: "success",
      duration_ms: expect.any(Number),
    });
  });

  test("failure emits exactly one terminal event with failure result", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture();
    const owner = createSetupTaskOwner(deps, { analytics });
    const promise = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:failed", { session_id: "session-1", error: "pip exploded" });
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      provider: "ultralytics",
      environment_key: "ultralytics-managed",
      setup_result: "failure",
    });
  });

  test("duplicate terminal notifications emit exactly one event", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture();
    const owner = createSetupTaskOwner(deps, { analytics });
    const promise = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:finished", { session_id: "session-1" });
    fire(handlers, "install:finished", { session_id: "session-1" });
    fire(handlers, "install:failed", { session_id: "session-1", error: "late failure" });
    expect(await promise).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({ setup_result: "success" });
  });

  test("retry after dismiss emits a second event without a stable user/model identifier", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture();
    const owner = createSetupTaskOwner(deps, { analytics });
    const first = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await first).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    owner.dismissTask();
    const second = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await second).toEqual({ ok: true });
    expect(events).toHaveLength(2);
    for (const event of events) {
      const props = event.properties as Record<string, unknown>;
      expect(props).not.toContainKey("session_id");
      expect(Object.keys(props).sort()).toEqual(
        ["duration_ms", "environment_key", "provider", "route_id", "setup_result"].sort(),
      );
    }
  });

  test("disabled analytics emits nothing but setup still succeeds", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture({ enabled: false });
    const owner = createSetupTaskOwner(deps, { analytics });
    const promise = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(events).toHaveLength(0);
    expect(owner.getState()?.status).toBe("succeeded");
  });

  test("analytics failure never changes setup readiness", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture({ throwOnCapture: true });
    const owner = createSetupTaskOwner(deps, { analytics });
    const promise = owner.startRuntimeInstall(baseRequest);
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(owner.getState()?.status).toBe("succeeded");
    expect(events).toHaveLength(0);
  });

  test("emitted properties never contain forbidden fields", async () => {
    const { deps, handlers } = createFakeDeps();
    const { events, analytics } = createCapture();
    const owner = createSetupTaskOwner(deps, { analytics });
    const promise = owner.startRuntimeInstall({
      ...baseRequest,
      provider: "rfdetr",
      routeId: "rfdetr.pth.onnx",
      environmentKey: "rfdetr-default",
    });
    fire(handlers, "install:finished", { session_id: "session-1" });
    expect(await promise).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    const props = events[0].properties as Record<string, unknown>;
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain("/tmp/sensitive-bootstrap-python");
    expect(serialized).not.toContain("session-1");
    for (const key of Object.keys(props)) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain("path");
      expect(lower).not.toContain("python");
      expect(lower).not.toContain("model");
      expect(lower).not.toContain("checkpoint");
      expect(lower).not.toContain("error");
      expect(lower).not.toContain("log");
    }
  });
});
