import { invoke } from "@tauri-apps/api/core";

export interface StartExportInput {
  source_path: string;
  route_id: string;
  output_dir: string;
  yolo_path: string;
  imgsz: number;
  batch: number;
  half: boolean;
  dynamic: boolean;
  simplify: boolean;
}

export async function startExport(input: StartExportInput): Promise<number> {
  return invoke<number>("start_export", input as unknown as Record<string, unknown>);
}

export async function cancelExport(sessionId: number): Promise<boolean> {
  return invoke<boolean>("cancel_export", { session_id: sessionId });
}
