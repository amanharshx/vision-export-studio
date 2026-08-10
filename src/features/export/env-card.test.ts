// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvCard, StackEnvironmentCards } from "./export-workspace";
import type { StackEnvironment } from "@/lib/types";

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
});
