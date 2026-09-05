// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  createPythonRequiredSetupOwner,
  type PythonRequiredDeps,
} from "./python-required-setup";
import type { BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";

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

function createHarness(options?: {
  resolveImpl?: (routeId: string, override?: string) => Promise<BootstrapPythonResult>;
  saveImpl?: (path: string | null) => Promise<void>;
}) {
  const saves: Array<string | null> = [];
  let runs = 0;
  const resolves: Array<{ routeId: string; override?: string }> = [];
  const deps: PythonRequiredDeps = {
    resolveBootstrap: async (routeId, override) => {
      resolves.push({ routeId, override });
      if (options?.resolveImpl) return options.resolveImpl(routeId, override);
      return availableResult();
    },
    saveOverride: async (path) => {
      saves.push(path);
      if (options?.saveImpl) return options.saveImpl(path);
    },
  };
  const owner = createPythonRequiredSetupOwner(deps);
  const run = async () => {
    runs += 1;
  };
  return { owner, saves, resolves, runs: () => runs, run };
}

describe("python-required pending setup (ticket 06)", () => {
  test("starts closed: never shown on launch without a blocked setup", () => {
    const { owner } = createHarness();
    const state = owner.getState();
    expect(state.dialogOpen).toBe(false);
    expect(state.pending).toBeNull();
    expect(state.result).toBeNull();
  });

  test("valid choice saves and retries the pending setup exactly once", async () => {
    const { owner, saves, runs, run } = createHarness();
    expect(owner.requirePython("ultralytics.pt.onnx", missingResult(), run)).toBe(true);
    expect(owner.getState().dialogOpen).toBe(true);

    await owner.choosePython("/valid/python");

    expect(saves).toEqual(["/valid/python"]);
    expect(runs()).toBe(1);
    expect(owner.getState().dialogOpen).toBe(false);
    expect(owner.getState().pending).toBeNull();

    // A second choice with no pending retries nothing.
    await owner.choosePython("/valid/python");
    expect(runs()).toBe(1);
    expect(saves).toEqual(["/valid/python"]);
  });

  test("invalid choice keeps the dialog open with the exact reason", async () => {
    const reason = "provided Python failed validation: /bad/python failed validation: crashed";
    const { owner, saves, runs, run } = createHarness({
      resolveImpl: async () => invalidResult(reason),
    });
    owner.requirePython("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePython("/bad/python");

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    const state = owner.getState();
    expect(state.dialogOpen).toBe(true);
    expect(state.choiceError).toBe(reason);
    expect(state.pending).not.toBeNull();
  });

  test("incompatible version keeps the dialog open without saving", async () => {
    const reason =
      "Python 3.9.6 is not supported for ultralytics.pt.onnx; requires Python 3.10 through 3.13.";
    const { owner, saves, runs, run } = createHarness({
      resolveImpl: async () => ({
        status: "invalid_override",
        python_path: "/py39/bin/python",
        source: "explicit-override",
        reason,
        version: "3.9.6",
        requirement: "Python 3.10 through 3.13",
      }),
    });
    owner.requirePython("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePython("/py39/bin/python");

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    expect(owner.getState().dialogOpen).toBe(true);
    expect(owner.getState().choiceError).toContain("not supported");
  });

  test("cleared override redetects and retries when a compatible Python appears", async () => {
    const { owner, saves, runs, run } = createHarness({
      resolveImpl: async (_route, override) => {
        if (override !== undefined) return invalidResult();
        return availableResult();
      },
    });
    owner.requirePython("ultralytics.pt.onnx", invalidResult(), run);

    await owner.clearOverride();

    expect(saves).toEqual([null]);
    expect(runs()).toBe(1);
    expect(owner.getState().dialogOpen).toBe(false);
  });

  test("cleared override stays open with fresh missing state when still nothing compatible", async () => {
    const { owner, saves, runs, run } = createHarness({
      resolveImpl: async () => missingResult(),
    });
    owner.requirePython("ultralytics.pt.onnx", invalidResult(), run);

    await owner.clearOverride();

    expect(saves).toEqual([null]);
    expect(runs()).toBe(0);
    const state = owner.getState();
    expect(state.dialogOpen).toBe(true);
    expect(state.result?.status).toBe("missing");
  });

  test("redetection retries once on success and updates the dialog on continued failure", async () => {
    const success = createHarness();
    success.owner.requirePython("ultralytics.pt.onnx", missingResult(), success.run);
    await success.owner.checkAgain();
    expect(success.runs()).toBe(1);
    expect(success.owner.getState().dialogOpen).toBe(false);

    const stillMissing = createHarness({
      resolveImpl: async () => missingResult(),
    });
    stillMissing.owner.requirePython("ultralytics.pt.onnx", missingResult(), stillMissing.run);
    await stillMissing.owner.checkAgain();
    expect(stillMissing.runs()).toBe(0);
    expect(stillMissing.owner.getState().dialogOpen).toBe(true);
    expect(stillMissing.owner.getState().result?.status).toBe("missing");
  });

  test("cancellation creates nothing and changes no package state", async () => {
    const { owner, saves, runs, run } = createHarness();
    owner.requirePython("ultralytics.pt.onnx", missingResult(), run);
    expect(owner.getState().dialogOpen).toBe(true);

    owner.cancel();

    expect(saves).toEqual([]);
    expect(runs()).toBe(0);
    const state = owner.getState();
    expect(state.dialogOpen).toBe(false);
    expect(state.pending).toBeNull();
    expect(state.result).toBeNull();
  });

  test("pending-action replacement discards the old setup without running it", async () => {
    let firstRuns = 0;
    let secondRuns = 0;
    const { owner, saves } = createHarness();
    owner.requirePython("ultralytics.pt.onnx", missingResult(), async () => {
      firstRuns += 1;
    });
    owner.requirePython("rfdetr.pth.tflite", missingResult("Python 3.12"), async () => {
      secondRuns += 1;
    });

    expect(owner.getState().pending?.routeId).toBe("rfdetr.pth.tflite");
    await owner.checkAgain();

    expect(firstRuns).toBe(0);
    expect(secondRuns).toBe(1);
    expect(saves).toEqual([]);
  });

  test("save failure keeps the dialog open with the exact reason and no retry", async () => {
    const { owner, saves, runs, run } = createHarness({
      saveImpl: async () => {
        throw new Error("provided Python failed validation: crashed");
      },
    });
    owner.requirePython("ultralytics.pt.onnx", missingResult(), run);

    await owner.choosePython("/valid/python");

    expect(saves).toEqual(["/valid/python"]);
    expect(runs()).toBe(0);
    expect(owner.getState().dialogOpen).toBe(true);
    expect(owner.getState().choiceError).toContain("failed validation");
  });
});
