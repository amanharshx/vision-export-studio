import { invoke } from "@tauri-apps/api/core";
import type { RfDetrInspectResult } from "@/lib/types";
import type { RfDetrCheckpointIdentity } from "@/features/export/rfdetr-trust";

export async function getRfDetrCheckpointIdentity(
  checkpointPath: string,
): Promise<RfDetrCheckpointIdentity> {
  return invoke<RfDetrCheckpointIdentity>("rfdetr_checkpoint_identity", {
    checkpointPath,
  });
}

export async function inspectRfDetrCheckpoint(input: {
  checkpointPath: string;
  stackKey?: string | null;
  trustConfirmed: boolean;
  trustedIdentity?: RfDetrCheckpointIdentity | null;
}): Promise<RfDetrInspectResult> {
  return invoke<RfDetrInspectResult>("inspect_rfdetr_checkpoint", {
    checkpointPath: input.checkpointPath,
    stackKey: input.stackKey ?? null,
    trustConfirmed: input.trustConfirmed,
    trustedIdentity: input.trustedIdentity ?? null,
  });
}
