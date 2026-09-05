// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { providers, routesForProvider } from "@/lib/providers";
import type { DepCheckResult, ProviderId } from "@/lib/types";
import { getInstallableMissingPackages } from "./export-workspace";
import {
  emptyRouteDepCheck,
  getUltralyticsRouteSetupCopy,
  getUltralyticsRouteSetupFallbackPackages,
  getUltralyticsRouteSetupPrimaryAction,
  getUltralyticsRouteSetupStatus,
  hasBlockingDependencies,
  selectRouteDepCheck,
  shouldHideUltralyticsExportControls,
  type RouteDepCheck,
  type UltralyticsRouteSetupStatus,
} from "./ultralytics-route-setup";

function readyOnnxResults(): DepCheckResult[] {
  return [
    { item: "ultralytics", status: "ready", reason: "", install_hint: "pip install ultralytics" },
    { item: "onnx", status: "ready", reason: "", install_hint: "pip install onnx" },
    { item: "onnxslim", status: "warning", reason: "optional", install_hint: "pip install onnxslim" },
  ];
}

function baseInput(overrides: Partial<Parameters<typeof getUltralyticsRouteSetupStatus>[0]> = {}) {
  return {
    hostStatus: "supported" as const,
    depResults: readyOnnxResults(),
    depCheckLoading: false,
    depCheckError: null as string | null,
    setupActive: false,
    setupFailed: false,
    ...overrides,
  };
}

describe("getUltralyticsRouteSetupStatus", () => {
  test("reports ready only when every dependency is ready or optional", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput())).toBe("ready");
  });

  test("reports checking while the dependency check is running", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ depCheckLoading: true, depResults: null }))).toBe("checking");
  });

  test("reports not set up when no check has run for the route", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults: null }))).toBe("not-set-up");
  });

  test("reports not set up for first-route missing packages", () => {
    const depResults: DepCheckResult[] = [
      { item: "ultralytics", status: "missing_package", reason: "missing", install_hint: "pip install ultralytics", install_package: "ultralytics>=8.4.80" },
      { item: "onnx", status: "missing_package", reason: "missing", install_hint: "pip install onnx", install_package: "onnx" },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults }))).toBe("not-set-up");
  });

  test("reports setting up while the shared environment install is active", () => {
    const depResults: DepCheckResult[] = [
      { item: "ultralytics", status: "missing_package", reason: "missing", install_hint: "pip install ultralytics", install_package: "ultralytics" },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults, setupActive: true }))).toBe("setting-up");
  });

  test("reports setup incomplete after a failed setup preserves the partial environment", () => {
    const depResults: DepCheckResult[] = [
      { item: "ultralytics", status: "missing_package", reason: "missing", install_hint: "pip install ultralytics", install_package: "ultralytics" },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults, setupFailed: true }))).toBe("setup-incomplete");
  });

  test("prefers setting up over setup incomplete while a retry is active", () => {
    expect(
      getUltralyticsRouteSetupStatus(baseInput({ setupActive: true, setupFailed: true })),
    ).toBe("setting-up");
  });

  test("keeps readiness per route instead of marking every route ready", () => {
    const onnxReady = getUltralyticsRouteSetupStatus(baseInput({ depResults: readyOnnxResults() }));
    const openvinoMissing = getUltralyticsRouteSetupStatus(baseInput({
      depResults: [
        { item: "ultralytics", status: "ready", reason: "", install_hint: "pip install ultralytics" },
        { item: "openvino", status: "missing_package", reason: "missing", install_hint: "pip install openvino", install_package: "openvino" },
        { item: "nncf", status: "missing_package", reason: "missing", install_hint: "pip install nncf", install_package: "nncf" },
      ],
    }));
    expect(onnxReady).toBe("ready");
    expect(openvinoMissing).toBe("not-set-up");
  });

  test("reports unavailable for hard platform restrictions before installation", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ hostStatus: "unsupported" }))).toBe("unavailable");
    expect(getUltralyticsRouteSetupStatus(baseInput({ hostStatus: "error" }))).toBe("unavailable");
  });

  test("reports unavailable when the backend preflight short-circuits on platform", () => {
    const depResults: DepCheckResult[] = [
      { item: "platform", status: "platform_unsupported", reason: "TensorRT requires Linux.", install_hint: "TensorRT requires Linux." },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults }))).toBe("unavailable");
  });

  test("reports manual step required for a Python floor without an install remedy", () => {
    const depResults: DepCheckResult[] = [
      {
        item: "Python 3.10+",
        status: "version_too_old",
        reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
        install_hint: "Install/select Python 3.10 or newer, then re-detect the environment and recreate the export runtime.",
      },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults }))).toBe("manual-step-required");
  });

  test("reports manual step required for a non-pip system binary", () => {
    const depResults: DepCheckResult[] = [
      { item: "ultralytics", status: "ready", reason: "", install_hint: "pip install ultralytics" },
      { item: "edgetpu_compiler", status: "missing_binary", reason: "missing", install_hint: "coral.ai/docs/edgetpu/compiler" },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults }))).toBe("manual-step-required");
  });

  test("reports check failed when dependency probing errors", () => {
    expect(
      getUltralyticsRouteSetupStatus(baseInput({ depResults: null, depCheckError: "probe crashed" })),
    ).toBe("check-failed");
  });

  test("hard platform restrictions stay unavailable after an unrelated setup failure", () => {
    const platformBlocked: DepCheckResult[] = [
      { item: "platform", status: "platform_unsupported", reason: "TensorRT requires Linux.", install_hint: "TensorRT requires Linux." },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ hostStatus: "unsupported", setupFailed: true }))).toBe("unavailable");
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults: platformBlocked, setupFailed: true }))).toBe("unavailable");
  });

  test("a ready route stays ready after another route's setup failure", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ setupFailed: true }))).toBe("ready");
  });

  test("manual steps stay manual after an unrelated setup failure", () => {
    const depResults: DepCheckResult[] = [
      {
        item: "Python 3.10+",
        status: "version_too_old",
        reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
        install_hint: "Install/select Python 3.10 or newer.",
      },
    ];
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults, setupFailed: true }))).toBe("manual-step-required");
  });

  test("a fresh check error on the failed route keeps setup-incomplete retry", () => {
    expect(
      getUltralyticsRouteSetupStatus(baseInput({ depResults: null, depCheckError: "Setup failed.", setupFailed: true })),
    ).toBe("setup-incomplete");
  });
});

describe("hasBlockingDependencies", () => {
  test("missing results count as blocking", () => {
    expect(hasBlockingDependencies(null)).toBe(true);
  });

  test("ready and optional results are not blocking", () => {
    expect(hasBlockingDependencies(readyOnnxResults())).toBe(false);
  });

  test("missing packages block export", () => {
    expect(hasBlockingDependencies([
      { item: "onnx", status: "missing_package", reason: "missing", install_hint: "pip install onnx", install_package: "onnx" },
    ])).toBe(true);
  });
});

describe("selectRouteDepCheck", () => {
  const results = readyOnnxResults();
  const check = (overrides: Partial<RouteDepCheck> = {}): RouteDepCheck => ({
    results,
    routeId: "ultralytics.pt.onnx",
    error: null,
    pythonPath: "/tmp/python",
    ...overrides,
  });

  test("returns the check only for the route that was checked", () => {
    expect(selectRouteDepCheck(check(), "ultralytics.pt.onnx")).toEqual(check());
  });

  test("drops results and errors checked for a previously selected route", () => {
    expect(selectRouteDepCheck(
      check({ error: "probe crashed" }),
      "ultralytics.pt.openvino",
    )).toEqual({ results: null, routeId: null, error: null, pythonPath: null });
  });

  test("stays empty when no check has run", () => {
    expect(selectRouteDepCheck(
      { results: null, routeId: null, error: null, pythonPath: null },
      "ultralytics.pt.onnx",
    )).toEqual({ results: null, routeId: null, error: null, pythonPath: null });
  });
});

describe("incremental second-route setup packages", () => {
  test("installs only dependencies missing for the newly selected route", () => {
    const depResults: DepCheckResult[] = [
      { item: "ultralytics", status: "ready", reason: "", install_hint: "pip install ultralytics" },
      { item: "openvino", status: "missing_package", reason: "missing", install_hint: "pip install openvino", install_package: "openvino" },
      { item: "nncf", status: "missing_package", reason: "missing", install_hint: "pip install nncf", install_package: "nncf" },
    ];
    expect(getInstallableMissingPackages(depResults)).toEqual([
      { package: "openvino", prerelease: false },
      { package: "nncf", prerelease: false },
    ]);
  });
});

describe("getUltralyticsRouteSetupFallbackPackages", () => {
  test("first ONNX setup installs the base plus required route packages without optionals", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx")!;
    expect(getUltralyticsRouteSetupFallbackPackages(providers.ultralytics, route)).toEqual([
      { package: "ultralytics", prerelease: false },
      { package: "onnx", prerelease: false },
    ]);
  });

  test("first TorchScript setup installs only the shared base", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.torchscript")!;
    expect(getUltralyticsRouteSetupFallbackPackages(providers.ultralytics, route)).toEqual([
      { package: "ultralytics", prerelease: false },
    ]);
  });

  test("first Axelera setup installs the declared remedy, not the import name", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.axelera")!;
    expect(getUltralyticsRouteSetupFallbackPackages(providers.ultralytics, route)).toEqual([
      { package: "ultralytics", prerelease: false },
      { package: "axelera-devkit", prerelease: false },
    ]);
  });

  test("first LiteRT setup installs the declared export extra once", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.litert")!;
    expect(getUltralyticsRouteSetupFallbackPackages(providers.ultralytics, route)).toEqual([
      { package: "ultralytics", prerelease: false },
      { package: "ultralytics[export-litert]", prerelease: false },
    ]);
  });
});

describe("getUltralyticsRouteSetupPrimaryAction", () => {
  test("offers setup for a new route and retry after failure", () => {
    expect(getUltralyticsRouteSetupPrimaryAction("not-set-up", "Set up ONNX")).toEqual({
      label: "Set up ONNX",
      enabled: true,
    });
    expect(getUltralyticsRouteSetupPrimaryAction("setup-incomplete", "Set up ONNX")).toEqual({
      label: "Retry setup",
      enabled: true,
    });
    expect(getUltralyticsRouteSetupPrimaryAction("check-failed", "Set up ONNX")).toEqual({
      label: "Retry setup",
      enabled: true,
    });
  });

  test("disables the action while checking, setting up, unavailable, or manual", () => {
    const cases: UltralyticsRouteSetupStatus[] = ["checking", "setting-up", "unavailable", "manual-step-required"];
    for (const status of cases) {
      expect(getUltralyticsRouteSetupPrimaryAction(status, "Set up ONNX").enabled).toBe(false);
    }
    expect(getUltralyticsRouteSetupPrimaryAction("checking", "Set up ONNX").label).toContain("Checking");
    expect(getUltralyticsRouteSetupPrimaryAction("setting-up", "Set up ONNX").label).toContain("Setting up");
  });
});

describe("shouldHideUltralyticsExportControls", () => {
  test("hides options, preview, and export start until the exact route is ready", () => {
    const hidden: UltralyticsRouteSetupStatus[] = [
      "checking",
      "not-set-up",
      "setting-up",
      "setup-incomplete",
      "unavailable",
      "manual-step-required",
      "check-failed",
    ];
    for (const status of hidden) {
      expect(shouldHideUltralyticsExportControls("ultralytics", status)).toBe(true);
    }
    expect(shouldHideUltralyticsExportControls("ultralytics", "ready")).toBe(false);
  });

  test("leaves other providers untouched", () => {
    const statuses: UltralyticsRouteSetupStatus[] = ["not-set-up", "checking", "ready"];
    for (const status of statuses) {
      expect(shouldHideUltralyticsExportControls("rfdetr" as ProviderId, status)).toBe(false);
    }
  });
});

describe("getUltralyticsRouteSetupCopy", () => {
  test("describes the setup-only modal without export controls", () => {
    const copy = getUltralyticsRouteSetupCopy("not-set-up", "ONNX");
    expect(copy.title).toContain("Not set up");
    expect(copy.body).toContain("ONNX");
  });

  test("setup-incomplete copy preserves retry and recreate guidance", () => {
    const copy = getUltralyticsRouteSetupCopy("setup-incomplete", "ONNX");
    expect(copy.body).toContain("Retry");
    expect(copy.body).toContain("Recreate");
  });

  test("setting-up copy is honest about background progress", () => {
    const copy = getUltralyticsRouteSetupCopy("setting-up", "ONNX");
    expect(copy.body).not.toContain("%");
    expect(copy.title).toContain("Setting up");
  });
});
