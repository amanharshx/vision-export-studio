// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  getRfDetrFallbackImgsz,
  validateRfDetrImgsz,
} from "./rfdetr-image-size";

describe("validateRfDetrImgsz", () => {
  test("accepts the checkpoint-native size", () => {
    expect(validateRfDetrImgsz(512, 32)).toBeNull();
  });

  test("accepts a divisible non-native size", () => {
    expect(validateRfDetrImgsz(640, 32)).toBeNull();
  });

  test("accepts a custom training resolution when divisible", () => {
    expect(validateRfDetrImgsz(640, 32)).toBeNull();
    expect(validateRfDetrImgsz(560, 56)).toBeNull();
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

describe("getRfDetrFallbackImgsz", () => {
  test("returns a divisible standard preset without claiming native", () => {
    expect(getRfDetrFallbackImgsz(32)).toBe(384);
    expect(getRfDetrFallbackImgsz(56)).toBe(560);
    expect(getRfDetrFallbackImgsz(24)).toBe(384);
  });

  test("returns null when constraints are unknown", () => {
    expect(getRfDetrFallbackImgsz(null)).toBeNull();
    expect(getRfDetrFallbackImgsz(undefined)).toBeNull();
  });

  test("every fallback preset satisfies its multiple", () => {
    for (const multiple of [12, 24, 32, 56]) {
      const fallback = getRfDetrFallbackImgsz(multiple);
      expect(fallback).not.toBeNull();
      expect(fallback! % multiple).toBe(0);
    }
  });
});
