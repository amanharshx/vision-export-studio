// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupScreen } from "./setup-screen";
import type { UpdaterController } from "@/features/updater/use-updater-controller";

describe("SetupScreen", () => {
  test("shows a cleanup persistence error passed from App after navigation", () => {
    const html = renderToStaticMarkup(React.createElement(SetupScreen, {
      defaultRuntimeDir: "/tmp/runtime",
      updatesEnabled: false,
      updater: {} as UpdaterController,
      onComplete: () => {},
      initialErrorMessage: "Environment removed, but saving setup state failed: disk full",
    }));

    expect(html).toContain("Environment removed, but saving setup state failed: disk full");
  });
});

