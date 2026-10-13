// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvCard,
  EnvironmentGroups,
  ProviderGroup,
  StackEnvironmentRow,
  StackEnvironmentCards,
  getRfdetrGroupStatus,
  getUltralyticsGroupStatus,
} from "./export-workspace";
import type { EnvironmentInfo, StackEnvironment } from "@/lib/types";

function render(version: string, status: "ok" | "warning" | "error" | "loading" = "ok") {
  return renderToStaticMarkup(
    React.createElement(EnvCard, { title: "Ultralytics", status, version }),
  );
}

describe("EnvCard version badge", () => {
  test("a normal version renders verbatim", () => {
    const html = render("8.4.115");
    expect(html).toContain("8.4.115");
  });

  test("a multi-line warning banner renders Unknown and hides the banner text", () => {
    const html = render("WARNING ⚠️ Ultralytics settings reset to default values.\n8.4.115");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("WARNING");
    expect(html).not.toContain("8.4.115");
  });

  test("an over-long single token renders Unknown", () => {
    const html = render("8.4.115.1-alpha.20260101.abcdefghijklmnopqrstuvwxyz0123456789");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("8.4.115.1-alpha");
  });

  test("not-found placeholders render unchanged", () => {
    expect(render("Not found", "error")).toContain("Not found");
    expect(render("Not installed", "warning")).toContain("Not installed");
    expect(render("...", "loading")).toContain("...");
  });

  test("not-installed placeholder does not collapse to Unknown", () => {
    const html = render("Not installed", "warning");
    expect(html).toContain("Not installed");
    expect(html).not.toContain("Unknown");
    expect(html).toContain("bg-amber-50");
    expect(html).toContain("border-l-amber-400");
  });

  test("an empty version renders Unknown", () => {
    expect(render("")).toContain("Unknown");
  });
});

describe("StackEnvironmentCards", () => {
  const stacks: StackEnvironment[] = [
    {
      key: "rfdetr-default",
      display_name: "RF-DETR",
      route_ids: ["rfdetr.pth.onnx", "rfdetr.pth.executorch"],
      python_path: "/tmp/runtime/envs/rfdetr-default/.venv/bin/python",
      python_version: { status: "available", version: "3.12.12" },
      rfdetr_version: { status: "available", version: "1.9.0" },
    },
  ];

  test("renders one card for each returned stack", () => {
    const html = renderToStaticMarkup(React.createElement(StackEnvironmentCards, { stacks }));
    expect(html).toContain("RF-DETR");
    expect(html).toContain("RF-DETR 1.9.0");
  });

  test("renders nothing when no stack environments exist", () => {
    expect(renderToStaticMarkup(React.createElement(StackEnvironmentCards, { stacks: [] }))).toBe("");
  });

  test("keeps paths visually truncated while exposing full path in title", () => {
    const html = renderToStaticMarkup(React.createElement(StackEnvironmentCards, { stacks, defaultExpanded: true }));
    expect(html).toContain('title="/tmp/runtime/envs/rfdetr-default/.venv/bin/python"');
    expect(html).toContain("truncate");
  });

  test("child row starts collapsed and keeps details hidden", () => {
    const html = renderToStaticMarkup(React.createElement(StackEnvironmentRow, { stack: stacks[0] }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("RF-DETR");
    expect(html).toContain("1.9.0");
    expect(html).not.toContain("3.12.12");
  });

  test("expanded child shows Python, path, status, and package error state", () => {
    const html = renderToStaticMarkup(
      React.createElement(StackEnvironmentRow, {
        stack: { ...stacks[0], rfdetr_version: { status: "unavailable" } },
        defaultExpanded: true,
      }),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("3.12.12");
    expect(html).toContain(stacks[0].python_path);
    expect(html).toContain("Unavailable");
    expect(html).toContain("Error");
  });
});

describe("provider groups", () => {
  const env: EnvironmentInfo = {
    python_path: "/tmp/.venv/bin/python",
    python_version: "3.12.12",
    ultralytics_version: "8.4.115",
    yolo_path: "/tmp/.venv/bin/yolo",
    status: "ok",
    warnings: [],
  };

  test("renders exactly two named groups collapsed by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentGroups, {
        envInfo: env,
        envError: null,
        redetecting: false,
        managedRuntimeUpgradeNudge: null,
        openManagedRuntimeUpgrade: () => {},
        mayStartRuntimeUpgrade: true,
        stacks: [],
      }),
    );
    expect((html.match(/Ultralytics YOLO/g) ?? []).length).toBe(1);
    expect((html.match(/Roboflow RF-DETR/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("0 installed · not set up");
    expect(html).not.toContain("0 installed · ready");
    expect(html).not.toContain(">3.12.12<");
    expect(html).not.toContain("No RF-DETR environments installed");
  });

  test("expanded group renders children and uses aria-expanded true", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ProviderGroup,
        { title: "Ultralytics YOLO", summary: "Ready", status: "ready", defaultExpanded: true },
        React.createElement("span", null, "Python details"),
      ),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Python details");
  });

  test("RF-DETR empty state has no phantom cards", () => {
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentGroups, {
        envInfo: env,
        envError: null,
        redetecting: false,
        managedRuntimeUpgradeNudge: null,
        openManagedRuntimeUpgrade: () => {},
        mayStartRuntimeUpgrade: true,
        stacks: [],
        defaultExpanded: true,
      }),
    );
    expect(html).toContain("No RF-DETR environments installed");
    expect(html).toContain("0 installed · not set up");
    expect(html).toContain("text-amber-500");
    expect(html).not.toContain("RF-DETR TensorRT");
  });

  test("confirmed absent Ultralytics runtime renders amber not-set-up state", () => {
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentGroups, {
        envInfo: null,
        envError: "no python",
        redetecting: false,
        managedRuntimeUpgradeNudge: null,
        openManagedRuntimeUpgrade: () => {},
        mayStartRuntimeUpgrade: true,
        stacks: [],
        defaultExpanded: true,
        managedEnvironmentSizes: {
          "ultralytics-managed": { key: "ultralytics-managed", status: "available", estimated_logical_bytes: 0, size_error: null, exists: false },
        },
      }),
    );
    expect(html).toContain("Not set up");
    // Each EnvCard renders the badge text plus a matching title attribute.
    expect((html.match(/>Not installed</g) ?? []).length).toBe(2);
    expect(html).toContain("Managed runtime not installed");
    expect(html).toContain("text-amber-500");
    expect(html).toContain("border-l-amber-400");
    expect(html).toContain("bg-amber-50");
    expect(html).not.toContain("text-red-500");
    expect(html).not.toContain("border-l-red-400");
    expect(html).not.toContain("bg-red-50");
  });

  test("genuine Ultralytics detection failure remains red error", () => {
    const healthyStack: StackEnvironment = {
      key: "rfdetr-default",
      display_name: "RF-DETR",
      route_ids: ["rfdetr.pth.onnx"],
      python_path: "/tmp/python",
      python_version: { status: "available", version: "3.12.12" },
      rfdetr_version: { status: "available", version: "1.9.0" },
    };
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentGroups, {
        envInfo: null,
        envError: "detect crashed",
        redetecting: false,
        managedRuntimeUpgradeNudge: null,
        openManagedRuntimeUpgrade: () => {},
        mayStartRuntimeUpgrade: true,
        stacks: [healthyStack],
        defaultExpanded: true,
        managedEnvironmentSizes: {
          "ultralytics-managed": { key: "ultralytics-managed", status: "available", estimated_logical_bytes: 10, size_error: null, exists: true },
        },
      }),
    );
    expect(getUltralyticsGroupStatus(null, "detect crashed", false, true)).toBe("error");
    expect(html).toContain("Error");
    expect(html).toContain("text-red-500");
    expect(html).toContain("border-l-red-400");
    expect(html).toContain("bg-red-50");
    expect(html).not.toContain("Not set up");
    expect(html).not.toContain("Not installed");
  });

  test("aggregate state reports loading, ready, partial, missing, and error", () => {
    expect(getUltralyticsGroupStatus(null, null, false)).toBe("loading");
    expect(getUltralyticsGroupStatus(env, null, false)).toBe("ready");
    expect(getUltralyticsGroupStatus({ ...env, status: "partial", ultralytics_version: "" }, null, false)).toBe("partial");
    expect(getUltralyticsGroupStatus({ ...env, status: "partial", yolo_path: "" }, null, false)).toBe("partial");
    // Unknown existence never confirms absence: backend missing/error and
    // detection failures stay red error without parsing strings.
    expect(getUltralyticsGroupStatus({ ...env, status: "missing", python_version: "", yolo_path: "" }, null, false)).toBe("error");
    expect(getUltralyticsGroupStatus({ ...env, status: "error" }, null, false)).toBe("error");
    expect(getUltralyticsGroupStatus(null, "detect failed", false)).toBe("error");
    expect(getUltralyticsGroupStatus(null, "detect failed", false, null)).toBe("error");
    expect(getUltralyticsGroupStatus(null, "detect failed", false, undefined)).toBe("error");
    expect(getUltralyticsGroupStatus({ ...env, status: "missing", python_version: "", yolo_path: "" }, null, false, true)).toBe("error");
    expect(getUltralyticsGroupStatus({ ...env, status: "error" }, null, false, true)).toBe("error");
    expect(getUltralyticsGroupStatus(null, "detect failed", false, true)).toBe("error");
    // Only exists === false confirms the absent state and wins over errors.
    expect(getUltralyticsGroupStatus(null, "detect failed", false, false)).toBe("missing");
    expect(getUltralyticsGroupStatus(null, null, false, false)).toBe("missing");
    expect(getUltralyticsGroupStatus({ ...env, status: "error" }, "detect failed", false, false)).toBe("missing");
  });

  test("RF-DETR empty state is missing rather than ready", () => {
    expect(getRfdetrGroupStatus([])).toBe("missing");
  });

  test("RF-DETR aggregate errors when any existing interpreter is unavailable", () => {
    const stack: StackEnvironment = {
      key: "rfdetr-default",
      display_name: "RF-DETR",
      route_ids: ["rfdetr.pth.onnx", "rfdetr.pth.executorch"],
      python_path: "/tmp/python",
      python_version: { status: "available", version: "3.12.12" },
      rfdetr_version: { status: "available", version: "1.9.0" },
    };
    expect(getRfdetrGroupStatus([stack])).toBe("ready");
    expect(getRfdetrGroupStatus([{ ...stack, python_version: { status: "unavailable" } }]))
      .toBe("error");
    expect(getRfdetrGroupStatus([{ ...stack, rfdetr_version: { status: "unavailable" } }]))
      .toBe("error");
  });
});
