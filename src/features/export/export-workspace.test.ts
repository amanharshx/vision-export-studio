// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  getInstallStartFailureOutcome,
  getInstallableMissingPackages,
  mayActivateRoute,
} from "./export-workspace";
import type { DepCheckResult, ExportStatus, InstallPhase } from "@/lib/types";

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

  test("refused install start preserves export state and reports actionable error", () => {
    expect(getInstallStartFailureOutcome("another runtime operation is in progress: export")).toEqual({
      refused: true,
      message: "Export is still running. Wait for it to finish before installing dependencies.",
      preserveExportState: true,
      captureExportFailure: false,
    });
  });

  test("genuine install start failure keeps failure state and analytics", () => {
    expect(getInstallStartFailureOutcome("spawn failed")).toEqual({
      refused: false,
      message: "[error] Failed to start install: spawn failed",
      preserveExportState: false,
      captureExportFailure: true,
    });
  });
});
