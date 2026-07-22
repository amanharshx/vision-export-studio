// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { incompatibleReason, isCompatible, platformTags } from "@/lib/platform";

describe("isCompatible", () => {
  test("any is compatible everywhere", () => {
    expect(isCompatible("any", "macos")).toBe(true);
    expect(isCompatible("any", "windows")).toBe(true);
    expect(isCompatible("any", "linux")).toBe(true);
  });

  test("macos lock is macOS only", () => {
    expect(isCompatible("macos", "macos")).toBe(true);
    expect(isCompatible("macos", "linux")).toBe(false);
    expect(isCompatible("macos", "windows")).toBe(false);
  });

  test("macos_linux lock allows macOS and Linux but not Windows", () => {
    expect(isCompatible("macos_linux", "macos")).toBe(true);
    expect(isCompatible("macos_linux", "linux")).toBe(true);
    expect(isCompatible("macos_linux", "windows")).toBe(false);
  });

  test("linux_windows lock excludes macOS", () => {
    expect(isCompatible("linux_windows", "linux")).toBe(true);
    expect(isCompatible("linux_windows", "windows")).toBe(true);
    expect(isCompatible("linux_windows", "macos")).toBe(false);
  });

  test("linux lock allows every Linux architecture", () => {
    expect(isCompatible("linux", "linux")).toBe(true);
    expect(isCompatible("linux", "macos")).toBe(false);
  });

  test("linux_x86_64 lock requires Linux on x86-64", () => {
    expect(isCompatible("linux_x86_64", "linux", "x86_64")).toBe(true);
    expect(isCompatible("linux_x86_64", "linux", "aarch64")).toBe(false);
    expect(isCompatible("linux_x86_64", "linux", "unknown")).toBe(false);
    expect(isCompatible("linux_x86_64", "windows")).toBe(false);
  });
});

describe("platformTags", () => {
  test("macos_linux is tagged for both macOS and Linux", () => {
    expect(platformTags("macos_linux")).toEqual(["macOS", "Linux"]);
  });

  test("any has no tags", () => {
    expect(platformTags("any")).toEqual([]);
  });

  test("linux_x86_64 names architecture requirement", () => {
    expect(platformTags("linux_x86_64")).toEqual(["Linux x86-64"]);
  });
});

describe("incompatibleReason", () => {
  test("returns null when compatible", () => {
    expect(incompatibleReason("macos_linux", "linux")).toBeNull();
  });

  test("names current OS and supported platforms when incompatible", () => {
    expect(incompatibleReason("macos_linux", "windows")).toBe(
      "This format is not supported on Windows. Available on macOS and Linux only.",
    );
  });

  test("names current architecture when Linux architecture is incompatible", () => {
    expect(incompatibleReason("linux_x86_64", "linux", "aarch64")).toBe(
      "This format is not supported on Linux ARM64. Available on Linux x86-64 only.",
    );
  });
});
