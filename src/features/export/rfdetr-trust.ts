import type { RfDetrInspectResult } from "@/lib/types";

export interface RfDetrCheckpointIdentity {
  canonical_path: string;
  len: number;
  modified_ms: number;
}

export interface RfDetrTrustedCheckpoint {
  sourcePath: string;
  identity: RfDetrCheckpointIdentity;
}

/**
 * Session-only trust bound to the selected file's canonical identity, size,
 * and modification state. Trust lives only in memory: restarting the app
 * drops it, selecting a different file replaces it, and changing the
 * trusted file invalidates it. True only when the stored trust matches the
 * current file identity.
 */
export function isRfDetrTrustValid(
  trusted: RfDetrTrustedCheckpoint | null,
  sourcePath: string,
  current: RfDetrCheckpointIdentity | null,
): boolean {
  if (!trusted || !current) return false;
  if (trusted.sourcePath !== sourcePath) return false;
  return trusted.identity.canonical_path === current.canonical_path
    && trusted.identity.len === current.len
    && trusted.identity.modified_ms === current.modified_ms;
}

/**
 * Exact blocking reason for unsupported Plus-only checkpoints. Returns null
 * when export may proceed; callers must check this before manual-variant
 * readiness so manual selection cannot bypass the Plus block.
 */
export function getRfDetrPlusBlockReason(
  inspect: RfDetrInspectResult | null,
): string | null {
  if (!inspect || !inspect.requires_plus) return null;
  return inspect.error
    ?? `${inspect.class_symbol ?? "Checkpoint"} requires rfdetr_plus support and is not supported in v1.`;
}
