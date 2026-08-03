// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { getInstallableMissingPackages } from "./export-workspace";
import type { DepCheckResult } from "@/lib/types";

describe("getInstallableMissingPackages", () => {
  test("returns explicit install_package values", () => {
    const results: DepCheckResult[] = [
      {
        item: "ultralytics",
        status: "version_too_old",
        reason: "",
        install_hint: 'pip install "ultralytics>=8.4.80"',
        install_package: "ultralytics>=8.4.80",
      },
      {
        item: "onnx",
        status: "missing_package",
        reason: "",
        install_hint: "pip install onnx",
        install_package: "onnx",
      },
    ];

    expect(getInstallableMissingPackages(results)).toEqual([
      "ultralytics>=8.4.80",
      "onnx",
    ]);
  });

  test("never returns the python display item", () => {
    const results: DepCheckResult[] = [
      {
        item: "Python 3.10+",
        status: "version_too_old",
        reason: "Python 3.9.6 is selected; LiteRT requires Python 3.10 or newer.",
        install_hint: "Install/select Python 3.10 or newer...",
      },
      {
        item: "onnx",
        status: "missing_package",
        reason: "",
        install_hint: "pip install onnx",
        install_package: "onnx",
      },
    ];

    const packages = getInstallableMissingPackages(results);
    expect(packages).not.toContain("Python 3.10+");
    expect(packages).toEqual(["onnx"]);
  });

  test("keeps pip-installable missing binaries", () => {
    const results: DepCheckResult[] = [
      {
        item: "imxconv-pt",
        status: "missing_binary",
        reason: "",
        install_hint: "pip install imx500-converter",
      },
    ];

    expect(getInstallableMissingPackages(results)).toEqual(["imx500-converter"]);
  });

  test("unknown ultralytics probe is never offered for install", () => {
    const unknownUltralytics: DepCheckResult = {
      item: "ultralytics",
      status: "unknown",
      reason: "probe failed",
      install_hint: 'pip install "ultralytics>=8.4.80"',
    };

    expect(getInstallableMissingPackages([unknownUltralytics])).toEqual([]);
  });
});
