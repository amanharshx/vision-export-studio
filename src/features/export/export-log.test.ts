// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { getLogStatusBadge, getLogStatusLabel } from "./export-log";

describe("getLogStatusLabel", () => {
  test("shows installing while dependencies are installing", () => {
    expect(getLogStatusLabel("idle", "installing")).toBe("Installing");
  });

  test("shows preparing instead of idle before export starts", () => {
    expect(getLogStatusLabel("idle", "idle")).toBe("Preparing");
  });

  test("maps all export statuses to user-facing labels", () => {
    expect(getLogStatusLabel("starting", "idle")).toBe("Starting");
    expect(getLogStatusLabel("running", "idle")).toBe("Running");
    expect(getLogStatusLabel("finished", "idle")).toBe("Success");
    expect(getLogStatusLabel("failed", "idle")).toBe("Failed");
    expect(getLogStatusLabel("cancelled", "idle")).toBe("Cancelled");
  });

  test("installing overrides non-idle export statuses", () => {
    expect(getLogStatusLabel("running", "installing")).toBe("Installing");
  });

  test("shows failed when dependency install fails before export starts", () => {
    expect(getLogStatusLabel("idle", "failed")).toBe("Failed");
  });
});

describe("getLogStatusBadge", () => {
  test("uses installing spinner and tone for any export status while installing", () => {
    expect(getLogStatusBadge("failed", "installing")).toEqual({
      label: "Installing",
      tone: "active",
      spinner: true,
    });
  });
});
