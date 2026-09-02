// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostSupportBadge, HostSupportReason, PendingInstallConsent, PrimaryExportActionLabel } from "./export-modal";
import type { DepCheckResult } from "@/lib/types";

const outdatedUltralytics: DepCheckResult = {
  item: "ultralytics",
  status: "version_too_old",
  reason: "Ultralytics 8.4.79 is installed; 8.4.80 or newer is required.",
  install_hint: 'pip install "ultralytics>=8.4.80"',
  install_package: "ultralytics>=8.4.80",
};

const pythonFloor: DepCheckResult = {
  item: "Python 3.10+",
  status: "version_too_old",
  reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
  install_hint: "Install/select Python 3.10 or newer, then re-detect the environment and recreate the export runtime.",
};

const missingOnnx: DepCheckResult = {
  item: "onnx",
  status: "missing_package",
  reason: "importlib.util.find_spec('onnx') returned False",
  install_hint: "pip install onnx",
  install_package: "onnx",
};

describe("HostSupportBadge and HostSupportReason", () => {
  test("renders only confirmed unsupported badge and exact reason", () => {
    const result = {
      route_id: "rfdetr.pth.executorch",
      status: "unsupported" as const,
      reason: "This format is not supported on macOS 13.",
    };
    const html = renderToStaticMarkup(React.createElement(HostSupportBadge, { result }));
    const reasonHtml = renderToStaticMarkup(React.createElement(HostSupportReason, { result }));

    expect(html).toContain("Unsupported");
    expect(reasonHtml).toContain("This format is not supported on macOS 13.");
    expect(html + reasonHtml).not.toContain("Host supported");
  });

  test("renders nothing while host result is pending", () => {
    expect(renderToStaticMarkup(React.createElement(HostSupportBadge, { result: null }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(HostSupportReason, { result: null }))).toBe("");
  });
});

describe("PendingInstallConsent", () => {
  test("version_too_old with install_package switches to update copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(PendingInstallConsent, {
        depResults: [outdatedUltralytics],
        missingPackageNames: [{ package: "ultralytics>=8.4.80", prerelease: false }],
      }),
    );

    expect(html).toContain("Package updates");
    expect(html).not.toContain("Missing packages");
    expect(html).toContain(
      "These will be updated or installed into your Python environment before export:",
    );
    expect(html).toContain("ultralytics&gt;=8.4.80");
  });

  test("only missing_package entries keep the original install copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(PendingInstallConsent, {
        depResults: [missingOnnx],
        missingPackageNames: [{ package: "onnx", prerelease: false }],
      }),
    );

    expect(html).toContain("Missing packages");
    expect(html).not.toContain("Package updates");
    expect(html).toContain(
      "These will be installed into your Python environment before export:",
    );
  });

  test("version_too_old without install_package keeps install copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(PendingInstallConsent, {
        depResults: [pythonFloor],
        missingPackageNames: [{ package: "onnx", prerelease: false }],
      }),
    );

    expect(html).toContain("Missing packages");
    expect(html).not.toContain("Package updates");
    expect(html).toContain(
      "These will be installed into your Python environment before export:",
    );
  });
});

describe("PrimaryExportActionLabel", () => {
  test("consent with an update renders Update & Export", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrimaryExportActionLabel, {
        isInstalling: false,
        isPendingConsent: true,
        involvesUpdate: true,
      }),
    );

    expect(html).toContain("Update &amp; Export");
    expect(html).not.toContain("Install &amp; Export");
  });

  test("consent without an update renders Install & Export", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrimaryExportActionLabel, {
        isInstalling: false,
        isPendingConsent: true,
        involvesUpdate: false,
      }),
    );

    expect(html).toContain("Install &amp; Export");
    expect(html).not.toContain("Update &amp; Export");
  });

  test("installing keeps the Installing state label", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrimaryExportActionLabel, {
        isInstalling: true,
        isPendingConsent: true,
        involvesUpdate: true,
      }),
    );

    expect(html).toContain("Installing...");
  });
});
