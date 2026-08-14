// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "@/components/ui/dialog";
import {
  getInstallStartFailureOutcome,
  getInstallableMissingPackages,
  getIncompatibleExportMessage,
  getManagedRuntimeRebuildFailureMessage,
  getManagedRuntimeUpgradeNudge,
  ManagedRuntimeUpgradeDialogBody,
  mayStartManagedRuntimeUpgrade,
  mayActivateRoute,
  refreshStackEnvironments,
} from "./export-workspace";
import type { DepCheckResult, ExportStatus, InstallPhase, StackEnvironment } from "@/lib/types";
import { findRoute } from "@/lib/providers";

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
      "ultralytics>=8.4.80",
      "onnx",
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
    expect(packages).not.toContain("Python 3.10+");
    expect(packages).toEqual(["onnx"]);
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

    expect(getInstallableMissingPackages(results)).toEqual(["imx500-converter"]);
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
    }])).toEqual(["torch>=2.13"]);
  });

  test("does not client-block unresolved or unknown architecture", () => {
    const route = findRoute("rfdetr.pth.executorch")!;
    expect(getIncompatibleExportMessage(route, "macos", "unknown", false)).toBeNull();
    expect(getIncompatibleExportMessage(route, "macos", "unknown", true)).toBeNull();
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
      python_path: "/tmp/runtime/envs/rfdetr-default/.venv/bin/python",
      python_version: { status: "available", version: "3.12.12" },
    }];
    let received: StackEnvironment[] | undefined;

    await refreshStackEnvironments((next) => {
      received = next;
    }, async () => stacks);

    expect(received).toEqual(stacks);
  });
});
