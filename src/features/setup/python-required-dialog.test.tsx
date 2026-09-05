// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatIncompatibleEntries,
  getPythonRequiredReason,
  getPythonRequiredRequirement,
  getPythonRequiredTitle,
  PYTHON_DOWNLOAD_URL,
  PythonRequiredDialogBody,
  shouldShowClearOverride,
} from "./python-required-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";

type RequiredResult = Extract<
  BootstrapPythonResult,
  { status: "missing" | "invalid_override" }
>;

type MissingResult = Extract<BootstrapPythonResult, { status: "missing" }>;

function missingResult(): MissingResult {
  return {
    status: "missing",
    requirement: "Python 3.10 through 3.13",
    reason: "no compatible Python 3.10 through 3.13 interpreter found for ultralytics.pt.onnx",
    incompatible: [
      { source: "ultralytics-managed", python_path: "/tmp/managed/bin/python", version: "3.9.6" },
      { source: "discovered-system", python_path: "/usr/bin/python3", version: "3.14.0" },
    ],
  };
}

function invalidResult(): RequiredResult {
  return {
    status: "invalid_override",
    python_path: "/very/long/path/to/custom/python/installation/bin/python3.12",
    source: "explicit-override",
    reason: "Python 3.9.6 is not supported for ultralytics.pt.onnx; requires Python 3.10 through 3.13.",
    version: "3.9.6",
    requirement: "Python 3.10 through 3.13",
  };
}

function renderBody(result: RequiredResult, overrides?: Partial<Parameters<typeof PythonRequiredDialogBody>[0]>) {
  return renderToStaticMarkup(
    React.createElement(
      Dialog,
      { open: true },
      React.createElement(PythonRequiredDialogBody, {
        routeId: "ultralytics.pt.onnx",
        result,
        choiceError: null,
        busy: false,
        showClearOverride: shouldShowClearOverride(result),
        onCancel: () => {},
        onChoosePython: () => {},
        onCheckAgain: () => {},
        onClearOverride: () => {},
        ...overrides,
      }),
    ),
  );
}

describe("python-required dialog copy (ticket 06)", () => {
  test("states the selected route requirement in short user-facing language", () => {
    expect(getPythonRequiredRequirement(missingResult())).toBe("Python 3.10 through 3.13");
    expect(
      getPythonRequiredRequirement({
        status: "missing",
        requirement: "Python 3.12",
        reason: "no compatible Python 3.12 interpreter found for rfdetr.pth.tflite",
        incompatible: [],
      }),
    ).toBe("Python 3.12");

    const html = renderBody(missingResult(), { routeId: "rfdetr.pth.tflite" });
    expect(html).toContain("rfdetr.pth.tflite");
    expect(html).toContain("Python 3.10 through 3.13");
  });

  test("shows the exact reason and prefers the latest choice error", () => {
    expect(getPythonRequiredReason(missingResult(), null)).toContain("no compatible Python");
    expect(getPythonRequiredReason(missingResult(), "provided Python failed validation: boom")).toBe(
      "provided Python failed validation: boom",
    );

    const html = renderBody(missingResult(), { choiceError: "provided Python failed validation: boom" });
    expect(html).toContain("provided Python failed validation: boom");
  });

  test("shows a compact incompatible list with versions and sources", () => {
    const { visible, hiddenCount } = formatIncompatibleEntries(missingResult().incompatible);
    expect(visible).toHaveLength(2);
    expect(hiddenCount).toBe(0);

    const many = Array.from({ length: 5 }, (_, index) => ({
      source: "discovered-system",
      python_path: `/usr/bin/python${index}`,
      version: `3.9.${index}`,
    }));
    const compacted = formatIncompatibleEntries(many);
    expect(compacted.visible).toHaveLength(3);
    expect(compacted.hiddenCount).toBe(2);

    const html = renderBody(missingResult());
    expect(html).toContain("Found but incompatible");
    expect(html).toContain("3.9.6");
    expect(html).toContain("3.14.0");
    expect(html).toContain("ultralytics-managed");
  });

  test("keeps long paths visually contained while preserving the full value", () => {
    const html = renderBody(invalidResult());
    expect(html).toContain("truncate");
    expect(html).toContain('title="/very/long/path/to/custom/python/installation/bin/python3.12"');
    expect(html).toContain("/very/long/path/to/custom/python/installation/bin/python3.12");
  });

  test("provides cancel, choose, check-again, clear-when-applicable, and the official Python link", () => {
    const missingHtml = renderBody(missingResult());
    expect(missingHtml).toContain("Cancel");
    expect(missingHtml).toContain("Choose Python");
    expect(missingHtml).toContain("Check again");
    expect(missingHtml).not.toContain("Clear override");
    expect(missingHtml).toContain(PYTHON_DOWNLOAD_URL);
    expect(missingHtml).toContain("python.org");

    const invalidHtml = renderBody(invalidResult());
    expect(invalidHtml).toContain("Clear override");

    expect(getPythonRequiredTitle(missingResult())).toBe("Python required");
    expect(getPythonRequiredTitle(invalidResult())).toBe("Python override needs attention");
  });

  test("never downloads Python automatically: only links to the official installer", () => {
    const html = renderBody(missingResult());
    expect(html).toContain(`href="${PYTHON_DOWNLOAD_URL}"`);
    expect(html).not.toContain("pip install");
    expect(html).not.toContain("Downloading Python");
    expect(html).toContain("never downloads Python automatically");
  });
});
