// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { providers, routesForProvider } from "@/lib/providers";
import type { DepCheckResult } from "@/lib/types";

import {
  getRfDetrRouteSetupCopy,
  getRfDetrRouteSetupFallbackPackages,
  getRfDetrRouteSetupPrimaryAction,
  getRfDetrRouteSetupStatus,
  getRfDetrSetupInstallPackages,
  shouldHideRfDetrExportControls,
} from "./rfdetr-route-setup";

function readyOnnxResults(): DepCheckResult[] {
  return [
    { item: "rfdetr[onnx]", status: "ready", reason: "", install_hint: 'pip install "rfdetr[onnx]"' },
  ];
}

function baseInput(overrides: Partial<Parameters<typeof getRfDetrRouteSetupStatus>[0]> = {}) {
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

describe("getRfDetrRouteSetupStatus", () => {
  test("reports ready only when every dependency is ready", () => {
    expect(getRfDetrRouteSetupStatus(baseInput())).toBe("ready");
  });

  test("reports checking while the dependency check is running", () => {
    expect(
      getRfDetrRouteSetupStatus(baseInput({ depCheckLoading: true, depResults: null })),
    ).toBe("checking");
  });

  test("reports not set up when no healthy stack check has run", () => {
    expect(getRfDetrRouteSetupStatus(baseInput({ depResults: null }))).toBe("not-set-up");
  });

  test("reports not set up for missing selected stack packages", () => {
    expect(
      getRfDetrRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "rfdetr[onnx]",
              status: "missing_package",
              reason: "RF-DETR stack environment has not been created.",
              install_hint: 'pip install "rfdetr[onnx]"',
              install_package: "rfdetr[onnx]",
            },
          ],
        }),
      ),
    ).toBe("not-set-up");
  });

  test("reports setting up while the selected stack install is active", () => {
    expect(
      getRfDetrRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "rfdetr[onnx]",
              status: "missing_package",
              reason: "missing",
              install_hint: 'pip install "rfdetr[onnx]"',
              install_package: "rfdetr[onnx]",
            },
          ],
          setupActive: true,
        }),
      ),
    ).toBe("setting-up");
  });

  test("reports setup incomplete after a failed setup preserves the partial stack", () => {
    expect(
      getRfDetrRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "rfdetr[onnx]",
              status: "missing_package",
              reason: "missing",
              install_hint: 'pip install "rfdetr[onnx]"',
              install_package: "rfdetr[onnx]",
            },
          ],
          setupFailed: true,
        }),
      ),
    ).toBe("setup-incomplete");
  });

  test("keeps shared-stack readiness per route: ONNX ready while ExecuTorch missing", () => {
    const onnxReady = getRfDetrRouteSetupStatus(baseInput({ depResults: readyOnnxResults() }));
    const executorchMissing = getRfDetrRouteSetupStatus(
      baseInput({
        depResults: [
          {
            item: "rfdetr[executorch]>=1.9.0",
            status: "missing_package",
            reason: "missing",
            install_hint: 'pip install "rfdetr[executorch]>=1.9.0"',
            install_package: "rfdetr[executorch]>=1.9.0",
          },
          {
            item: "torch>=2.13",
            status: "missing_package",
            reason: "missing",
            install_hint: 'pip install "torch>=2.13"',
            install_package: "torch>=2.13",
          },
        ],
      }),
    );
    expect(onnxReady).toBe("ready");
    expect(executorchMissing).toBe("not-set-up");
  });

  test("reports unavailable for hard platform restrictions before installation", () => {
    expect(getRfDetrRouteSetupStatus(baseInput({ hostStatus: "unsupported" }))).toBe(
      "unavailable",
    );
  });

  test("reports unavailable when the backend preflight short-circuits on platform", () => {
    expect(
      getRfDetrRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "platform",
              status: "platform_unsupported",
              reason: "TensorRT requires Linux.",
              install_hint: "TensorRT requires Linux.",
            },
          ],
        }),
      ),
    ).toBe("unavailable");
  });

  test("reports manual step required for TFLite Python floor without an install remedy", () => {
    expect(
      getRfDetrRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "Python 3.12",
              status: "version_too_old",
              reason: "Python 3.13.12 is selected; TFLite requires Python 3.12.",
              install_hint:
                "Select Python 3.12, then recreate the RF-DETR TFLite export environment.",
            },
          ],
        }),
      ),
    ).toBe("manual-step-required");
  });

  test("reports check failed when dependency probing errors", () => {
    expect(
      getRfDetrRouteSetupStatus(baseInput({ depResults: null, depCheckError: "probe crashed" })),
    ).toBe("check-failed");
  });

  test("a ready route stays ready after another route's setup failure", () => {
    expect(getRfDetrRouteSetupStatus(baseInput({ setupFailed: true }))).toBe("ready");
  });
});

describe("getRfDetrRouteSetupFallbackPackages", () => {
  test("ONNX setup installs only the selected route extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(getRfDetrRouteSetupFallbackPackages(providers.rfdetr, route)).toEqual([
      { package: "rfdetr[onnx]", prerelease: false },
    ]);
  });

  test("TensorRT setup installs only its extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.engine")!;
    expect(getRfDetrRouteSetupFallbackPackages(providers.rfdetr, route)).toEqual([
      { package: "rfdetr[tensorrt]", prerelease: false },
    ]);
  });

  test("CoreML setup installs only its extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.coreml")!;
    expect(getRfDetrRouteSetupFallbackPackages(providers.rfdetr, route)).toEqual([
      { package: "rfdetr[coreml]", prerelease: false },
    ]);
  });

  test("TFLite setup installs the pinned extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.tflite")!;
    expect(getRfDetrRouteSetupFallbackPackages(providers.rfdetr, route)).toEqual([
      { package: "rfdetr[tflite]>=1.9.4", prerelease: false },
    ]);
  });

  test("ExecuTorch setup installs all three declared rows including pre-release flatc", () => {
    const route = routesForProvider("rfdetr").find(
      (item) => item.id === "rfdetr.pth.executorch",
    )!;
    const packages = getRfDetrRouteSetupFallbackPackages(providers.rfdetr, route);
    expect(packages.map((item) => item.package)).toEqual([
      "rfdetr[executorch]>=1.9.0",
      "torch>=2.13",
      "flatc",
    ]);
  });
});

describe("getRfDetrSetupInstallPackages", () => {
  test("missing stack always installs the full route fallback", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(
      getRfDetrSetupInstallPackages(route, { results: null, routeId: null, error: null, pythonPath: null }, { needsWork: true, pythonPath: "/stack/python", stackKey: "rfdetr-default" }),
    ).toEqual([{ package: "rfdetr[onnx]", prerelease: false }]);
  });

  test("existing stack installs only missing packages from its own check", () => {
    const route = routesForProvider("rfdetr").find(
      (item) => item.id === "rfdetr.pth.executorch",
    )!;
    expect(
      getRfDetrSetupInstallPackages(
        route,
        {
          results: [
            { item: "rfdetr[executorch]>=1.9.0", status: "ready", reason: "", install_hint: 'pip install "rfdetr[executorch]>=1.9.0"' },
            { item: "torch>=2.13", status: "missing_package", reason: "missing", install_hint: 'pip install "torch>=2.13"', install_package: "torch>=2.13" },
            { item: "flatc", status: "missing_package", reason: "missing", install_hint: "python -m pip install --pre flatc", install_package: "flatc", prerelease: true },
          ],
          routeId: "rfdetr.pth.executorch",
          error: null,
          pythonPath: "/other/python",
        },
        { needsWork: false, pythonPath: "/stack/python", stackKey: "rfdetr-default" },
      ),
    ).toEqual([
      { package: "torch>=2.13", prerelease: false },
      { package: "flatc", prerelease: true },
    ]);
  });
});

describe("getRfDetrRouteSetupPrimaryAction", () => {
  test("offers setup for a new route and retry after failure", () => {
    expect(getRfDetrRouteSetupPrimaryAction("not-set-up", "Set up ONNX")).toEqual({
      label: "Set up ONNX",
      enabled: true,
    });
    expect(getRfDetrRouteSetupPrimaryAction("setup-incomplete", "Set up ONNX")).toEqual({
      label: "Retry setup",
      enabled: true,
    });
  });

  test("disables while checking, setting up, unavailable, or manual", () => {
    for (const status of ["checking", "setting-up", "unavailable", "manual-step-required"] as const) {
      expect(getRfDetrRouteSetupPrimaryAction(status, "Set up ONNX").enabled).toBe(false);
    }
  });
});

describe("shouldHideRfDetrExportControls", () => {
  test("hides options, preview, and export start until the exact route is ready", () => {
    for (const status of ["checking", "not-set-up", "setting-up", "setup-incomplete", "unavailable", "manual-step-required", "check-failed"] as const) {
      expect(shouldHideRfDetrExportControls("rfdetr", status)).toBe(true);
    }
    expect(shouldHideRfDetrExportControls("rfdetr", "ready")).toBe(false);
  });

  test("leaves other providers untouched", () => {
    expect(shouldHideRfDetrExportControls("ultralytics", "not-set-up")).toBe(false);
  });
});

describe("getRfDetrRouteSetupCopy", () => {
  test("names the selected stack without percentages", () => {
    const copy = getRfDetrRouteSetupCopy("not-set-up", "ONNX", "rfdetr-default");
    expect(copy.body).toContain("ONNX");
    expect(copy.body).not.toContain("%");
  });

  test("setup-incomplete preserves retry and recreate guidance", () => {
    const copy = getRfDetrRouteSetupCopy("setup-incomplete", "ONNX", "rfdetr-default");
    expect(copy.body).toContain("Retry");
    expect(copy.body).toContain("Recreate");
  });
});
