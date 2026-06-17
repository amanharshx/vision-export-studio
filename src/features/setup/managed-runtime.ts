import { getOS, type AppOS } from "@/lib/platform";

export function getManagedPythonPath(runtimeDir: string, os: AppOS = getOS()): string {
  return os === "windows"
    ? `${runtimeDir}/.venv/Scripts/python.exe`
    : `${runtimeDir}/.venv/bin/python`;
}

export function isManagedPythonEnvironment(
  pythonPath: string,
  expectedManagedPythonPath: string,
): boolean {
  return pythonPath === expectedManagedPythonPath;
}
