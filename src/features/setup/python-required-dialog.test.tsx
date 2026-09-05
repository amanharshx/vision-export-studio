// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PYTHON_DOWNLOAD_URL,
  PythonRequiredDialogBody,
} from "./python-required-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { BootstrapPythonResult } from "@/lib/tauri/bootstrap-python";

type RequiredResult = Extract<
  BootstrapPythonResult,
  { status: "missing" | "invalid_override" }
>;

function missingResult(): RequiredResult {
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
  const showClearOverride =
    overrides?.showClearOverride ?? result.status === "invalid_override";
  return renderToStaticMarkup(
    React.createElement(
      Dialog,
      { open: true },
      React.createElement(PythonRequiredDialogBody, {
        routeId: "ultralytics.pt.onnx",
        result,
        choiceError: null,
        busy: false,
        showClearOverride,
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
    const html = renderBody(missingResult(), { routeId: "rfdetr.pth.tflite" });
    expect(html).toContain("rfdetr.pth.tflite");
    expect(html).toContain("Python 3.10 through 3.13");

    const tfliteHtml = renderBody({
      status: "missing",
      requirement: "Python 3.12",
      reason: "no compatible Python 3.12 interpreter found for rfdetr.pth.tflite",
      incompatible: [],
    });
    expect(tfliteHtml).toContain("Python 3.12");
  });

  test("shows the exact reason, and a different choice error separately", () => {
    expect(renderBody(missingResult())).toContain("no compatible Python");

    const html = renderBody(missingResult(), { choiceError: "provided Python is not usable: boom" });
    expect(html).toContain("no compatible Python");
    expect(html).toContain("provided Python is not usable: boom");
  });

  test("never shows the same reason twice", () => {
    const result = missingResult();
    const html = renderBody(result, { choiceError: result.reason });
    expect(html.match(/no compatible Python 3\.10 through 3\.13 interpreter found/g)).toHaveLength(1);
  });

  test("shows a compact incompatible list with versions and sources", () => {
    const html = renderBody(missingResult());
    expect(html).toContain("Found but incompatible");
    expect(html).toContain("3.9.6");
    expect(html).toContain("3.14.0");
    expect(html).toContain("ultralytics-managed");

    const many = renderBody({
      status: "missing",
      requirement: "Python 3.10 through 3.13",
      reason: "none compatible",
      incompatible: Array.from({ length: 5 }, (_, index) => ({
        source: "discovered-system",
        python_path: `/usr/bin/python${index}`,
        version: `3.9.${index}`,
      })),
    });
    expect(many).toContain("and 2 more");
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
    expect(invalidHtml).toContain("Python override needs attention");
    expect(missingHtml).toContain("Python required");
  });

  test("never downloads Python automatically: only links to the official installer", () => {
    const html = renderBody(missingResult());
    expect(html).toContain(`href="${PYTHON_DOWNLOAD_URL}"`);
    expect(html).toContain("Get Python from python.org");
    expect(html).toContain("<svg");
    expect(html).not.toContain("pip install");
    expect(html).not.toContain("Downloading Python");
    expect(html).toContain("never downloads Python automatically");
  });
});
