import { invoke } from "@tauri-apps/api/core";

export interface RfDetrSetupReadiness {
  stack_key: string;
  stack_python: string;
  needs_work: boolean;
}

export function rfdetrSetupReadiness(routeId: string): Promise<RfDetrSetupReadiness> {
  return invoke<RfDetrSetupReadiness>("rfdetr_setup_readiness", { routeId });
}
