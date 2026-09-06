// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  resolveExportPython,
  resolveRouteDependencyCheckPython,
} from "@/features/export/export-workspace";

// Ticket 12: Open the workspace without a global runtime.
// RF-DETR checks and exports resolve to the selected stack inside the
// backend, so a missing Ultralytics environment or system Python never
// blocks them. The backend ignores the placeholder for mapped RF-DETR
// routes; Ultralytics still requires its own managed python.

type InventoryCombo = "no-env" | "ultralytics-only" | "rfdetr-only" | "both";

const MANAGED_PYTHON = "/tmp/.venv/bin/python";
const STACK_PYTHON = "/tmp/runtime/envs/rfdetr-default/.venv/bin/python";

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

describe("rfdetr independence without global runtime (ticket 12)", () => {
  test("dependency checks resolve for every provider-presence combination", () => {
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

  test("exports resolve for every provider-presence combination or fail closed", () => {
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

  test("existing stack is preferred over the managed python", () => {
    expect(resolveExportPython("rfdetr", MANAGED_PYTHON, STACK_PYTHON, "rfdetr.pth.onnx")).toBe(
      STACK_PYTHON,
    );
  });
});
