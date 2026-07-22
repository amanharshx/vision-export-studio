import { getOS, type AppOS } from "@/lib/platform";

export function getManagedPythonPath(runtimeDir: string, os: AppOS = getOS()): string {
  return os === "windows"
    ? `${runtimeDir}/.venv/Scripts/python.exe`
    : `${runtimeDir}/.venv/bin/python`;
}

function normalizePythonPath(path: string, os: AppOS): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return os === "windows" ? normalized.toLowerCase() : normalized;
}

export function isManagedPythonEnvironment(
  pythonPath: string,
  expectedManagedPythonPath: string,
  os: AppOS = getOS(),
): boolean {
  return (
    normalizePythonPath(pythonPath, os) ===
    normalizePythonPath(expectedManagedPythonPath, os)
  );
}

export function getManagedPythonVerificationError(
  expectedPythonPath: string,
  resolvedPythonPath: string,
  pythonVersion: string,
  status: string,
): string {
  return [
    "managed Python runtime verification failed; retry setup",
    `expected=${expectedPythonPath}`,
    `resolved=${resolvedPythonPath}`,
    `version=${pythonVersion || "unknown"}`,
    `status=${status}`,
  ].join("; ");
}
