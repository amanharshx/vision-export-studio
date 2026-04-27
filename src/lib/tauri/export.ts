import { invoke } from "@tauri-apps/api/core";

export interface StartExportInput {
  sourcePath: string;
  routeId: string;
  outputDir: string;
  yoloPath: string;
  imgsz: number;
  batch: number;
  half: boolean;
  int8: boolean;
  dynamic: boolean;
  simplify: boolean;
  optimize: boolean;
  nms: boolean;
  endToEnd: boolean;
  keras: boolean;
  opset: number | null;
  workspace: number | null;
  chip: string;
}

export async function startExport(input: StartExportInput): Promise<string> {
  return invoke<string>("start_export", { ...input });
}

export async function cancelExport(sessionId: string): Promise<boolean> {
  return invoke<boolean>("cancel_export", { sessionId });
}
