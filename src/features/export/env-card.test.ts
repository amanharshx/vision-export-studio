// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvCard } from "./export-workspace";

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
