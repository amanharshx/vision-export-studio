// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  hasAllowedSourceExtension,
  providerList,
  providers,
} from "@/lib/providers";
import { resolveWorkspaceEntryState } from "@/lib/workspace-entry";
import {
  getManagedEnvironmentCleanupState,
  resolveRfDetrExportPython,
  resolveRouteDependencyCheckPython,
} from "@/features/export/export-workspace";

// Ticket 12: Open the workspace without a global runtime.
// Get Started opens model upload regardless of provider inventory or legacy
// setup state. Provider setup happens only when the selected export requires it.

describe("workspace entry without global runtime (ticket 12)", () => {
  test("Get Started opens the workspace when no provider environment exists", () => {
    expect(resolveWorkspaceEntryState({ setupComplete: false })).toBe("export");
  });

  test("Get Started opens the workspace when legacy setup state claims complete", () => {
    expect(resolveWorkspaceEntryState({ setupComplete: true })).toBe("export");
  });

  test("restart with Ultralytics-only inventory still opens the workspace", () => {
    expect(
      resolveWorkspaceEntryState({
        setupComplete: true,
        ultralyticsExists: true,
        rfdetrCount: 0,
      }),
    ).toBe("export");
  });

  test("restart with RF-DETR-only inventory still opens the workspace", () => {
    expect(
      resolveWorkspaceEntryState({
        setupComplete: false,
        ultralyticsExists: false,
        rfdetrCount: 1,
      }),
    ).toBe("export");
  });

  test("restart with both providers still opens the workspace", () => {
    expect(
      resolveWorkspaceEntryState({
        setupComplete: true,
        ultralyticsExists: true,
        rfdetrCount: 2,
      }),
    ).toBe("export");
  });

  test("fresh launch with no settings still opens the workspace", () => {
    expect(resolveWorkspaceEntryState(null)).toBe("export");
    expect(resolveWorkspaceEntryState(undefined)).toBe("export");
  });
});

describe("provider choices without global runtime (ticket 12)", () => {
  test("keeps explicit Ultralytics and RF-DETR provider choices", () => {
    expect(providerList().map((provider) => provider.id)).toEqual([
      "ultralytics",
      "rfdetr",
    ]);
  });

  test("rejects mismatched extensions for both providers", () => {
    expect(hasAllowedSourceExtension("/tmp/best.pt", providers.ultralytics)).toBe(true);
    expect(hasAllowedSourceExtension("/tmp/best.pth", providers.ultralytics)).toBe(false);
    expect(hasAllowedSourceExtension("/tmp/checkpoint.pth", providers.rfdetr)).toBe(true);
    expect(hasAllowedSourceExtension("/tmp/checkpoint.pt", providers.rfdetr)).toBe(false);
  });
});

describe("provider-independent readiness without global runtime (ticket 12)", () => {
  test("Ultralytics check requires its own managed python", () => {
    expect(
      resolveRouteDependencyCheckPython("ultralytics", "/tmp/.venv/bin/python", "ultralytics.pt.onnx"),
    ).toBe("/tmp/.venv/bin/python");
    expect(
      resolveRouteDependencyCheckPython("ultralytics", null, "ultralytics.pt.onnx"),
    ).toBeNull();
  });

  test("RF-DETR check runs without the Ultralytics managed environment", () => {
    // Backend ignores the placeholder for RF-DETR routes (missing stack
    // reports missing packages; existing stack uses its own interpreter),
    // so a missing Ultralytics python must not block the check.
    expect(
      resolveRouteDependencyCheckPython("rfdetr", null, "rfdetr.pth.onnx"),
    ).toBe("rfdetr.pth.onnx");
    expect(
      resolveRouteDependencyCheckPython("rfdetr", "/tmp/.venv/bin/python", "rfdetr.pth.onnx"),
    ).toBe("/tmp/.venv/bin/python");
  });

  test("existing RF-DETR stack works without Ultralytics or system Python", () => {
    expect(
      resolveRfDetrExportPython(null, "/tmp/runtime/envs/rfdetr-default/.venv/bin/python", "rfdetr.pth.onnx"),
    ).toBe("/tmp/runtime/envs/rfdetr-default/.venv/bin/python");
  });

  test("RF-DETR export falls back to a backend-resolved placeholder without any python", () => {
    expect(resolveRfDetrExportPython(null, null, "rfdetr.pth.onnx")).toBe("rfdetr.pth.onnx");
  });

  test("one missing provider never blocks the other provider's check", () => {
    // No Ultralytics env, RF-DETR stack present: RF-DETR check proceeds.
    expect(resolveRouteDependencyCheckPython("rfdetr", null, "rfdetr.pth.onnx")).not.toBeNull();
    // No RF-DETR stacks, Ultralytics env present: Ultralytics check proceeds.
    expect(
      resolveRouteDependencyCheckPython("ultralytics", "/tmp/.venv/bin/python", "ultralytics.pt.onnx"),
    ).not.toBeNull();
  });
});

describe("cleanup stays in the workspace without global Setup (ticket 12)", () => {
  test("removing Ultralytics never returns to Setup, even for the last runtime", () => {
    expect(
      getManagedEnvironmentCleanupState({
        providerId: "ultralytics",
        ultralyticsExists: true,
        rfdetrCount: 0,
        hasPythonOverride: false,
      }).willReturnToSetup,
    ).toBe(false);
  });

  test("removing Ultralytics while RF-DETR remains never returns to Setup", () => {
    expect(
      getManagedEnvironmentCleanupState({
        providerId: "ultralytics",
        ultralyticsExists: true,
        rfdetrCount: 2,
        hasPythonOverride: false,
      }).willReturnToSetup,
    ).toBe(false);
  });
});
