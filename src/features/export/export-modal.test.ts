// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostSupportBadge, HostSupportReason, PendingInstallConsent, PrimaryExportActionLabel, RfDetrInspectionFailurePanel, RfDetrInspectionFollowUpPanel, RfDetrSetupPanel, UltralyticsSetupPanel } from "./export-modal";
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
        missingPackages: [{ package: "ultralytics>=8.4.80", prerelease: false }],
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
        missingPackages: [{ package: "onnx", prerelease: false }],
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
        missingPackages: [{ package: "onnx", prerelease: false }],
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

describe("UltralyticsSetupPanel", () => {
  test("setup-incomplete offers retry guidance with remove and recreate recovery", () => {
    const html = renderToStaticMarkup(
      React.createElement(UltralyticsSetupPanel, {
        status: "setup-incomplete",
        routeTitle: "ONNX",
        error: "pip exited with code 1",
        showRecovery: true,
        onRemoveEnvironment: () => {},
        onRecreateEnvironment: () => {},
      }),
    );

    expect(html).toContain("Setup incomplete");
    expect(html).toContain("Retry");
    expect(html).toContain("Recreate");
    expect(html).toContain("Remove…");
    expect(html).toContain("Recreate environment…");
    expect(html).toContain("pip exited with code 1");
  });

  test("not-set-up hides recovery and names the route", () => {
    const html = renderToStaticMarkup(
      React.createElement(UltralyticsSetupPanel, {
        status: "not-set-up",
        routeTitle: "ONNX",
        error: null,
        showRecovery: false,
      }),
    );

    expect(html).toContain("Not set up");
    expect(html).toContain("ONNX");
    expect(html).not.toContain("Remove…");
    expect(html).not.toContain("Recreate environment…");
  });

  test("unavailable names the state without setup recovery", () => {
    const html = renderToStaticMarkup(
      React.createElement(UltralyticsSetupPanel, {
        status: "unavailable",
        routeTitle: "TensorRT",
        error: null,
        showRecovery: false,
      }),
    );

    expect(html).toContain("Unavailable");
    expect(html).toContain("TensorRT");
  });
});

describe("RfDetrSetupPanel", () => {
  test("setup-incomplete offers retry guidance with remove and recreate recovery", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrSetupPanel, {
        status: "setup-incomplete",
        routeTitle: "ONNX",
        stackKey: "rfdetr-default",
        error: "pip exited with code 1",
        showRecovery: true,
        onRemoveEnvironment: () => {},
        onRecreateEnvironment: () => {},
      }),
    );

    expect(html).toContain("Setup incomplete");
    expect(html).toContain("Retry");
    expect(html).toContain("Recreate");
    expect(html).toContain("Remove…");
    expect(html).toContain("Recreate environment…");
    expect(html).toContain("pip exited with code 1");
  });

  test("not-set-up names the selected stack without export controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrSetupPanel, {
        status: "not-set-up",
        routeTitle: "ONNX",
        stackKey: "rfdetr-default",
        error: null,
        showRecovery: false,
      }),
    );

    expect(html).toContain("Not set up");
    expect(html).toContain("ONNX");
    expect(html).toContain("rfdetr-default");
    expect(html).not.toContain("Remove…");
  });

  test("unavailable names the state without setup recovery", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrSetupPanel, {
        status: "unavailable",
        routeTitle: "TensorRT",
        stackKey: "rfdetr-tensorrt",
        error: null,
        showRecovery: false,
      }),
    );

    expect(html).toContain("Unavailable");
    expect(html).toContain("TensorRT");
  });
});

describe("RfDetrInspectionFollowUpPanel (ticket 11)", () => {
  test("names the inspecting phase without a percentage", () => {
    const html = renderToStaticMarkup(React.createElement(RfDetrInspectionFollowUpPanel));

    expect(html).toContain("Inspecting checkpoint");
    expect(html).not.toContain("%");
    expect(html).toContain("ready");
  });
});

describe("RfDetrInspectionFailurePanel (ticket 11)", () => {
  const loadFailure = { canRetry: true, showManualVariant: true, showFileAction: true };
  const plusFailure = { canRetry: false, showManualVariant: false, showFileAction: true };

  test("offers retry without guessed defaults and keeps the environment ready", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrInspectionFailurePanel, {
        error: "torch load boom",
        failure: loadFailure,
        onRetry: () => {},
      }),
    );

    expect(html).toContain("Checkpoint inspection failed");
    expect(html).toContain("torch load boom");
    expect(html).toContain("Retry inspection");
    expect(html).toContain("environment is ready");
    expect(html).not.toContain("Native image size");
  });

  test("hides retry when inspection cannot succeed by retrying (plus-only)", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrInspectionFailurePanel, {
        error: "RFDETRXLarge requires rfdetr_plus support and is not supported in v1.",
        failure: plusFailure,
      }),
    );

    expect(html).toContain("Checkpoint inspection failed");
    expect(html).not.toContain("Retry inspection");
  });

  test("offers a file action alongside retry on load failure", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrInspectionFailurePanel, {
        error: "torch load boom",
        failure: loadFailure,
        onRetry: () => {},
        onChooseDifferentFile: () => {},
      }),
    );

    expect(html).toContain("Retry inspection");
    expect(html).toContain("Choose different file");
  });

  test("hides the file action when it is not offered", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrInspectionFailurePanel, {
        error: "torch load boom",
        failure: { ...loadFailure, showFileAction: false },
        onRetry: () => {},
      }),
    );

    expect(html).toContain("Retry inspection");
    expect(html).not.toContain("Choose different file");
  });

  test("offers the manual-variant path from the modal on load failure", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrInspectionFailurePanel, {
        error: "torch load boom",
        failure: loadFailure,
        onRetry: () => {},
        onSelectManualVariant: () => {},
      }),
    );

    expect(html).toContain("Select manual variant");
  });

  test("hides the manual-variant path for plus-only checkpoints", () => {
    const html = renderToStaticMarkup(
      React.createElement(RfDetrInspectionFailurePanel, {
        error: "RFDETRXLarge requires rfdetr_plus support and is not supported in v1.",
        failure: plusFailure,
        onChooseDifferentFile: () => {},
      }),
    );

    expect(html).toContain("Choose different file");
    expect(html).not.toContain("Select manual variant");
  });
});
