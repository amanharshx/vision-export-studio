// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { resolveUltralyticsRoutePython } from "@/features/export/export-workspace";

// Ticket 14: Make saved Python overrides bootstrap-only.
// The saved Python only creates isolated export environments; it never
// grants readiness, runs checks, or runs exports directly.

const MANAGED = "/tmp/runtime/.venv/bin/python";
const SYSTEM = "/usr/bin/python3";
const OVERRIDE = "/custom/python";

describe("bootstrap-only python overrides (ticket 14)", () => {
  test("an explicit override never grants readiness through another interpreter", () => {
    expect(resolveUltralyticsRoutePython(SYSTEM, OVERRIDE, MANAGED, "linux")).toBeNull();
  });

  test("the managed interpreter stays ready with or without an override", () => {
    expect(resolveUltralyticsRoutePython(MANAGED, "", MANAGED, "linux")).toBe(MANAGED);
    expect(resolveUltralyticsRoutePython(MANAGED, OVERRIDE, MANAGED, "linux")).toBe(MANAGED);
  });

  test("a missing managed environment is never ready, even with an override", () => {
    expect(resolveUltralyticsRoutePython(null, OVERRIDE, MANAGED, "linux")).toBeNull();
    expect(resolveUltralyticsRoutePython(null, "", MANAGED, "linux")).toBeNull();
    expect(resolveUltralyticsRoutePython(SYSTEM, "", null, "linux")).toBeNull();
  });

  test("provider routes stay independent of the override once managed is ready", () => {
    // Same managed interpreter qualifies regardless of override presence.
    const withoutOverride = resolveUltralyticsRoutePython(MANAGED, "", MANAGED, "linux");
    const withOverride = resolveUltralyticsRoutePython(MANAGED, OVERRIDE, MANAGED, "linux");
    expect(withoutOverride).toBe(MANAGED);
    expect(withOverride).toBe(MANAGED);
  });
});
