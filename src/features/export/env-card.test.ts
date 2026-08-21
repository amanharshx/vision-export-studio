// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvCard,
  ProviderGroup,
  StackEnvironmentCards,
  getRfdetrGroupSummary,
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
      python_path: "/tmp/runtime/envs/rfdetr-default/.venv/bin/python",
      python_version: { status: "available", version: "3.12.12" },
    },
  ];

  test("renders one card for each returned stack", () => {
    const html = renderToStaticMarkup(React.createElement(StackEnvironmentCards, { stacks }));
    expect(html).toContain("RF-DETR");
    expect(html).toContain("3.12.12");
    expect(html).toContain(stacks[0].python_path);
  });

  test("renders nothing when no stack environments exist", () => {
    expect(renderToStaticMarkup(React.createElement(StackEnvironmentCards, { stacks: [] }))).toBe("");
  });

  test("keeps paths visually truncated while exposing full path in title", () => {
    const html = renderToStaticMarkup(React.createElement(StackEnvironmentCards, { stacks }));
    expect(html).toContain('title="/tmp/runtime/envs/rfdetr-default/.venv/bin/python"');
    expect(html).toContain("truncate");
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
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ProviderGroup, { title: "Ultralytics YOLO", summary: "Ready" }, "Python"),
        React.createElement(ProviderGroup, { title: "Roboflow RF-DETR", summary: "0 installed · ready" }, "RF-DETR"),
      ),
    );
    expect((html.match(/Ultralytics YOLO/g) ?? []).length).toBe(1);
    expect((html.match(/Roboflow RF-DETR/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(">Python<");
    expect(html).not.toContain(">RF-DETR<");
  });

  test("expanded group renders children and uses aria-expanded true", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ProviderGroup,
        { title: "Ultralytics YOLO", summary: "Ready", defaultExpanded: true },
        React.createElement("span", null, "Python details"),
      ),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Python details");
  });

  test("RF-DETR empty state has no phantom cards", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ProviderGroup,
        { title: "Roboflow RF-DETR", summary: getRfdetrGroupSummary([]), defaultExpanded: true },
        React.createElement("p", null, "No RF-DETR environments installed"),
      ),
    );
    expect(html).toContain("No RF-DETR environments installed");
    expect(html).not.toContain("RF-DETR TensorRT");
  });

  test("aggregate state reports loading, ready, partial, and missing", () => {
    expect(getUltralyticsGroupStatus(null, null, false)).toBe("loading");
    expect(getUltralyticsGroupStatus(env, null, false)).toBe("ready");
    expect(getUltralyticsGroupStatus({ ...env, yolo_path: "" }, null, false)).toBe("partial");
    expect(getUltralyticsGroupStatus({ ...env, python_version: "", yolo_path: "" }, null, false)).toBe("missing");
    expect(getUltralyticsGroupStatus(null, "detect failed", false)).toBe("missing");
  });

  test("RF-DETR aggregate errors when any existing interpreter is unavailable", () => {
    const stack: StackEnvironment = {
      key: "rfdetr-default",
      display_name: "RF-DETR",
      python_path: "/tmp/python",
      python_version: { status: "available", version: "3.12.12" },
    };
    expect(getRfdetrGroupSummary([stack])).toBe("1 installed · ready");
    expect(getRfdetrGroupSummary([{ ...stack, python_version: { status: "unavailable" } }]))
      .toBe("1 installed · error");
  });
});
