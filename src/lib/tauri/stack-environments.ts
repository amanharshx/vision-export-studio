import { invoke } from "@tauri-apps/api/core";
import type { StackEnvironment } from "@/lib/types";

export function listStackEnvironments(): Promise<StackEnvironment[]> {
  return invoke<StackEnvironment[]>("list_stack_environments");
}
