import { invoke } from "@tauri-apps/api/core";
import type { DepCheckResponse } from "@/lib/types";

export function checkDependencies(
  routeId: string,
  pythonPath: string,
): Promise<DepCheckResponse> {
  return invoke<DepCheckResponse>("check_dependencies", {
    route_id: routeId,
    python_path: pythonPath,
  });
}
