import { invoke } from "@tauri-apps/api/core";
import type { DepCheckResponse } from "@/lib/types";

export function checkDependencies(
  routeId: string,
  pythonPath: string,
): Promise<DepCheckResponse> {
  return invoke<DepCheckResponse>("check_dependencies", {
    routeId,
    pythonPath,
  });
}
