// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "@/components/ui/dialog";
import {
  createEnvironmentPublisher,
  EnvironmentGroups,
  getInstallStartFailureOutcome,
  getInstallableMissingPackages,
  getIncompatibleExportMessage,
  getManagedRuntimeRebuildFailureMessage,
  getManagedRuntimeUpgradeNudge,
  getUltralyticsSetupBannerContent,
  ManagedRuntimeUpgradeDialogBody,
  mayStartManagedRuntimeUpgrade,
  mayActivateRoute,
  refreshStackEnvironments,
} from "./export-workspace";
import { SETUP_CONFLICT_MESSAGE } from "@/features/setup/setup-task";
import { findRoute } from "@/lib/providers";
import type { DepCheckResult, EnvironmentInfo, ExportStatus, InstallPhase, StackEnvironment } from "@/lib/types";

describe("getInstallableMissingPackages", () => {
  test("returns explicit install_package values", () => {
    const results: DepCheckResult[] = [
      {
        item: "ultralytics",
        status: "version_too_old",
        reason: "",
        install_hint: 'pip install "ultralytics>=8.4.80"',
        install_package: "ultralytics>=8.4.80",
      },
      {
        item: "onnx",
        status: "missing_package",
        reason: "",
        install_hint: "pip install onnx",
        install_package: "onnx",
      },
    ];

    expect(getInstallableMissingPackages(results)).toEqual([
      { package: "ultralytics>=8.4.80", prerelease: false },
      { package: "onnx", prerelease: false },
    ]);
  });

  test("never returns the python display item", () => {
    const results: DepCheckResult[] = [
      {
        item: "Python 3.10+",
        status: "version_too_old",
        reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
        install_hint: "Install/select Python 3.10 or newer...",
      },
      {
        item: "onnx",
        status: "missing_package",
        reason: "",
        install_hint: "pip install onnx",
        install_package: "onnx",
      },
    ];

    const packages = getInstallableMissingPackages(results);
    expect(packages).not.toContainEqual({ package: "Python 3.10+", prerelease: false });
    expect(packages).toEqual([{ package: "onnx", prerelease: false }]);
  });

  test("keeps pip-installable missing binaries", () => {
    const results: DepCheckResult[] = [
      {
        item: "imxconv-pt",
        status: "missing_binary",
        reason: "",
        install_hint: "pip install imx500-converter",
      },
    ];

    expect(getInstallableMissingPackages(results)).toEqual([{ package: "imx500-converter", prerelease: false }]);
  });

  test("carries typed prerelease metadata without parsing install hints", () => {
    const result: DepCheckResult = {
      item: "flatc",
      status: "missing_package",
      reason: "missing",
      install_hint: "python -m pip install --pre flatc",
      install_package: "flatc",
      prerelease: true,
    };
    expect(getInstallableMissingPackages([result])).toEqual([
      { package: "flatc", prerelease: true },
    ]);
  });

  test("unknown ultralytics probe is never offered for install", () => {
    const unknownUltralytics: DepCheckResult = {
      item: "ultralytics",
      status: "unknown",
      reason: "probe failed",
      install_hint: 'pip install "ultralytics>=8.4.80"',
    };

    expect(getInstallableMissingPackages([unknownUltralytics])).toEqual([]);
  });

  test("keeps an unsatisfied torch floor in install consent list", () => {
    expect(getInstallableMissingPackages([{
      item: "torch>=2.13",
      status: "version_too_old",
      reason: "Torch 2.12.1 is installed; 2.13 or newer is required.",
      install_hint: 'pip install "torch>=2.13"',
      install_package: "torch>=2.13",
    }])).toEqual([{ package: "torch>=2.13", prerelease: false }]);
  });

  test("does not client-block unresolved or unknown architecture", () => {
    const route = findRoute("rfdetr.pth.executorch")!;
    expect(getIncompatibleExportMessage(route, "macos", "unknown", false)).toBeNull();
    expect(getIncompatibleExportMessage(route, "macos", "unknown", true)).toBeNull();
    expect(getIncompatibleExportMessage(route, "windows", "unknown", true)).toBeNull();
  });

  test("keeps OS-only blocks when resolved architecture is unavailable", () => {
    const coremlRoute = findRoute("rfdetr.pth.coreml")!;
    const edgeTpuRoute = findRoute("ultralytics.pt.edgetpu")!;

    expect(getIncompatibleExportMessage(coremlRoute, "windows", "unknown", true)).not.toBeNull();
    expect(getIncompatibleExportMessage(edgeTpuRoute, "macos", "unknown", true)).not.toBeNull();
  });
});

describe("runtime operation UI guards", () => {
  const unchanged = {
    selectedRouteId: "ultralytics.pt.onnx",
    logLines: ["export output"],
    exportStatus: "running" as ExportStatus,
    installPhase: "idle" as InstallPhase,
  };

  test("route activation is blocked while export runs without changing current state", () => {
    expect(mayActivateRoute(unchanged.exportStatus, unchanged.installPhase)).toBe(false);
    expect(unchanged).toEqual({
      selectedRouteId: "ultralytics.pt.onnx",
      logLines: ["export output"],
      exportStatus: "running",
      installPhase: "idle",
    });
  });

  test("route activation is blocked while install runs", () => {
    expect(mayActivateRoute("idle", "installing")).toBe(false);
  });

  test("route activation works when idle", () => {
    expect(mayActivateRoute("idle", "idle")).toBe(true);
  });

  test("every backend runtime refusal uses generic actionable copy", () => {
    for (const error of [
      "another runtime operation is in progress: export",
      "another runtime operation is in progress: dependency install",
      "another runtime operation is in progress: setup",
      "another runtime operation is in progress: managed runtime rebuild",
    ]) {
      expect(getInstallStartFailureOutcome(error)).toEqual({
        refused: true,
        message: "Another runtime operation is in progress. Wait for it to finish before installing dependencies.",
      });
    }
  });

  test("genuine install start failure is not a refusal", () => {
    expect(getInstallStartFailureOutcome("spawn failed")).toEqual({
      refused: false,
      message: "[error] Failed to start install: spawn failed",
    });
  });
});

describe("ultralytics on-demand setup banner (ticket 07)", () => {
  test("keeps the provider-wide entry point when no setup has run", () => {
    expect(getUltralyticsSetupBannerContent("idle")).toEqual({
      title: "Ultralytics runtime required",
      body: "Install once to enable YOLO exports on this machine.",
      action: "Install Runtime",
      secondaryAction: null,
    });
  });

  test("labels a failed setup incomplete with Retry first and confirmed Remove", () => {
    expect(getUltralyticsSetupBannerContent("failed")).toEqual({
      title: "Setup incomplete",
      body: "The partially created environment was preserved. Retry to continue in the same environment, or remove it for a confirmed fresh start.",
      action: "Retry setup",
      secondaryAction: "Remove…",
    });
  });

  test("installing and ready keep the entry point copy, not the failure copy", () => {
    expect(getUltralyticsSetupBannerContent("installing").title).toBe(
      "Ultralytics runtime required",
    );
    expect(getUltralyticsSetupBannerContent("ready").action).toBe("Install Runtime");
  });
});

describe("managed runtime upgrade UI", () => {
  test("runtime upgrade dialog container renders when open", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Dialog,
        { open: true },
        React.createElement(ManagedRuntimeUpgradeDialogBody, {
          candidateVersion: "3.12.12",
          rebuilding: false,
          lines: [],
          error: null,
          mayStart: true,
          onCancel: () => {},
          onContinue: () => {},
        }),
      ),
    );

    expect(html).toContain("Set up a new export runtime?");
    expect(html).toContain("<li");
    expect(html).toContain("using Python 3.12.12");
    expect(html).toContain("Keep your current runtime if setup fails");
    expect(html).not.toContain("Ultralytics");
  });

  test("runtime upgrade is available only while every operation is idle", () => {
    expect(mayStartManagedRuntimeUpgrade("starting", "idle", "idle", false)).toBe(false);
    expect(mayStartManagedRuntimeUpgrade("running", "idle", "idle", false)).toBe(false);
    expect(mayStartManagedRuntimeUpgrade("idle", "installing", "idle", false)).toBe(false);
    expect(mayStartManagedRuntimeUpgrade("idle", "idle", "installing", false)).toBe(false);
    expect(mayStartManagedRuntimeUpgrade("idle", "idle", "idle", true)).toBe(false);
    expect(mayStartManagedRuntimeUpgrade("idle", "idle", "idle", false)).toBe(true);
  });

  test("nudge renders for either provider when eligible with candidate", () => {
    expect(getManagedRuntimeUpgradeNudge({ eligible: true, current_version: "3.9.6", candidate_version: "3.12.12" }))
      .toBe("Python 3.12.12 is available. Set up a new export runtime with it?");
    expect(getManagedRuntimeUpgradeNudge({ eligible: true, current_version: "3.9.6", candidate_version: "3.12.12" }))
      .toBe("Python 3.12.12 is available. Set up a new export runtime with it?");
    expect(getManagedRuntimeUpgradeNudge({ eligible: false, current_version: "3.9.6", candidate_version: null })).toBeNull();
  });

  test("nudge is suppressed while another runtime operation is active", () => {
    expect(getManagedRuntimeUpgradeNudge(
      { eligible: true, current_version: "3.9.6", candidate_version: "3.12.12" },
      false,
    )).toBeNull();
  });

  test("rebuild coordinator refusal is not reported as a failure", () => {
    expect(getManagedRuntimeRebuildFailureMessage("another runtime operation is in progress: export"))
      .toBe("Another runtime operation is in progress. Wait for it to finish before setting up a new runtime.");
  });

  test("genuine rebuild failure keeps previous-runtime assurance", () => {
    expect(getManagedRuntimeRebuildFailureMessage("pip install failed"))
      .toBe("Runtime upgrade failed: pip install failed. Previous runtime is unchanged.");
  });

});

describe("stack environment refresh", () => {
  test("redetect refresh callback replaces stack cards", async () => {
    const stacks: StackEnvironment[] = [{
      key: "rfdetr-default",
      display_name: "RF-DETR",
      route_ids: ["rfdetr.pth.onnx", "rfdetr.pth.executorch"],
      python_path: "/tmp/runtime/envs/rfdetr-default/.venv/bin/python",
      python_version: { status: "available", version: "3.12.12" },
      rfdetr_version: { status: "available", version: "1.9.0" },
    }];
    let received: StackEnvironment[] | undefined;

    await refreshStackEnvironments((next) => {
      received = next;
    }, async () => stacks);

    expect(received).toEqual(stacks);
  });
});

describe("safe setup navigation (ticket 04)", () => {
  function testEnv(yoloPath: string): EnvironmentInfo {
    return {
      python_path: "/tmp/python",
      python_version: "Python 3.12.0",
      yolo_path: yoloPath,
      ultralytics_version: "8.4.80",
      status: "ok",
      warnings: [],
    };
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

  function publishHarness(detect: (pythonPath?: string) => Promise<EnvironmentInfo>) {
    const published: Array<[string, unknown]> = [];
    const publisher = createEnvironmentPublisher({
      detect,
      setEnv: (info) => published.push(["env", info]),
      setError: (message) => published.push(["error", message]),
      setLoading: (loading) => published.push(["loading", loading]),
    });
    return { published, publisher };
  }

  test("a stale detection resolves without publishing anything", async () => {
    const first = deferred<EnvironmentInfo>();
    const second = deferred<EnvironmentInfo>();
    const { published, publisher } = publishHarness((path) =>
      path === "first" ? first.promise : second.promise,
    );
    const p1 = publisher.publish("first");
    const p2 = publisher.publish("second");
    second.resolve(testEnv("/tmp/yolo-new"));
    const won = await p2;
    expect(won.info?.yolo_path).toBe("/tmp/yolo-new");
    expect(won.failed).toBe(false);
    expect(publisher.isCurrent(won.requestId)).toBe(true);
    first.resolve(testEnv("/tmp/yolo-old"));
    const stale = await p1;
    expect(stale.info).toBeNull();
    expect(stale.failed).toBe(false);
    expect(publisher.isCurrent(stale.requestId)).toBe(false);
    expect(published).toEqual([
      ["env", testEnv("/tmp/yolo-new")],
      ["error", null],
      ["loading", false],
    ]);
  });

  test("a stale failure publishes nothing while the winner clears loading", async () => {
    const first = deferred<EnvironmentInfo>();
    const second = deferred<EnvironmentInfo>();
    const { published, publisher } = publishHarness((path) =>
      path === "first" ? first.promise : second.promise,
    );
    const p1 = publisher.publish("first");
    const p2 = publisher.publish("second");
    second.resolve(testEnv("/tmp/yolo"));
    expect((await p2).failed).toBe(false);
    first.reject(new Error("stale boom"));
    const stale = await p1;
    expect(stale.failed).toBe(false);
    expect(stale.info).toBeNull();
    expect(published).toEqual([
      ["env", testEnv("/tmp/yolo")],
      ["error", null],
      ["loading", false],
    ]);
  });

  test("a winning failure drops the environment and clears loading", async () => {
    const pending = deferred<EnvironmentInfo>();
    const published: Array<[string, unknown]> = [];
    const publisher = createEnvironmentPublisher({
      detect: () => pending.promise,
      setEnv: (info) => published.push(["env", info]),
      setError: (message) => published.push(["error", message]),
      setLoading: (loading) => published.push(["loading", loading]),
    });
    const completed = publisher.publish("/tmp/python");
    pending.reject(new Error("detect crashed"));
    const outcome = await completed;
    expect(outcome.failed).toBe(true);
    expect(outcome.info).toBeNull();
    expect(published).toEqual([
      ["error", "Error: detect crashed"],
      ["env", null],
      ["loading", false],
    ]);
  });

  test("disabled cleanup buttons expose the shared setup conflict as their title", () => {
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentGroups, {
        envInfo: null,
        envError: "boom",
        redetecting: false,
        managedRuntimeUpgradeNudge: null,
        openManagedRuntimeUpgrade: () => {},
        mayStartRuntimeUpgrade: false,
        stacks: [],
        managedEnvironmentSizes: {
          "ultralytics-managed": { key: "ultralytics-managed", status: "available", estimated_logical_bytes: 10, size_error: null, exists: true },
        } as never,
        onCleanupUltralytics: () => {},
        cleanupDisabled: true,
        disabledReason: SETUP_CONFLICT_MESSAGE,
        defaultExpanded: true,
      }),
    );
    expect(html).toContain(SETUP_CONFLICT_MESSAGE);
  });
});
