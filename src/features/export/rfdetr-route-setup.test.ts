// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { routesForProvider } from "@/lib/providers";
import type { DepCheckResult } from "@/lib/types";
import {
  getUltralyticsRouteSetupPrimaryAction,
  getUltralyticsRouteSetupStatus,
} from "./ultralytics-route-setup";

import {
  getRfDetrRouteSetupCopy,
  getRfDetrRouteSetupFallbackPackages,
  getRfDetrSetupHostRefusal,
  getRfDetrSetupInstallPackages,
  getRfDetrSetupVerifyError,
  shouldHideRfDetrExportControls,
  shouldResumeRfDetrInspectionAfterSetup,
  isRfDetrInspectionReadyForExport,
  getRfDetrInspectionFailureActions,
} from "./rfdetr-route-setup";

function readyOnnxResults(): DepCheckResult[] {
  return [
    { item: "rfdetr[onnx]", status: "ready", reason: "", install_hint: 'pip install "rfdetr[onnx]"' },
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

// The per-route readiness policy is intentionally shared with the
// Ultralytics flow (ready only from the selected route's own check); the
// RF-DETR-specific parts are the stack-scoped fallback, install selection,
// copy, and host refusal below.
describe("shared route readiness policy with RF-DETR inputs", () => {
  test("reports ready only when every dependency is ready", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput())).toBe("ready");
  });

  test("reports checking while the dependency check is running", () => {
    expect(
      getUltralyticsRouteSetupStatus(baseInput({ depCheckLoading: true, depResults: null })),
    ).toBe("checking");
  });

  test("reports not set up when no healthy stack check has run", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults: null }))).toBe("not-set-up");
  });

  test("reports not set up for missing selected stack packages", () => {
    expect(
      getUltralyticsRouteSetupStatus(
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
      getUltralyticsRouteSetupStatus(
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
      getUltralyticsRouteSetupStatus(
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
    const onnxReady = getUltralyticsRouteSetupStatus(baseInput({ depResults: readyOnnxResults() }));
    const executorchMissing = getUltralyticsRouteSetupStatus(
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
    expect(getUltralyticsRouteSetupStatus(baseInput({ hostStatus: "unsupported" }))).toBe(
      "unavailable",
    );
  });

  test("reports unavailable when the backend preflight short-circuits on platform", () => {
    expect(
      getUltralyticsRouteSetupStatus(
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
      getUltralyticsRouteSetupStatus(
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
      getUltralyticsRouteSetupStatus(baseInput({ depResults: null, depCheckError: "probe crashed" })),
    ).toBe("check-failed");
  });

  test("a ready route stays ready after another route's setup failure", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ setupFailed: true }))).toBe("ready");
  });
});

describe("shared setup primary action with RF-DETR labels", () => {
  test("offers setup for a new route and retry after failure", () => {
    expect(getUltralyticsRouteSetupPrimaryAction("not-set-up", "Set up ONNX")).toEqual({
      label: "Set up ONNX",
      enabled: true,
    });
    expect(getUltralyticsRouteSetupPrimaryAction("setup-incomplete", "Set up ONNX")).toEqual({
      label: "Retry setup",
      enabled: true,
    });
  });

  test("disables while checking, setting up, unavailable, or manual", () => {
    for (const status of ["checking", "setting-up", "unavailable", "manual-step-required"] as const) {
      expect(getUltralyticsRouteSetupPrimaryAction(status, "Set up ONNX").enabled).toBe(false);
    }
  });
});

describe("getRfDetrRouteSetupFallbackPackages", () => {
  test("ONNX setup installs only the selected route extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[onnx]", prerelease: false },
    ]);
  });

  test("TensorRT setup installs only its extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.engine")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[tensorrt]", prerelease: false },
    ]);
  });

  test("CoreML setup installs only its extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.coreml")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[coreml]", prerelease: false },
    ]);
  });

  test("TFLite setup installs the pinned extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.tflite")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[tflite]>=1.9.4", prerelease: false },
    ]);
  });

  test("ExecuTorch setup installs all three declared rows including pre-release flatc", () => {
    const route = routesForProvider("rfdetr").find(
      (item) => item.id === "rfdetr.pth.executorch",
    )!;
    const packages = getRfDetrRouteSetupFallbackPackages(route);
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
      getRfDetrSetupInstallPackages(route, { results: null, routeId: null, error: null, pythonPath: null }, { needsWork: true }),
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
        { needsWork: false },
      ),
    ).toEqual([
      { package: "torch>=2.13", prerelease: false },
      { package: "flatc", prerelease: true },
    ]);
  });

  test("a stale check from another route falls back to the full route packages", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(
      getRfDetrSetupInstallPackages(
        route,
        {
          results: [
            { item: "rfdetr[tensorrt]", status: "missing_package", reason: "missing", install_hint: 'pip install "rfdetr[tensorrt]"', install_package: "rfdetr[tensorrt]" },
          ],
          routeId: "rfdetr.pth.engine",
          error: null,
          pythonPath: "/other/python",
        },
        { needsWork: false },
      ),
    ).toEqual([{ package: "rfdetr[onnx]", prerelease: false }]);
  });
});

describe("getRfDetrSetupHostRefusal", () => {
  test("refuses with the exact host reason when the route is unsupported", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.engine",
        [{ route_id: "rfdetr.pth.engine", status: "unsupported", reason: "TensorRT requires an NVIDIA GPU." }],
        { results: null, routeId: null, error: null, pythonPath: null },
      ),
    ).toBe("TensorRT requires an NVIDIA GPU.");
  });

  test("refuses when host support errored for the route", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.coreml",
        [{ route_id: "rfdetr.pth.coreml", status: "error", reason: "Host compatibility check failed: boom" }],
        { results: null, routeId: null, error: null, pythonPath: null },
      ),
    ).toBe("Host compatibility check failed: boom");
  });

  test("refuses with the platform row when the backend preflight short-circuited", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.engine",
        [{ route_id: "rfdetr.pth.engine", status: "supported" }],
        {
          results: [
            { item: "platform", status: "platform_unsupported", reason: "TensorRT requires Linux.", install_hint: "TensorRT requires Linux." },
          ],
          routeId: "rfdetr.pth.engine",
          error: null,
          pythonPath: "/tmp/python",
        },
      ),
    ).toBe("TensorRT requires Linux.");
  });

  test("ignores other routes and allows supported routes", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.onnx",
        [{ route_id: "rfdetr.pth.engine", status: "unsupported", reason: "TensorRT requires Linux." }],
        { results: null, routeId: null, error: null, pythonPath: null },
      ),
    ).toBeNull();
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.onnx",
        [{ route_id: "rfdetr.pth.onnx", status: "supported" }],
        { results: readyOnnxResults(), routeId: "rfdetr.pth.onnx", error: null, pythonPath: "/tmp/python" },
      ),
    ).toBeNull();
  });
});

describe("getRfDetrSetupVerifyError", () => {
  test("fails when installable packages remain after pip success", () => {
    expect(
      getRfDetrSetupVerifyError([
        { item: "rfdetr[onnx]", status: "missing_package", reason: "still missing", install_hint: 'pip install "rfdetr[onnx]"', install_package: "rfdetr[onnx]" },
      ]),
    ).toContain("rfdetr[onnx]");
  });

  test("passes when only manual requirements remain", () => {
    expect(
      getRfDetrSetupVerifyError([
        { item: "Python 3.12", status: "version_too_old", reason: "TFLite requires Python 3.12.", install_hint: "Select Python 3.12." },
      ]),
    ).toBeNull();
  });

  test("passes for ready results and platform rows", () => {
    expect(getRfDetrSetupVerifyError(readyOnnxResults())).toBeNull();
    expect(
      getRfDetrSetupVerifyError([
        { item: "platform", status: "platform_unsupported", reason: "TensorRT requires Linux.", install_hint: "TensorRT requires Linux." },
      ]),
    ).toBeNull();
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

  test("falls back to the route environment when the stack mapping is unresolved", () => {
    const copy = getRfDetrRouteSetupCopy("not-set-up", "ONNX", null);
    expect(copy.title).toContain("Not set up");
    expect(copy.body).toContain("ONNX");
    expect(copy.body).not.toContain("rfdetr.pth.onnx");
    expect(copy.body).not.toContain("%");
  });

  test("setup-incomplete preserves retry and recreate guidance", () => {
    const copy = getRfDetrRouteSetupCopy("setup-incomplete", "ONNX", "rfdetr-default");
    expect(copy.body).toContain("Retry");
    expect(copy.body).toContain("Recreate");
  });
});

function trustedCheckpoint(sourcePath = "/tmp/model.pth") {
  return {
    sourcePath,
    identity: {
      canonical_path: sourcePath,
      len: 1234,
      modified_ms: 1700000000000,
    },
  };
}

function inspectSuccess(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    class_symbol: "RFDETRSmall",
    family: "detection",
    size: "small",
    requires_plus: false,
    is_legacy: false,
    recommended_imgsz: 512,
    patch_size: 16,
    num_windows: 2,
    required_multiple: 32,
    token_grid: 32,
    resolution_source: "saved_model_config",
    error: null,
    ...overrides,
  } as never;
}

function inspectFailure(overrides: Record<string, unknown> = {}) {
  return {
    success: false,
    class_symbol: null,
    family: null,
    size: null,
    requires_plus: false,
    is_legacy: false,
    recommended_imgsz: null,
    patch_size: null,
    num_windows: null,
    required_multiple: null,
    token_grid: null,
    resolution_source: null,
    error: "torch load boom",
    ...overrides,
  } as never;
}

describe("shouldResumeRfDetrInspectionAfterSetup (ticket 11)", () => {
  const liveSession = {
    terminalSessionId: "terminal-1" as string | null,
    consumedSessionId: null as string | null,
  };

  test("resumes the same trusted checkpoint after successful setup", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.onnx",
        sourcePath: "/tmp/model.pth",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        ...liveSession,
      }),
    ).toBe(true);
  });

  test("suppresses resume when the model changed during background setup", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.onnx",
        sourcePath: "/tmp/other.pth",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        ...liveSession,
      }),
    ).toBe(false);
  });

  test("suppresses resume when the model was cleared during background setup", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.onnx",
        sourcePath: "",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        ...liveSession,
      }),
    ).toBe(false);
  });

  test("suppresses a background completion that finished for another route", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.executorch",
        sourcePath: "/tmp/model.pth",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        ...liveSession,
      }),
    ).toBe(false);
  });

  test("never resumes without setup success, trust, a known setup route, or a failed inspection", () => {
    const base = {
      setupSucceeded: true,
      setupRouteId: "rfdetr.pth.onnx" as string | null,
      selectedRouteId: "rfdetr.pth.onnx",
      sourcePath: "/tmp/model.pth",
      trust: trustedCheckpoint("/tmp/model.pth"),
      inspectStatus: "failed" as const,
      terminalSessionId: "terminal-1" as string | null,
      consumedSessionId: null as string | null,
    };
    expect(shouldResumeRfDetrInspectionAfterSetup({ ...base, setupSucceeded: false })).toBe(false);
    expect(shouldResumeRfDetrInspectionAfterSetup({ ...base, trust: null })).toBe(false);
    expect(shouldResumeRfDetrInspectionAfterSetup({ ...base, setupRouteId: null })).toBe(false);
    expect(
      shouldResumeRfDetrInspectionAfterSetup({ ...base, setupRouteId: "rfdetr.pth.executorch" }),
    ).toBe(false);
    expect(shouldResumeRfDetrInspectionAfterSetup({ ...base, inspectStatus: "detected" })).toBe(false);
    expect(shouldResumeRfDetrInspectionAfterSetup({ ...base, inspectStatus: "inspecting" })).toBe(false);
  });

  test("does not resume the same terminal session twice", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.onnx",
        sourcePath: "/tmp/model.pth",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        terminalSessionId: "terminal-1",
        consumedSessionId: "terminal-1",
      }),
    ).toBe(false);
  });

  test("resumes a new terminal session after consuming the previous one", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.onnx",
        sourcePath: "/tmp/model.pth",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        terminalSessionId: "terminal-2",
        consumedSessionId: "terminal-1",
      }),
    ).toBe(true);
  });

  test("never resumes when the terminal session is unknown", () => {
    expect(
      shouldResumeRfDetrInspectionAfterSetup({
        setupSucceeded: true,
        setupRouteId: "rfdetr.pth.onnx",
        selectedRouteId: "rfdetr.pth.onnx",
        sourcePath: "/tmp/model.pth",
        trust: trustedCheckpoint("/tmp/model.pth"),
        inspectStatus: "failed",
        terminalSessionId: null,
        consumedSessionId: null,
      }),
    ).toBe(false);
  });
});

describe("isRfDetrInspectionReadyForExport (ticket 11)", () => {
  test("is ready after successful inspection", () => {
    expect(
      isRfDetrInspectionReadyForExport({
        status: "detected",
        result: inspectSuccess(),
        variantMode: "auto",
        manualClassSymbol: "",
      }),
    ).toBe(true);
  });

  test("is ready for incomplete geometry with known constraints (preset fallback)", () => {
    expect(
      isRfDetrInspectionReadyForExport({
        status: "detected",
        result: inspectSuccess({ recommended_imgsz: null, resolution_source: null, token_grid: null }),
        variantMode: "auto",
        manualClassSymbol: "",
      }),
    ).toBe(true);
  });

  test("stays not ready on checkpoint-load failure without a manual variant", () => {
    expect(
      isRfDetrInspectionReadyForExport({
        status: "failed",
        result: inspectFailure(),
        variantMode: "auto",
        manualClassSymbol: "",
      }),
    ).toBe(false);
  });

  test("manual variant selection makes a failed inspection exportable", () => {
    expect(
      isRfDetrInspectionReadyForExport({
        status: "failed",
        result: inspectFailure(),
        variantMode: "manual",
        manualClassSymbol: "RFDETRSmall",
      }),
    ).toBe(true);
  });

  test("stays not ready when success omits the variant (no fallback without known variant)", () => {
    expect(
      isRfDetrInspectionReadyForExport({
        status: "detected",
        result: inspectSuccess({ class_symbol: null }),
        variantMode: "auto",
        manualClassSymbol: "",
      }),
    ).toBe(false);
  });

  test("plus-only checkpoints stay blocked even with a manual variant", () => {
    const plus = inspectFailure({
      class_symbol: "RFDETRXLarge",
      requires_plus: true,
      error: "RFDETRXLarge requires rfdetr_plus support and is not supported in v1.",
    });
    expect(
      isRfDetrInspectionReadyForExport({
        status: "failed",
        result: plus,
        variantMode: "manual",
        manualClassSymbol: "RFDETRSmall",
      }),
    ).toBe(false);
    expect(
      isRfDetrInspectionReadyForExport({
        status: "failed",
        result: plus,
        variantMode: "auto",
        manualClassSymbol: "",
      }),
    ).toBe(false);
  });
});

describe("inspection failure actions (ticket 11)", () => {
  test("load failure offers retry, manual variant, and file action without guessed defaults", () => {
    const actions = getRfDetrInspectionFailureActions({ status: "failed", result: inspectFailure() });
    expect(actions.canRetry).toBe(true);
    expect(actions.showManualVariant).toBe(true);
    expect(actions.showFileAction).toBe(true);
  });

  test("plus-only blocks retry and manual bypass, keeps file action", () => {
    const plus = inspectFailure({
      class_symbol: "RFDETRXLarge",
      requires_plus: true,
      error: "RFDETRXLarge requires rfdetr_plus support and is not supported in v1.",
    });
    const actions = getRfDetrInspectionFailureActions({ status: "failed", result: plus });
    expect(actions.canRetry).toBe(false);
    expect(actions.showManualVariant).toBe(false);
    expect(actions.showFileAction).toBe(true);
  });

  test("successful inspection needs no failure actions", () => {
    const actions = getRfDetrInspectionFailureActions({ status: "detected", result: inspectSuccess() });
    expect(actions.canRetry).toBe(false);
    expect(actions.showManualVariant).toBe(false);
  });
});
