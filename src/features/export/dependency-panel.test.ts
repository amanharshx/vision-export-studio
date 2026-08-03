// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDependencyItems, DependencyPanel, depGroup, depIcon, sortDependencyItems, type DepItem } from "./dependency-panel";
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

  test("LiteRT panel lists LiteRT packages and not TensorFlow/onnx2tf", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.litert");
    expect(route).toBeDefined();

    const items = buildDependencyItems(providers.ultralytics, route!);
    const names = items.map((item) => item.name);

    expect(names).toContain("litert-torch>=0.9.0");
    expect(names).toContain("ai-edge-litert>=2.1.4");
    expect(names).not.toContain("tensorflow");
    expect(names).not.toContain("onnx2tf");
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

describe("version_too_old preflight results", () => {
  const pythonBlocker: DepCheckResult = {
    item: "Python 3.10+",
    status: "version_too_old",
    reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
    install_hint: "Install/select Python 3.10 or newer...",
  };

  const outdatedUltralytics: DepCheckResult = {
    item: "ultralytics",
    status: "version_too_old",
    reason: "Ultralytics 8.4.79 is installed; 8.4.80 or newer is required.",
    install_hint: 'pip install "ultralytics>=8.4.80"',
    install_package: "ultralytics>=8.4.80",
  };

  test("appends unmatched version_too_old results as extra rows", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.litert");
    expect(route).toBeDefined();

    const items = buildDependencyItems(providers.ultralytics, route!, [pythonBlocker, outdatedUltralytics]);
    const names = items.map((item) => item.name);

    expect(names).toContain("Python 3.10+");
    expect(names.filter((name) => name === "ultralytics")).toHaveLength(1);
  });

  test("python floor blocker is manual remediation (group 2)", () => {
    expect(
      depGroup({ name: "Python 3.10+", installHint: pythonBlocker.install_hint, optional: false }, pythonBlocker),
    ).toBe(2);
  });

  test("python floor blocker renders manual/error icon", () => {
    const html = renderToStaticMarkup(
      depIcon(pythonBlocker, pythonBlocker.install_hint) as React.ReactElement,
    );
    expect(html).toContain("Manual install required");
  });

  test("outdated ultralytics is auto-installable (group 1)", () => {
    expect(
      depGroup({ name: "ultralytics", installHint: outdatedUltralytics.install_hint, optional: false }, outdatedUltralytics),
    ).toBe(1);
  });

  test("outdated ultralytics renders auto-installable icon", () => {
    const html = renderToStaticMarkup(
      depIcon(outdatedUltralytics, outdatedUltralytics.install_hint) as React.ReactElement,
    );
    expect(html).toContain("Will be installed");
  });
});

describe("DependencyPanel", () => {
  test("old ultralytics renders backend reason and pinned install command", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx");
    expect(route).toBeDefined();

    const outdatedUltralytics: DepCheckResult = {
      item: "ultralytics",
      status: "version_too_old",
      reason: "Ultralytics 8.4.72 is installed; 8.4.80 or newer is required.",
      install_hint: 'pip install "ultralytics>=8.4.80"',
      install_package: "ultralytics>=8.4.80",
    };

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
        depResults: [outdatedUltralytics],
      }),
    );

    expect(html).toContain("Ultralytics 8.4.72 is installed; 8.4.80 or newer is required.");
    expect(html).toContain("pip install &quot;ultralytics&gt;=8.4.80&quot;");
    expect(html).not.toContain("pip install ultralytics");
  });

  test("missing_package keeps static hint and hides find_spec diagnostics", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx");
    expect(route).toBeDefined();

    const missingOnnx: DepCheckResult = {
      item: "onnx",
      status: "missing_package",
      reason: "importlib.util.find_spec('onnx') returned False",
      install_hint: "pip install onnx",
      install_package: "onnx",
    };

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
        depResults: [missingOnnx],
      }),
    );

    expect(html).toContain("pip install onnx");
    expect(html).not.toContain("find_spec");
  });

  test("warning keeps static hint and hides optional diagnostics", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx");
    expect(route).toBeDefined();

    const optionalOnnxslim: DepCheckResult = {
      item: "onnxslim",
      status: "warning",
      reason: "optional: improves model portability",
      install_hint: "pip install onnxslim",
    };

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
        depResults: [optionalOnnxslim],
      }),
    );

    expect(html).toContain("pip install onnxslim");
    expect(html).not.toContain("improves model portability");
  });
});

describe("unchecked dependencies after preflight short-circuit", () => {
  const pythonBlocker: DepCheckResult = {
    item: "Python 3.10+",
    status: "version_too_old",
    reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
    install_hint: "Install/select Python 3.10 or newer, then re-detect the environment.",
  };

  const platformUnsupported: DepCheckResult = {
    item: "platform",
    status: "platform_unsupported",
    reason: "LiteRT export is not supported on this operating system.",
    install_hint: "LiteRT export is not supported on this operating system.",
  };

  test("single version_too_old python result hides unchecked declared rows", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.litert");
    expect(route).toBeDefined();

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
        depResults: [pythonBlocker],
      }),
    );

    expect(html).toContain("Python 3.10+");
    expect(html).toContain("Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.");
    expect(html).not.toContain("ultralytics");
  });

  test("single platform_unsupported result renders only that row", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx");
    expect(route).toBeDefined();

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
        depResults: [platformUnsupported],
      }),
    );

    expect(html).toContain("platform");
    expect(html).toContain("LiteRT export is not supported on this operating system.");
    expect(html).not.toContain("ultralytics");
    expect(html).not.toContain("onnx");
  });

  test("undefined depResults keeps all declared rows (loading)", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx");
    expect(route).toBeDefined();

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
      }),
    );

    expect(html).toContain("ultralytics");
    expect(html).toContain("onnx");
    expect(html).toContain("onnxslim");
  });

  test("depResults covering every declared dep renders all rows", () => {
    const route = routesForProvider("ultralytics").find((item) => item.id === "ultralytics.pt.onnx");
    expect(route).toBeDefined();

    const fullResults: DepCheckResult[] = [
      { item: "ultralytics", status: "ready", reason: "", install_hint: "pip install ultralytics" },
      { item: "onnx", status: "ready", reason: "", install_hint: "pip install onnx" },
      {
        item: "onnxslim",
        status: "warning",
        reason: "optional: improves model portability",
        install_hint: "pip install onnxslim",
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(DependencyPanel, {
        provider: providers.ultralytics,
        route: route!,
        depResults: fullResults,
      }),
    );

    expect(html).toContain("ultralytics");
    expect(html).toContain("onnx");
    expect(html).toContain("onnxslim");
  });
});
