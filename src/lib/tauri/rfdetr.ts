import { invoke } from "@tauri-apps/api/core";
import type { RfDetrInspectResult } from "@/lib/types";

export async function inspectRfDetrCheckpoint(input: {
  checkpointPath: string;
  pythonPath: string;
  trustConfirmed: boolean;
}): Promise<RfDetrInspectResult> {
  return invoke<RfDetrInspectResult>("inspect_rfdetr_checkpoint", input);
}
