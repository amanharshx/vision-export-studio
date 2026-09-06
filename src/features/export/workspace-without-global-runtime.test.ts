// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "@/App";
import { LandingScreen } from "@/features/landing-screen";
import type { UpdaterController } from "@/features/updater/use-updater-controller";
import { providerList, providers } from "@/lib/providers";
import {
  getManagedEnvironmentCleanupState,
  resolveExportPython,
  resolveInitialWorkspaceSettings,
  resolveRouteDependencyCheckPython,
  validateSourceSelection,
} from "@/features/export/export-workspace";

// Ticket 12: Open the workspace without a global runtime.
// Get Started opens model upload regardless of provider inventory or legacy
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
  test("launch opens Get Started with no Setup screen", () => {
    const html = renderToStaticMarkup(React.createElement(App, null));
    expect(html).toContain("Get Started");
    expect(html).not.toContain("Set up Vision Export Studio");
  });

  test("Get Started waits only for settings load, never setup state", () => {
    // LandingScreen takes no setup or inventory props, so entry cannot depend
    // on them by construction: only settingsReady gates the button.
    const stubUpdater = {} as UpdaterController;
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

  test("every combination resolves an export interpreter or fails closed", () => {
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
