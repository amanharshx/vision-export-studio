// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupActivityBar, SetupActivityDetailsBody } from "./setup-activity-bar";
import { Dialog } from "@/components/ui/dialog";
import { createSetupTask } from "./setup-task";

describe("SetupActivityBar", () => {
  test("renders compact active bar on any screen without a percentage", () => {
    const task = {
      ...createSetupTask({
        provider: "ultralytics",
        routeId: null,
        environmentKey: "ultralytics-managed",
        pythonPath: "/tmp/python",
      }),
      sessionId: "session-1",
      summary: "Installing Ultralytics runtime…",
      logs: ["[stdout] Collecting ultralytics"],
    };

    const html = renderToStaticMarkup(
      React.createElement(SetupActivityBar, {
        task,
        onOpenDetails: () => {},
        onCloseDetails: () => {},
        onDismiss: () => {},
      }),
    );

    expect(html).toContain("Installing packages");
    expect(html).toContain("Installing Ultralytics runtime");
    expect(html).toContain("ultralytics");
    expect(html).toContain("ultralytics-managed");
    expect(html).toContain("View details");
    expect(html).not.toContain("%");
  });

  test("keeps terminal failure visible with dismiss and details", () => {
    const task = {
      ...createSetupTask({
        provider: "ultralytics",
        routeId: null,
        environmentKey: "ultralytics-managed",
        pythonPath: "/tmp/python",
      }),
      phase: "failed" as const,
      status: "failed" as const,
      summary: "ultralytics setup failed",
      error: "pip exited with code 1",
      logs: ["[stderr] boom"],
      sessionId: "session-1",
      detailsOpen: true,
    };

    const barHtml = renderToStaticMarkup(
      React.createElement(SetupActivityBar, {
        task,
        onOpenDetails: () => {},
        onCloseDetails: () => {},
        onDismiss: () => {},
      }),
    );
    expect(barHtml).toContain("Failed");
    expect(barHtml).toContain("ultralytics setup failed");

    // Dialog body is tested separately because Radix portals render nothing in SSR.
    const bodyHtml = renderToStaticMarkup(
      React.createElement(
        Dialog,
        { open: true },
        React.createElement(SetupActivityDetailsBody, {
          task,
          onDismiss: () => {},
        }),
      ),
    );
    expect(bodyHtml).toContain("pip exited with code 1");
    expect(bodyHtml).toContain("Dismiss");
    expect(bodyHtml).toContain("boom");
    expect(bodyHtml).toContain("ultralytics-managed");
  });

  test("renders nothing once dismissed", () => {
    const task = {
      ...createSetupTask({
        provider: "ultralytics",
        routeId: null,
        environmentKey: "ultralytics-managed",
        pythonPath: "/tmp/python",
      }),
      phase: "ready" as const,
      status: "succeeded" as const,
      dismissed: true,
    };

    const html = renderToStaticMarkup(
      React.createElement(SetupActivityBar, {
        task,
        onOpenDetails: () => {},
        onCloseDetails: () => {},
        onDismiss: () => {},
      }),
    );

    expect(html).toBe("");
  });
});
