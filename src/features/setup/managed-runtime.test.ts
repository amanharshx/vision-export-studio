// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  getManagedPythonPath,
  getManagedPythonVerificationError,
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

  test("accepts equivalent Windows paths with different separators", () => {
    expect(
      isManagedPythonEnvironment(
        "C:\\Users\\HP\\.vision-export-studio\\.venv\\Scripts\\python.exe",
        "C:/Users/HP/.vision-export-studio/.venv/Scripts/python.exe",
        "windows",
      ),
    ).toBe(true);
  });

  test("accepts equivalent Windows paths with different casing", () => {
    expect(
      isManagedPythonEnvironment(
        "C:\\USERS\\HP\\.VISION-EXPORT-STUDIO\\.VENV\\SCRIPTS\\PYTHON.EXE",
        "c:/users/hp/.vision-export-studio/.venv/Scripts/python.exe",
        "windows",
      ),
    ).toBe(true);
  });

  test("rejects a different Windows Python environment", () => {
    expect(
      isManagedPythonEnvironment(
        "C:\\Python310\\python.exe",
        "C:/Users/HP/.vision-export-studio/.venv/Scripts/python.exe",
        "windows",
      ),
    ).toBe(false);
  });

  test("keeps Unix path comparison case-sensitive", () => {
    expect(
      isManagedPythonEnvironment(
        "/TMP/runtime/.venv/bin/python",
        "/tmp/runtime/.venv/bin/python",
        "linux",
      ),
    ).toBe(false);
  });
});

describe("getManagedPythonVerificationError", () => {
  test("includes local expected and resolved interpreter details", () => {
    expect(
      getManagedPythonVerificationError(
        "C:/runtime/.venv/Scripts/python.exe",
        "C:\\runtime\\.venv\\Scripts\\python.exe",
        "3.10.11",
        "partial",
      ),
    ).toBe(
      "managed Python runtime verification failed; retry setup; " +
      "expected=C:/runtime/.venv/Scripts/python.exe; " +
      "resolved=C:\\runtime\\.venv\\Scripts\\python.exe; " +
      "version=3.10.11; status=partial",
    );
  });
});
