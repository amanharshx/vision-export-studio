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

function render(version: string, status: "ok" | "error" | "loading" = "ok") {
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
    expect(render("...", "loading")).toContain("...");
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
    expect(html).toContain("0 installed · ready");
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
    expect(html).not.toContain("RF-DETR TensorRT");
  });

  test("aggregate state reports loading, ready, partial, and missing", () => {
    expect(getUltralyticsGroupStatus(null, null, false)).toBe("loading");
    expect(getUltralyticsGroupStatus(env, null, false)).toBe("ready");
    expect(getUltralyticsGroupStatus({ ...env, status: "partial", ultralytics_version: "" }, null, false)).toBe("partial");
    expect(getUltralyticsGroupStatus({ ...env, status: "partial", yolo_path: "" }, null, false)).toBe("partial");
    expect(getUltralyticsGroupStatus({ ...env, status: "missing", python_version: "", yolo_path: "" }, null, false)).toBe("missing");
    expect(getUltralyticsGroupStatus(null, "detect failed", false)).toBe("missing");
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
