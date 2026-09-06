// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { resolveRoutePython } from "@/features/export/export-workspace";

// Ticket 12: Open the workspace without a global runtime.
// Check and export calls share one argument rule: Ultralytics passes its
// managed python, while mapped RF-DETR routes pass the route id because both
// backend commands resolve the route's stack themselves. A missing
// Ultralytics environment therefore never blocks RF-DETR.

type InventoryCombo = "no-env" | "ultralytics-only" | "rfdetr-only" | "both";

const MANAGED_PYTHON = "/tmp/.venv/bin/python";

function envPythonFor(combo: InventoryCombo) {
  switch (combo) {
    case "no-env":
    case "rfdetr-only":
      return null as string | null;
    case "ultralytics-only":
    case "both":
      return MANAGED_PYTHON as string | null;
  }
}

describe("rfdetr independence without global runtime (ticket 12)", () => {
  test("every provider-presence combination resolves a route python or fails closed", () => {
    const expectations: Record<InventoryCombo, { ultralytics: string | null; rfdetr: string | null }> = {
      "no-env": { ultralytics: null, rfdetr: "rfdetr.pth.onnx" },
      "ultralytics-only": { ultralytics: MANAGED_PYTHON, rfdetr: "rfdetr.pth.onnx" },
      "rfdetr-only": { ultralytics: null, rfdetr: "rfdetr.pth.onnx" },
      both: { ultralytics: MANAGED_PYTHON, rfdetr: "rfdetr.pth.onnx" },
    };
    for (const combo of Object.keys(expectations) as InventoryCombo[]) {
      const envPython = envPythonFor(combo);
      const expected = expectations[combo];
      expect(resolveRoutePython("ultralytics", envPython, "ultralytics.pt.onnx")).toBe(
        expected.ultralytics,
      );
      expect(resolveRoutePython("rfdetr", envPython, "rfdetr.pth.onnx")).toBe(expected.rfdetr);
    }
  });

  test("one missing provider never blocks the other provider's route", () => {
    expect(resolveRoutePython("rfdetr", null, "rfdetr.pth.onnx")).toBe("rfdetr.pth.onnx");
    expect(resolveRoutePython("ultralytics", MANAGED_PYTHON, "ultralytics.pt.onnx")).toBe(
      MANAGED_PYTHON,
    );
  });
});
