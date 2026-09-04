// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { validateRfDetrImgsz } from "./rfdetr-image-size";

describe("validateRfDetrImgsz", () => {
  test("accepts the checkpoint-native size", () => {
    expect(validateRfDetrImgsz(512, 32)).toBeNull();
  });

  test("accepts a divisible non-native size", () => {
    expect(validateRfDetrImgsz(640, 32)).toBeNull();
  });

  test("rejects a non-divisible size with the exact multiple", () => {
    const error = validateRfDetrImgsz(500, 32);
    expect(error).not.toBeNull();
    expect(error).toContain("divisible by 32");
  });

  test("rejects non-integers and out-of-range sizes", () => {
    expect(validateRfDetrImgsz(512.5, 32)).toContain("integer");
    expect(validateRfDetrImgsz(Number.NaN, 32)).toContain("integer");
    expect(validateRfDetrImgsz(32, 32)).toContain("between 64 and 8192");
    expect(validateRfDetrImgsz(9000, 32)).toContain("between 64 and 8192");
  });

  test("checks only the range when model constraints are unknown", () => {
    expect(validateRfDetrImgsz(500, null)).toBeNull();
    expect(validateRfDetrImgsz(30, null)).toContain("between 64 and 8192");
  });
});
