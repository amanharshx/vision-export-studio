// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  getManagedPythonPath,
  isManagedPythonEnvironment,
} from "./managed-runtime";

describe("getManagedPythonPath", () => {
  test("returns linux and macOS managed venv python path", () => {
    expect(getManagedPythonPath("/tmp/runtime", "linux")).toBe("/tmp/runtime/.venv/bin/python");
    expect(getManagedPythonPath("/tmp/runtime", "macos")).toBe("/tmp/runtime/.venv/bin/python");
  });

  test("returns windows managed venv python path", () => {
    expect(getManagedPythonPath("C:/runtime", "windows")).toBe("C:/runtime/.venv/Scripts/python.exe");
  });
});

describe("isManagedPythonEnvironment", () => {
  test("accepts exact managed python path", () => {
    expect(
      isManagedPythonEnvironment(
        "/tmp/runtime/.venv/bin/python",
        "/tmp/runtime/.venv/bin/python",
      ),
    ).toBe(true);
  });

  test("rejects non-managed python path", () => {
    expect(
      isManagedPythonEnvironment(
        "/usr/bin/python3",
        "/tmp/runtime/.venv/bin/python",
      ),
    ).toBe(false);
  });
});
