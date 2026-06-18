// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { buildDependencyItems, sortDependencyItems, type DepItem } from "./dependency-panel";
import { providers, routesForProvider } from "@/lib/providers";
import { getUltralyticsRuntimeReadyDescription } from "./export-workspace";
import type { DepCheckResult } from "@/lib/types";

describe("buildDependencyItems", () => {
  test("includes ultralytics base dependency for ultralytics routes", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.torchscript");
    expect(route).toBeDefined();

    const items = buildDependencyItems(providers.ultralytics, route!);

    expect(items.map((item) => item.name)).toContain("ultralytics");
  });
});

describe("sortDependencyItems", () => {
  test("sorts dependencies as installed, required, manual, optional", () => {
    const depItems: DepItem[] = [
      { name: "optional_pkg", installHint: "pip install optional_pkg", optional: true },
      { name: "manual_tool", installHint: "install manual tool", optional: false },
      { name: "required_pkg", installHint: "pip install required_pkg", optional: false },
      { name: "installed_pkg", installHint: "pip install installed_pkg", optional: false },
    ];
    const depResults: DepCheckResult[] = [
      {
        item: "installed_pkg",
        status: "ready",
        reason: "",
        install_hint: "pip install installed_pkg",
      },
      {
        item: "required_pkg",
        status: "missing_package",
        reason: "missing",
        install_hint: "pip install required_pkg",
      },
      {
        item: "manual_tool",
        status: "missing_binary",
        reason: "missing",
        install_hint: "install manual tool",
      },
      {
        item: "optional_pkg",
        status: "warning",
        reason: "optional",
        install_hint: "pip install optional_pkg",
      },
    ];

    const sorted = sortDependencyItems(depItems, depResults);

    expect(sorted.map((item) => item.name)).toEqual([
      "installed_pkg",
      "required_pkg",
      "manual_tool",
      "optional_pkg",
    ]);
  });
});

describe("getUltralyticsRuntimeReadyDescription", () => {
  test("describes runtime readiness as machine-scoped instead of session-scoped", () => {
    expect(getUltralyticsRuntimeReadyDescription()).toBe("YOLO export targets are enabled on this machine.");
  });
});
