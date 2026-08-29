// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatManagedEnvironmentSize,
  isManagedEnvironmentCleanupAllowed,
  mergeManagedEnvironmentScanResults,
  invalidateManagedEnvironmentSizes,
  isManagedEnvironmentCleanupBlocked,
  shouldApplyManagedEnvironmentScan,
  shouldSkipEnvironmentRedetection,
  clearCalculatingManagedEnvironmentScan,
  managedEnvironmentCacheKeysForCleanup,
  applyManagedEnvironmentSizeMutation,
  managedEnvironmentCleanupErrorMessage,
  managedEnvironmentDeletionSucceeded,
  getManagedEnvironmentCleanupSetupAction,
  applyManagedEnvironmentCleanupSetup,
  managedEnvironmentKeysForProvider,
  getManagedEnvironmentCleanupState,
  EnvironmentGroups,
} from "./export-workspace";
import type { ManagedEnvironmentCleanupReport, ManagedEnvironmentScanResult } from "@/lib/types";

const env = {
  python_path: "/tmp/.venv/bin/python",
  python_version: "3.12.12",
  ultralytics_version: "8.4.115",
  yolo_path: "/tmp/.venv/bin/yolo",
  status: "ok" as const,
  warnings: [],
};
const stack = {
  key: "rfdetr-default",
  route_ids: ["rfdetr.pth.onnx", "rfdetr.pth.executorch"],
  display_name: "RF-DETR",
  python_path: "/tmp/python",
  python_version: { status: "available" as const, version: "3.12.12" },
  rfdetr_version: { status: "available" as const, version: "1.9.0" },
};

describe("managed environment cleanup helpers", () => {
  test("maps providers to their managed environment keys", () => {
    expect(managedEnvironmentKeysForProvider("ultralytics")).toEqual(["ultralytics-managed"]);
    expect(managedEnvironmentKeysForProvider("rfdetr")).toEqual(["rfdetr-all"]);
    expect(managedEnvironmentKeysForProvider("rfdetr", "rfdetr-coreml")).toEqual(["rfdetr-coreml"]);
  });

  test("derives last-runtime state for Ultralytics without override", () => {
    expect(getManagedEnvironmentCleanupState({ providerId: "ultralytics", ultralyticsExists: true, rfdetrCount: 0, hasPythonOverride: false }))
      .toEqual({ removesLastManagedRuntime: true, willReturnToSetup: true, hasPythonOverride: false, isBulkCleanup: false });
  });

  test("keeps override active when removing last managed runtime", () => {
    expect(getManagedEnvironmentCleanupState({ providerId: "ultralytics", ultralyticsExists: true, rfdetrCount: 0, hasPythonOverride: true }))
      .toEqual({ removesLastManagedRuntime: true, willReturnToSetup: false, hasPythonOverride: true, isBulkCleanup: false });
  });

  test("Ultralytics returns to Setup even while RF-DETR remains", () => {
    expect(getManagedEnvironmentCleanupState({ providerId: "ultralytics", ultralyticsExists: true, rfdetrCount: 2, hasPythonOverride: false }).willReturnToSetup).toBe(true);
  });

  test("marks RF-DETR bulk cleanup and last-runtime state", () => {
    expect(getManagedEnvironmentCleanupState({ providerId: "rfdetr", ultralyticsExists: false, rfdetrCount: 2, hasPythonOverride: false }))
      .toEqual({ removesLastManagedRuntime: true, willReturnToSetup: false, hasPythonOverride: false, isBulkCleanup: true });
  });

  test("does not treat unknown Ultralytics presence as absent", () => {
    const state = getManagedEnvironmentCleanupState({ providerId: "rfdetr", ultralyticsExists: null, rfdetrCount: 1, hasPythonOverride: false });
    expect(state.removesLastManagedRuntime).toBe(false);
    expect(state.willReturnToSetup).toBe(false);
  });

  test("last RF-DETR runtime with override keeps override active", () => {
    expect(getManagedEnvironmentCleanupState({ providerId: "rfdetr", singleKey: "rfdetr-coreml", ultralyticsExists: false, rfdetrCount: 1, hasPythonOverride: true }))
      .toEqual({ removesLastManagedRuntime: true, willReturnToSetup: false, hasPythonOverride: true, isBulkCleanup: false });
  });
  test("formats bytes, MiB, and GiB at readable boundaries", () => {
    expect(formatManagedEnvironmentSize(512)).toBe("512 B");
    expect(formatManagedEnvironmentSize(1024 * 1024)).toBe("1 MiB");
    expect(formatManagedEnvironmentSize(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GiB");
  });

  test("applies one setup callback for each trustworthy reset outcome", () => {
    const states: Array<{ complete: boolean; error?: string }> = [];
    const report: ManagedEnvironmentCleanupReport = {
      results: [{ status: "succeeded", key: "ultralytics-managed", estimated_logical_bytes: 1 }],
      setup_complete: false,
      setup_error: "failed to write settings",
    };
    expect(applyManagedEnvironmentCleanupSetup(report, (complete, error) => states.push({ complete, error })))
      .toEqual({ setupComplete: false, redetect: false });
    expect(states).toEqual([{ complete: false, error: "failed to write settings" }]);
    const exportReport = { ...report, setup_complete: true as const, setup_error: null };
    expect(applyManagedEnvironmentCleanupSetup(exportReport, (complete, error) => states.push({ complete, error })))
      .toEqual({ setupComplete: true, redetect: true });
    expect(states).toEqual([
      { complete: false, error: "failed to write settings" },
      { complete: true, error: undefined },
    ]);
  });

  test("unknown-size cleanup remains confirmable and explains the failed calculation", () => {
    expect(isManagedEnvironmentCleanupAllowed({
      key: "rfdetr-all",
      status: "unavailable",
      estimated_logical_bytes: null,
      size_error: "permission denied", exists: null,
    })).toBe(true);
  });

  test("command-level scan failure has no cleanup candidate to confirm", () => {
    expect(isManagedEnvironmentCleanupAllowed(undefined)).toBe(false);
  });

  test("calculating child scans render Calculating instead of not scanned", () => {
    const stack = {
      key: "rfdetr-default",
      route_ids: ["rfdetr.pth.onnx", "rfdetr.pth.executorch"],
      display_name: "RF-DETR",
      python_path: "/tmp/python",
      python_version: { status: "available" as const, version: "3.12.12" },
      rfdetr_version: { status: "available" as const, version: "1.9.0" },
    };
    const html = renderToStaticMarkup(React.createElement(EnvironmentGroups, {
      envInfo: env,
      envError: null,
      redetecting: false,
      managedRuntimeUpgradeNudge: null,
      openManagedRuntimeUpgrade: () => {},
      mayStartRuntimeUpgrade: true,
      stacks: [stack],
      defaultExpanded: true,
      managedEnvironmentSizes: {
        "rfdetr-default": { key: "rfdetr-default", status: "calculating", estimated_logical_bytes: null, size_error: null, exists: null },
      },
    }));
    expect(html).toContain("Calculating size…");
    expect((html.match(/Calculating size…/g) ?? []).length).toBe(2);
  });

  test("empty RF-DETR group shows only empty state", () => {
    const html = renderToStaticMarkup(React.createElement(EnvironmentGroups, {
      envInfo: env,
      envError: null,
      redetecting: false,
      managedRuntimeUpgradeNudge: null,
      openManagedRuntimeUpgrade: () => {},
      mayStartRuntimeUpgrade: true,
      stacks: [],
      defaultExpanded: true,
    }));
    expect(html).toContain("No RF-DETR environments installed");
    expect(html).not.toContain("Remove all");
    expect(html).not.toContain("Approx. size");
    expect(html).not.toContain("Size unavailable");
  });

  test("missing Ultralytics runtime hides reset and shows absent state", () => {
    const html = renderToStaticMarkup(React.createElement(EnvironmentGroups, {
      envInfo: null,
      envError: null,
      redetecting: false,
      managedRuntimeUpgradeNudge: null,
      openManagedRuntimeUpgrade: () => {},
      mayStartRuntimeUpgrade: true,
      stacks: [],
      defaultExpanded: true,
      managedEnvironmentSizes: {
        "ultralytics-managed": { key: "ultralytics-managed", status: "available", estimated_logical_bytes: 0, size_error: null, exists: false },
      },
    }));
    expect(html).toContain("Managed runtime not installed");
    expect(html).not.toContain("Reset runtime");
  });

  test("available size with null bytes renders unavailable, never 0 B", () => {
    const html = renderToStaticMarkup(React.createElement(EnvironmentGroups, {
      envInfo: env,
      envError: null,
      redetecting: false,
      managedRuntimeUpgradeNudge: null,
      openManagedRuntimeUpgrade: () => {},
      mayStartRuntimeUpgrade: true,
      stacks: [stack],
      defaultExpanded: true,
      managedEnvironmentSizes: {
        "rfdetr-default": { key: "rfdetr-default", status: "available", estimated_logical_bytes: null, size_error: null, exists: null },
      },
    }));
    expect(html).toContain("Size unavailable");
    expect(html).not.toContain("Approx. size: 0 B");
  });

  test("merges scan rows without replacing successful cached rows with calculating state", () => {
    const existing: Record<string, ManagedEnvironmentScanResult> = {
      "rfdetr-default": { key: "rfdetr-default", status: "available", estimated_logical_bytes: 42, size_error: null, exists: true },
    };
    const next = mergeManagedEnvironmentScanResults(existing, [
      { key: "rfdetr-default", status: "calculating", estimated_logical_bytes: null, size_error: null, exists: null },
      { key: "rfdetr-coreml", status: "available", estimated_logical_bytes: 7, size_error: null, exists: true },
    ]);
    expect(next["rfdetr-default"].status).toBe("available");
    expect(next["rfdetr-default"].estimated_logical_bytes).toBe(42);
    expect(next["rfdetr-coreml"].estimated_logical_bytes).toBe(7);
  });

  test("targeted mutation invalidation removes unrelated calculating rows", () => {
    const state = {
      generation: 4,
      sizes: {
        "ultralytics-managed": { key: "ultralytics-managed", status: "available" as const, estimated_logical_bytes: 10, size_error: null },
        "rfdetr-default": { key: "rfdetr-default", status: "calculating" as const, estimated_logical_bytes: null, size_error: null },
      },
    };
    const next = applyManagedEnvironmentSizeMutation(state, ["ultralytics-managed"]);
    expect(next.generation).toBe(5);
    expect(next.sizes).toEqual({});
  });


  test("clears size estimates after an environment mutation", () => {
    const current: Record<string, ManagedEnvironmentScanResult> = {
      "ultralytics-managed": { key: "ultralytics-managed", status: "available", estimated_logical_bytes: 10, size_error: null },
      "rfdetr-default": { key: "rfdetr-default", status: "available", estimated_logical_bytes: 20, size_error: null },
    };
    expect(invalidateManagedEnvironmentSizes(current, ["ultralytics-managed"])).toEqual({
      "rfdetr-default": current["rfdetr-default"],
    });
  });

  test("fails closed for a successful reset with an untrustworthy setup report", () => {
    expect(getManagedEnvironmentCleanupSetupAction({
      results: [{ status: "succeeded", key: "ultralytics-managed", estimated_logical_bytes: 1 }],
      setup_complete: null,
      setup_error: "failed to write settings",
    })).toEqual({ setupComplete: false, redetect: false });
    expect(getManagedEnvironmentCleanupSetupAction({
      results: [{ status: "succeeded", key: "ultralytics-managed", estimated_logical_bytes: 1 }],
      setup_complete: null,
      setup_error: null,
    })).toEqual({ setupComplete: false, redetect: false });
  });

  test("allows the post-cleanup environment refresh while cleanup state is still busy", () => {
    expect(shouldSkipEnvironmentRedetection(true)).toBe(true);
    expect(shouldSkipEnvironmentRedetection(true, true)).toBe(false);
  });

  test("blocks cleanup while any runtime operation is active", () => {
    const base = {
      cleanupBusy: false,
      exportStatus: "idle" as const,
      installPhase: "idle" as const,
      runtimeInstallPhase: "idle" as const,
      managedRuntimeRebuilding: false,
      redetecting: false,
    };
    expect(isManagedEnvironmentCleanupBlocked(base)).toBe(false);
    expect(isManagedEnvironmentCleanupBlocked({ ...base, exportStatus: "running" })).toBe(true);
    expect(isManagedEnvironmentCleanupBlocked({ ...base, installPhase: "installing" })).toBe(true);
    expect(isManagedEnvironmentCleanupBlocked({ ...base, runtimeInstallPhase: "installing" })).toBe(true);
    expect(isManagedEnvironmentCleanupBlocked({ ...base, managedRuntimeRebuilding: true })).toBe(true);
    expect(isManagedEnvironmentCleanupBlocked({ ...base, cleanupBusy: true })).toBe(true);
    expect(isManagedEnvironmentCleanupBlocked({ ...base, redetecting: true })).toBe(true);
  });

  test("ignores scan completions from before a mutation", () => {
    expect(shouldApplyManagedEnvironmentScan(3, 3)).toBe(true);
    expect(shouldApplyManagedEnvironmentScan(2, 3)).toBe(false);
  });

  test("clears only stuck calculating rows after a command-level scan failure", () => {
    const current: Record<string, ManagedEnvironmentScanResult> = {
      "rfdetr-default": { key: "rfdetr-default", status: "calculating", estimated_logical_bytes: null, size_error: null },
      "rfdetr-coreml": { key: "rfdetr-coreml", status: "calculating", estimated_logical_bytes: null, size_error: null },
      "rfdetr-tensorrt": { key: "rfdetr-tensorrt", status: "available", estimated_logical_bytes: 42, size_error: null },
    };
    const cleared = clearCalculatingManagedEnvironmentScan(current, ["rfdetr-default", "rfdetr-coreml", "rfdetr-tensorrt"]);
    // Stuck calculating rows are dropped so cards leave the "Calculating…" state.
    expect(cleared["rfdetr-default"]).toBeUndefined();
    expect(cleared["rfdetr-coreml"]).toBeUndefined();
    // Already-resolved rows are preserved.
    expect(cleared["rfdetr-tensorrt"]).toEqual(current["rfdetr-tensorrt"]);
    // Original state is not mutated.
    expect(current["rfdetr-default"].status).toBe("calculating");
  });

  test("partial rfdetr-all deletion reports exact failures and refreshes surviving cards", () => {
    const report: ManagedEnvironmentCleanupReport = {
      results: [
        { status: "succeeded", key: "rfdetr-default", estimated_logical_bytes: 100 },
        { status: "failed", key: "rfdetr-coreml", error: "permission denied" },
      ],
      setup_complete: null,
      setup_error: null,
    };
    // Only the failing environment is named; the succeeded one is not.
    const message = managedEnvironmentCleanupErrorMessage(report);
    expect(message).toBe("Some environments could not be removed: rfdetr-coreml: permission denied");
    expect(message).not.toContain("rfdetr-default");
    expect(managedEnvironmentDeletionSucceeded(report, "rfdetr-default")).toBe(true);
    expect(managedEnvironmentDeletionSucceeded(report, "rfdetr-coreml")).toBe(false);

    // Surviving-card refresh: rfdetr-all fans out to every stack key so their
    // size caches are dropped and the cards re-scan.
    const stackKeys = ["rfdetr-default", "rfdetr-coreml", "rfdetr-tensorrt"];
    const cacheKeys = managedEnvironmentCacheKeysForCleanup(["rfdetr-all"], stackKeys);
    expect(cacheKeys).toEqual(expect.arrayContaining(["rfdetr-all", ...stackKeys]));
    const sizes: Record<string, ManagedEnvironmentScanResult> = {
      "rfdetr-default": { key: "rfdetr-default", status: "available", estimated_logical_bytes: 100, size_error: null },
      "rfdetr-coreml": { key: "rfdetr-coreml", status: "available", estimated_logical_bytes: 5, size_error: null },
      "rfdetr-tensorrt": { key: "rfdetr-tensorrt", status: "available", estimated_logical_bytes: 7, size_error: null },
    };
    const mutated = applyManagedEnvironmentSizeMutation({ generation: 2, sizes }, cacheKeys);
    expect(mutated.sizes).toEqual({});
  });

  test("cleanup surfaces a separate setup-state persistence failure honestly", () => {
    // Deletion succeeded but setup state could not be saved: report both the
    // success (via deletion detection) and the persistence failure.
    const report: ManagedEnvironmentCleanupReport = {
      results: [{ status: "succeeded", key: "ultralytics-managed", estimated_logical_bytes: 2048 }],
      setup_complete: null,
      setup_error: "failed to write settings",
    };
    expect(managedEnvironmentDeletionSucceeded(report, "ultralytics-managed")).toBe(true);
    expect(managedEnvironmentCleanupErrorMessage(report)).toBe(
      "Environment removed, but saving setup state failed: failed to write settings",
    );
  });

  test("cleanup with both deletion and setup-state failures combines messages", () => {
    const report: ManagedEnvironmentCleanupReport = {
      results: [{ status: "failed", key: "ultralytics-managed", error: "still exists" }],
      setup_complete: null,
      setup_error: "disk full",
    };
    expect(managedEnvironmentCleanupErrorMessage(report)).toBe(
      "Some environments could not be removed: ultralytics-managed: still exists Environment removed, but saving setup state failed: disk full",
    );
  });

  test("fully successful cleanup produces no error message", () => {
    const report: ManagedEnvironmentCleanupReport = {
      results: [{ status: "succeeded", key: "ultralytics-managed", estimated_logical_bytes: 10 }],
      setup_complete: true,
      setup_error: null,
    };
    expect(managedEnvironmentCleanupErrorMessage(report)).toBeNull();
  });

  test("mutation invalidation is the shared mechanism after install, rebuild, and deletion", () => {
    const sizes: Record<string, ManagedEnvironmentScanResult> = {
      "ultralytics-managed": { key: "ultralytics-managed", status: "available", estimated_logical_bytes: 10, size_error: null },
      "rfdetr-default": { key: "rfdetr-default", status: "available", estimated_logical_bytes: 20, size_error: null },
      "rfdetr-coreml": { key: "rfdetr-coreml", status: "available", estimated_logical_bytes: 30, size_error: null },
    };

    // Ultralytics runtime install invalidates only the ultralytics key and bumps generation.
    const afterInstall = applyManagedEnvironmentSizeMutation({ generation: 0, sizes }, ["ultralytics-managed"]);
    expect(afterInstall.generation).toBe(1);
    expect(afterInstall.sizes["ultralytics-managed"]).toBeUndefined();
    expect(afterInstall.sizes["rfdetr-default"]).toEqual(sizes["rfdetr-default"]);

    // Route install / managed runtime rebuild clears every cached size.
    const afterRebuild = applyManagedEnvironmentSizeMutation({ generation: 5, sizes }, undefined);
    expect(afterRebuild.generation).toBe(6);
    expect(afterRebuild.sizes).toEqual({});

    // Deletion of rfdetr-all clears every fanned-out stack key.
    const cacheKeys = managedEnvironmentCacheKeysForCleanup(["rfdetr-all"], ["rfdetr-default", "rfdetr-coreml"]);
    const afterDeletion = applyManagedEnvironmentSizeMutation({ generation: 9, sizes }, cacheKeys);
    expect(afterDeletion.generation).toBe(10);
    expect(afterDeletion.sizes["rfdetr-default"]).toBeUndefined();
    expect(afterDeletion.sizes["rfdetr-coreml"]).toBeUndefined();
    // Bumped generation makes any in-flight scan from before the mutation stale.
    expect(shouldApplyManagedEnvironmentScan(9, afterDeletion.generation)).toBe(false);
  });

  test("ultralytics deletion cache invalidation only affects the ultralytics key", () => {
    const cacheKeys = managedEnvironmentCacheKeysForCleanup(["ultralytics-managed"], ["rfdetr-default", "rfdetr-coreml"]);
    expect(cacheKeys).toEqual(["ultralytics-managed"]);
  });
});
