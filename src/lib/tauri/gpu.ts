import { invoke } from "@tauri-apps/api/core";

export interface GpuInfo {
  name: string;
  vramGb: number | null;
}

export async function listGpus(): Promise<GpuInfo[]> {
  return invoke<GpuInfo[]>("list_gpus");
}
