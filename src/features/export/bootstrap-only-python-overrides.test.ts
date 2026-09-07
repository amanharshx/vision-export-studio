// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BOOTSTRAP_FIRST_USE_NOTICE,
  BootstrapFirstUseBanner,
  getBootstrapFirstUseNotice,
  resolveUltralyticsRoutePython,
} from "@/features/export/export-workspace";

// Ticket 14: Make saved Python overrides bootstrap-only.
// The saved Python only creates isolated export environments; it never
// grants readiness, runs checks, or runs exports directly. Readiness is a
// pure function of the managed environment, so the resolver takes no
// override argument at all.

const MANAGED = "/tmp/runtime/.venv/bin/python";
const SYSTEM = "/usr/bin/python3";

describe("bootstrap-only python overrides (ticket 14)", () => {
  test("a non-managed interpreter never grants readiness", () => {
    expect(resolveUltralyticsRoutePython(SYSTEM, MANAGED, "linux")).toBeNull();
  });

  test("the managed interpreter stays ready", () => {
    expect(resolveUltralyticsRoutePython(MANAGED, MANAGED, "linux")).toBe(MANAGED);
  });

  test("a missing managed environment is never ready", () => {
    expect(resolveUltralyticsRoutePython(null, MANAGED, "linux")).toBeNull();
    expect(resolveUltralyticsRoutePython(SYSTEM, null, "linux")).toBeNull();
  });
});

describe("bootstrap first-use notice (ticket 14)", () => {
  test("an existing saved override used to create an environment explains the new behavior", () => {
    const notice = getBootstrapFirstUseNotice("/custom/python", "explicit-override");
    expect(notice).toBe(BOOTSTRAP_FIRST_USE_NOTICE);
    expect(notice).toContain("only creates the isolated export environment");
    expect(notice).toContain("never modified");
  });

  test("no notice without a saved override, another source, or a blank override", () => {
    expect(getBootstrapFirstUseNotice("", "explicit-override")).toBeNull();
    expect(getBootstrapFirstUseNotice("   ", "explicit-override")).toBeNull();
    expect(getBootstrapFirstUseNotice("/custom/python", "ultralytics-managed")).toBeNull();
    expect(getBootstrapFirstUseNotice("/custom/python", "discovered-system")).toBeNull();
    expect(getBootstrapFirstUseNotice("/custom/python", null)).toBeNull();
  });

  test("the banner renders the notice and nothing without one", () => {
    const html = renderToStaticMarkup(
      React.createElement(BootstrapFirstUseBanner, { notice: BOOTSTRAP_FIRST_USE_NOTICE }),
    );
    expect(html).toContain("only creates the isolated export environment");

    expect(
      renderToStaticMarkup(React.createElement(BootstrapFirstUseBanner, { notice: null })),
    ).toBe("");
  });
});
