// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingScreen } from "@/features/landing-screen";
import type { UpdaterController } from "@/features/updater/use-updater-controller";
import {
  hasAllowedSourceExtension,
  providerList,
  providers,
} from "@/lib/providers";
import type { ExportOptions, RouteOptionsState } from "@/lib/types";
import {
  getInstallAndExportStrategy,
  getManagedEnvironmentCleanupState,
  getResolvedOutputDir,
  getRouteOptionsForOpen,
  resolveExportPython,
  resolveInitialWorkspaceSettings,
  resolveRouteDependencyCheckPython,
  validateSourceSelection,
} from "@/features/export/export-workspace";
import { createSetupTaskOwner } from "@/features/setup/setup-task";

// Ticket 12: Open the workspace without a global runtime.
// Get Started opens model upload regardless of provider environment inventory or legacy
// setup state. Provider setup happens only when the selected export requires it.

type InventoryCombo = "no-env" | "ultralytics-only" | "rfdetr-only" | "both";

const MANAGED_PYTHON = "/tmp/.venv/bin/python";
const STACK_PYTHON = "/tmp/runtime/envs/rfdetr-default/.venv/bin/python";

// Inventory snapshots are the only inputs readiness resolution consumes.
// Fresh launch (no settings file) and restart (persisted settings) produce
// the same snapshot shapes; the legacy setup flag lives only in settings and
// never reaches these readers.
function snapshotFor(combo: InventoryCombo) {
  switch (combo) {
    case "no-env":
      return { envPython: null as string | null, stackPython: null as string | null };
    case "ultralytics-only":
      return { envPython: MANAGED_PYTHON as string | null, stackPython: null as string | null };
    case "rfdetr-only":
      return { envPython: null as string | null, stackPython: STACK_PYTHON as string | null };
    case "both":
      return { envPython: MANAGED_PYTHON as string | null, stackPython: STACK_PYTHON as string | null };
  }
}

describe("workspace entry without global runtime (ticket 12)", () => {
  const stubUpdater = {} as UpdaterController;

  test("Get Started waits only for settings load, never provider inventory or setup state", () => {
    // LandingScreen takes no setup or inventory props, so entry cannot depend
    // on them by construction: only settingsReady gates the button.
    const waiting = renderToStaticMarkup(
      React.createElement(LandingScreen, {
        onGetStarted: () => {},
        settingsReady: false,
        updatesEnabled: false,
        updater: stubUpdater,
      }),
    );
    expect(waiting).toContain("Get Started");
    expect(waiting).toContain('disabled=""');

    const ready = renderToStaticMarkup(
      React.createElement(LandingScreen, {
        onGetStarted: () => {},
        settingsReady: true,
        updatesEnabled: false,
        updater: stubUpdater,
      }),
    );
    expect(ready).toContain("Get Started");
    expect(ready).not.toContain('disabled=""');
  });

  test("keeps explicit Ultralytics and RF-DETR provider choices", () => {
    expect(providerList().map((provider) => provider.id)).toEqual([
      "ultralytics",
      "rfdetr",
    ]);
  });
});

describe("model upload validation without global runtime (ticket 12)", () => {
  test("accepts matching extensions with the trimmed path", () => {
    expect(validateSourceSelection("  /tmp/best.pt  ", providers.ultralytics)).toEqual({
      status: "accepted",
      path: "/tmp/best.pt",
    });
    expect(validateSourceSelection("/tmp/checkpoint.pth", providers.rfdetr)).toEqual({
      status: "accepted",
      path: "/tmp/checkpoint.pth",
    });
  });

  test("rejects mismatched extensions with provider copy and no side effects", () => {
    expect(validateSourceSelection("/tmp/best.pth", providers.ultralytics)).toEqual({
      status: "rejected",
      error: "Ultralytics YOLO accepts .pt files only.",
    });
    expect(validateSourceSelection("/tmp/checkpoint.pt", providers.rfdetr)).toEqual({
      status: "rejected",
      error: "Roboflow RF-DETR accepts .pth files only.",
    });
  });

  test("ignores empty selection without an error", () => {
    expect(validateSourceSelection("   ", providers.ultralytics)).toEqual({ status: "empty" });
  });

  test("matches the provider registry for every combination", () => {
    expect(hasAllowedSourceExtension("/tmp/best.pt", providers.ultralytics)).toBe(true);
    expect(hasAllowedSourceExtension("/tmp/best.pth", providers.ultralytics)).toBe(false);
    expect(hasAllowedSourceExtension("/tmp/checkpoint.pth", providers.rfdetr)).toBe(true);
    expect(hasAllowedSourceExtension("/tmp/checkpoint.pt", providers.rfdetr)).toBe(false);
  });
});

describe("provider-independent readiness without global runtime (ticket 12)", () => {
  test("every provider-presence combination resolves without a global runtime", () => {
    const expectations: Record<InventoryCombo, { ultralytics: string | null; rfdetr: string | null }> = {
      "no-env": { ultralytics: null, rfdetr: "rfdetr.pth.onnx" },
      "ultralytics-only": { ultralytics: MANAGED_PYTHON, rfdetr: MANAGED_PYTHON },
      "rfdetr-only": { ultralytics: null, rfdetr: "rfdetr.pth.onnx" },
      both: { ultralytics: MANAGED_PYTHON, rfdetr: MANAGED_PYTHON },
    };
    for (const combo of Object.keys(expectations) as InventoryCombo[]) {
      const snapshot = snapshotFor(combo);
      const expected = expectations[combo];
      expect(
        resolveRouteDependencyCheckPython("ultralytics", snapshot.envPython, "ultralytics.pt.onnx"),
      ).toBe(expected.ultralytics);
      expect(
        resolveRouteDependencyCheckPython("rfdetr", snapshot.envPython, "rfdetr.pth.onnx"),
      ).toBe(expected.rfdetr);
    }
  });

  test("one missing provider never blocks the other provider's check", () => {
    expect(resolveRouteDependencyCheckPython("rfdetr", null, "rfdetr.pth.onnx")).not.toBeNull();
    expect(
      resolveRouteDependencyCheckPython("ultralytics", MANAGED_PYTHON, "ultralytics.pt.onnx"),
    ).not.toBeNull();
  });
});

describe("export python resolution without global runtime (ticket 12)", () => {
  test("every provider-presence combination resolves an export interpreter or fails closed", () => {
    const expectations: Record<InventoryCombo, { ultralytics: string | null; rfdetr: string | null }> = {
      "no-env": { ultralytics: null, rfdetr: "rfdetr.pth.onnx" },
      "ultralytics-only": { ultralytics: MANAGED_PYTHON, rfdetr: MANAGED_PYTHON },
      "rfdetr-only": { ultralytics: null, rfdetr: STACK_PYTHON },
      both: { ultralytics: MANAGED_PYTHON, rfdetr: STACK_PYTHON },
    };
    for (const combo of Object.keys(expectations) as InventoryCombo[]) {
      const snapshot = snapshotFor(combo);
      const expected = expectations[combo];
      expect(
        resolveExportPython("ultralytics", snapshot.envPython, snapshot.stackPython, "ultralytics.pt.onnx"),
      ).toBe(expected.ultralytics);
      expect(
        resolveExportPython("rfdetr", snapshot.envPython, snapshot.stackPython, "rfdetr.pth.onnx"),
      ).toBe(expected.rfdetr);
    }
  });

  test("RF-DETR export prefers the stack over the managed python", () => {
    expect(resolveExportPython("rfdetr", MANAGED_PYTHON, STACK_PYTHON, "rfdetr.pth.onnx")).toBe(
      STACK_PYTHON,
    );
  });
});

describe("install routing without global runtime (ticket 12)", () => {
  test("routes with nothing missing export directly for both providers", () => {
    expect(getInstallAndExportStrategy("ultralytics", 0, true)).toBe("export-direct");
    expect(getInstallAndExportStrategy("rfdetr", 0, false)).toBe("export-direct");
  });

  test("Ultralytics missing packages stream-install when its python exists", () => {
    expect(getInstallAndExportStrategy("ultralytics", 2, true)).toBe("stream-install");
  });

  test("Ultralytics missing packages delegate to route setup without a python", () => {
    // Previously a silent no-op dead end; route setup resolves a bootstrap
    // and owns the Python-required dialog instead.
    expect(getInstallAndExportStrategy("ultralytics", 2, false)).toBe("route-setup");
  });

  test("RF-DETR missing packages always delegate to route-owned setup", () => {
    // install_dependencies probes its python first, so a backend placeholder
    // would fail the probe and bypass the bootstrap + Python-required flow.
    expect(getInstallAndExportStrategy("rfdetr", 2, true)).toBe("route-setup");
    expect(getInstallAndExportStrategy("rfdetr", 2, false)).toBe("route-setup");
  });
});

describe("preserved workspace settings across migration (ticket 12)", () => {
  test("fresh launch restores empty settings", () => {
    expect(resolveInitialWorkspaceSettings(null)).toEqual({
      pythonOverride: "",
      outputDirOverride: "",
      outputDirInput: "",
      publishOverride: undefined,
    });
  });

  test("restart restores saved Python and output directory overrides", () => {
    expect(
      resolveInitialWorkspaceSettings({
        python_path_override: "/usr/local/bin/python3",
        output_dir_override: "/tmp/exports",
      }),
    ).toEqual({
      pythonOverride: "/usr/local/bin/python3",
      outputDirOverride: "/tmp/exports",
      outputDirInput: "/tmp/exports",
      publishOverride: "/usr/local/bin/python3",
    });
  });

  test("legacy setup state is readable but ignored on restart", () => {
    const withLegacy = (setupComplete: boolean) =>
      resolveInitialWorkspaceSettings({
        setup_complete: setupComplete,
        python_path_override: "/usr/local/bin/python3",
        output_dir_override: "/tmp/exports",
      });
    expect(withLegacy(true)).toEqual(withLegacy(false));
    expect(withLegacy(true).pythonOverride).toBe("/usr/local/bin/python3");
  });

  test("restart resolves per-combo settings identically regardless of legacy setup state", () => {
    // Fresh launch (null settings) and restart (persisted settings carrying
    // either legacy flag) meet at the same seam: if resolution ever branched
    // on setup_complete, these pairs diverge and fail.
    const restarts: Record<InventoryCombo, { python_path_override: string | null; output_dir_override: string | null }> = {
      "no-env": { python_path_override: null, output_dir_override: null },
      "ultralytics-only": { python_path_override: null, output_dir_override: "/tmp/exports" },
      "rfdetr-only": { python_path_override: "/usr/local/bin/python3", output_dir_override: null },
      both: { python_path_override: "/usr/local/bin/python3", output_dir_override: "/tmp/exports" },
    };
    for (const combo of Object.keys(restarts) as InventoryCombo[]) {
      const rest = restarts[combo];
      const fromComplete = resolveInitialWorkspaceSettings({ setup_complete: true, ...rest });
      const fromIncomplete = resolveInitialWorkspaceSettings({ setup_complete: false, ...rest });
      expect(fromComplete).toEqual(fromIncomplete);
      expect(fromComplete.pythonOverride).toBe(rest.python_path_override ?? "");
      expect(fromComplete.outputDirOverride).toBe(rest.output_dir_override ?? "");
    }
    expect(resolveInitialWorkspaceSettings(null).pythonOverride).toBe("");
  });

  test("blank overrides stay blank and never publish", () => {
    expect(
      resolveInitialWorkspaceSettings({ python_path_override: "   ", output_dir_override: null }),
    ).toEqual({
      pythonOverride: "   ",
      outputDirOverride: "",
      outputDirInput: "",
      publishOverride: undefined,
    });
  });

  test("output directory resolves next to either provider model without a global runtime", () => {
    expect(getResolvedOutputDir("/models/best.pt", "")).toBe("/models/vision-export-studio-exports");
    expect(getResolvedOutputDir("/models/checkpoint.pth", "")).toBe(
      "/models/vision-export-studio-exports",
    );
    expect(getResolvedOutputDir("/models/best.pt", "/tmp/exports")).toBe("/tmp/exports");
  });

  test("saved per-model options survive when the same model is reopened", () => {
    const sourcePath = "/tmp/model.pth";
    const saved: RouteOptionsState = {
      options: {
        imgsz: 640,
        batch: 1,
        precision: "fp16",
        calibrationData: null,
        dynamic: false,
        simplify: false,
        optimize: false,
        nms: false,
        endToEnd: false,
        keras: false,
        opset: null,
        workspace: null,
        chip: "rk3588",
      } satisfies ExportOptions,
      source: "user",
      sourcePath,
    };
    expect(getRouteOptionsForOpen(saved, "rfdetr.pth.onnx", "rfdetr", null, sourcePath)).toBe(saved);
  });
});

describe("no setup work on launch without global runtime (ticket 12)", () => {
  test("a fresh setup-task owner starts idle with no Python-required dialog", () => {
    const owner = createSetupTaskOwner({
      listenInstallEvent: async () => () => {},
      startInstall: async () => "session-1",
      verifyEnvironment: async () => ({ yoloPath: "/tmp/.venv/bin/yolo" }),
    });
    expect(owner.getState()).toBeNull();
    expect(owner.getPythonGate()).toEqual({
      pending: null,
      result: null,
      dialogOpen: false,
      choiceError: null,
      busy: false,
    });
  });
});

describe("cleanup stays in the workspace without global Setup (ticket 12)", () => {
  test("cleanup state no longer references Setup navigation", () => {
    const state = getManagedEnvironmentCleanupState({
      providerId: "ultralytics",
      ultralyticsExists: true,
      rfdetrCount: 0,
      hasPythonOverride: false,
    });
    expect("willReturnToSetup" in state).toBe(false);
    expect(state).toEqual({
      removesLastManagedRuntime: true,
      hasPythonOverride: false,
      isBulkCleanup: false,
    });
  });

  test("removing Ultralytics while RF-DETR remains keeps last-runtime accounting", () => {
    expect(
      getManagedEnvironmentCleanupState({
        providerId: "ultralytics",
        ultralyticsExists: true,
        rfdetrCount: 2,
        hasPythonOverride: false,
      }),
    ).toEqual({
      removesLastManagedRuntime: false,
      hasPythonOverride: false,
      isBulkCleanup: false,
    });
  });
});
