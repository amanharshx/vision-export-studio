// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  createRfDetrTrust,
  getRfDetrMissingRuntimeMessage,
  getRfDetrPlusBlockReason,
  isRfDetrTrustValid,
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

  test("restart drops session trust (null initial state is invalid)", () => {
    expect(isRfDetrTrustValid(null, "/tmp/model.pth", identity)).toBe(false);
  });

  test("missing runtime explains route setup for rfdetr only", () => {
    expect(getRfDetrMissingRuntimeMessage("rfdetr", null)).toBe(
      "Set up a route environment before export.",
    );
    expect(getRfDetrMissingRuntimeMessage("rfdetr", "/tmp/python")).toBeNull();
    expect(getRfDetrMissingRuntimeMessage("ultralytics", null)).toBeNull();
  });

  test("plus-only checkpoints stay blocked with the exact reason", () => {
    expect(getRfDetrPlusBlockReason(null)).toBeNull();
    expect(
      getRfDetrPlusBlockReason({
        success: false,
        class_symbol: "RFDETRXLarge",
        family: "detection",
        size: "xlarge",
        requires_plus: true,
        is_legacy: false,
        recommended_imgsz: null,
        patch_size: null,
        num_windows: null,
        required_multiple: null,
        token_grid: null,
        resolution_source: null,
        error: "RFDETRXLarge requires rfdetr_plus support and is not supported in v1.",
      }),
    ).toBe("RFDETRXLarge requires rfdetr_plus support and is not supported in v1.");
    expect(
      getRfDetrPlusBlockReason({
        success: true,
        class_symbol: "RFDETRSmall",
        family: "detection",
        size: "small",
        requires_plus: false,
        is_legacy: false,
        recommended_imgsz: 512,
        patch_size: 16,
        num_windows: 2,
        required_multiple: 32,
        token_grid: 32,
        resolution_source: "saved_model_config",
        error: null,
      }),
    ).toBeNull();
  });
});
