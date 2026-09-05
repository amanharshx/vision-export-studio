import { invoke } from "@tauri-apps/api/core";

export interface BootstrapIncompatible {
  source: string;
  python_path: string;
  version: string;
}

export type BootstrapPythonResult =
  | { status: "available"; python_path: string; source: string; version: string }
  | { status: "missing"; requirement: string; reason: string; incompatible: BootstrapIncompatible[] }
  | {
      status: "invalid_override";
      python_path: string;
      source: string;
      reason: string;
      version: string | null;
      requirement: string;
    }
  | { status: "error"; reason: string };

export function resolveBootstrapPython(
  routeId: string,
  pythonPathOverride?: string,
): Promise<BootstrapPythonResult> {
  const payload =
    pythonPathOverride === undefined ? { routeId } : { routeId, pythonPathOverride };
  return invoke<BootstrapPythonResult>("resolve_bootstrap_python", payload);
}

export function isPythonRequiredResult(
  result: BootstrapPythonResult,
): result is PythonRequiredResult {
  return result.status === "missing" || result.status === "invalid_override";
}

export type PythonRequiredResult = Extract<
  BootstrapPythonResult,
  { status: "missing" | "invalid_override" }
>;
