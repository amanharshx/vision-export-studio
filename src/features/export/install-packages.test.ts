// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import type { DepCheckResult } from "@/lib/types";
import { getInstallableMissingPackages } from "./install-packages";

describe("getInstallableMissingPackages", () => {
  test("prefers the backend-reported install remedy with its prerelease flag", () => {
    expect(
      getInstallableMissingPackages([
        { item: "ultralytics", status: "ready", reason: "", install_hint: "pip install ultralytics" },
        { item: "onnx", status: "missing_package", reason: "missing", install_hint: "pip install onnx", install_package: "onnx" },
        { item: "flatc", status: "missing_package", reason: "missing", install_hint: "python -m pip install --pre flatc", install_package: "flatc", prerelease: true },
      ]),
    ).toEqual([
      { package: "onnx", prerelease: false },
      { package: "flatc", prerelease: true },
    ]);
  });

  test("falls back to the pip spec for missing binaries without an install package", () => {
    const results: DepCheckResult[] = [
      { item: "edgetpu_compiler", status: "missing_binary", reason: "missing", install_hint: "pip install edgetpu-compiler" },
    ];
    expect(getInstallableMissingPackages(results)).toEqual([
      { package: "edgetpu-compiler", prerelease: false },
    ]);
  });

  test("ignores missing binaries without a pip remedy and deduplicates", () => {
    const results: DepCheckResult[] = [
      { item: "java", status: "missing_binary", reason: "missing", install_hint: "Install Java >= 17: https://adoptium.net/" },
      { item: "onnx", status: "missing_package", reason: "missing", install_hint: "pip install onnx", install_package: "onnx" },
      { item: "onnx-dup", status: "missing_package", reason: "missing", install_hint: "pip install onnx", install_package: "onnx" },
    ];
    expect(getInstallableMissingPackages(results)).toEqual([
      { package: "onnx", prerelease: false },
    ]);
  });

  test("returns empty when nothing is installable", () => {
    expect(getInstallableMissingPackages(null)).toEqual([]);
    expect(
      getInstallableMissingPackages([
        { item: "onnx", status: "ready", reason: "", install_hint: "pip install onnx" },
      ]),
    ).toEqual([]);
  });
});
