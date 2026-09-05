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
 * Binds explicit user trust to the current session and the selected file's
 * canonical identity, size, and modification state. Trust lives only in
 * memory: restarting the app drops it, selecting a different file replaces
 * it, and changing the trusted file invalidates it via `isRfDetrTrustValid`.
 */
export function createRfDetrTrust(
  sourcePath: string,
  identity: RfDetrCheckpointIdentity,
): RfDetrTrustedCheckpoint {
  return { sourcePath, identity: { ...identity } };
}

/** True only when the stored trust matches the current file identity. */
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

export const RFDETR_NO_HEALTHY_STACK_MESSAGE =
  "No healthy RF-DETR environment found. Set up a route environment before inspection.";

/** True for backend errors that preserve trust and require route setup. */
export function isRfDetrNoHealthyStackError(error: string): boolean {
  return error.includes("before inspection.");
}
