// Shared assertion used by the builder and owner-emission tests:
// an environment-setup event payload must never carry model, filesystem,
// log, checkpoint, error, or identifier details.
// @ts-expect-error Bun provides this module at test runtime.
import { expect } from "bun:test";

const FORBIDDEN_KEY_PARTS = [
  "path",
  "file",
  "log",
  "command",
  "content",
  "model",
  "checkpoint",
  "metadata",
  "error",
  "python",
  "output",
  "session",
];

const FORBIDDEN_KEYS = ["session_id", "python_path", "source_path", "model_filename"];

export function expectNoForbiddenSetupAnalyticsKeys(
  properties: Record<string, unknown>,
): void {
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    for (const part of FORBIDDEN_KEY_PARTS) {
      expect(lower).not.toContain(part);
    }
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(properties).not.toContainKey(forbidden);
  }
}
