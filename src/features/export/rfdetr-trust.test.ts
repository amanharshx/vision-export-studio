// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  createRfDetrTrust,
  isRfDetrNoHealthyStackError,
  isRfDetrTrustValid,
  RFDETR_NO_HEALTHY_STACK_MESSAGE,
} from "./rfdetr-trust";

const identity = {
  canonical_path: "/tmp/model.pth",
  len: 1234,
  modified_ms: 1700000000000,
};

describe("rfdetr trust binding (ticket 09)", () => {
  test("trust is valid for the same file identity", () => {
    const trusted = createRfDetrTrust("/tmp/model.pth", identity);
    expect(isRfDetrTrustValid(trusted, "/tmp/model.pth", identity)).toBe(true);
  });

  test("selecting a different file resets trust", () => {
    const trusted = createRfDetrTrust("/tmp/model.pth", identity);
    expect(isRfDetrTrustValid(trusted, "/tmp/other.pth", identity)).toBe(false);
  });

  test("changing the trusted file content resets trust", () => {
    const trusted = createRfDetrTrust("/tmp/model.pth", identity);
    expect(
      isRfDetrTrustValid(trusted, "/tmp/model.pth", { ...identity, len: identity.len + 1 }),
    ).toBe(false);
  });

  test("changing the trusted file modification state resets trust", () => {
    const trusted = createRfDetrTrust("/tmp/model.pth", identity);
    expect(
      isRfDetrTrustValid(trusted, "/tmp/model.pth", {
        ...identity,
        modified_ms: identity.modified_ms + 1000,
      }),
    ).toBe(false);
  });

  test("canonical identity mismatch resets trust", () => {
    const trusted = createRfDetrTrust("/tmp/model.pth", identity);
    expect(
      isRfDetrTrustValid(trusted, "/tmp/model.pth", {
        ...identity,
        canonical_path: "/private/tmp/model.pth",
      }),
    ).toBe(false);
  });

  test("missing trust or current identity is invalid", () => {
    const trusted = createRfDetrTrust("/tmp/model.pth", identity);
    expect(isRfDetrTrustValid(null, "/tmp/model.pth", identity)).toBe(false);
    expect(isRfDetrTrustValid(trusted, "/tmp/model.pth", null)).toBe(false);
  });

  test("no healthy stack keeps trust guidance", () => {
    expect(RFDETR_NO_HEALTHY_STACK_MESSAGE).toContain("Set up a route environment before inspection.");
    expect(
      isRfDetrNoHealthyStackError(
        "No healthy RF-DETR environment found. Set up a route environment before inspection.",
      ),
    ).toBe(true);
    expect(
      isRfDetrNoHealthyStackError(
        "RF-DETR stack 'rfdetr-default' is not ready for inspection. Set up the route environment before inspection.",
      ),
    ).toBe(true);
    expect(isRfDetrNoHealthyStackError("probe failed")).toBe(false);
  });
});
