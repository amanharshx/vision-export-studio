// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { getResolvedOutputDir } from "./export-workspace";
import { getExportFooterActions } from "./export-modal";

describe("getResolvedOutputDir", () => {
  test("uses explicit output directory when provided", () => {
    expect(getResolvedOutputDir("/models/best.pt", "/tmp/exports")).toBe("/tmp/exports");
  });

  test("derives export directory beside Unix source path", () => {
    expect(getResolvedOutputDir("/models/best.pt", "")).toBe("/models/vision-export-studio-exports");
  });

  test("derives export directory beside Windows source path", () => {
    expect(getResolvedOutputDir("C:\\models\\best.pt", "")).toBe("C:\\models\\vision-export-studio-exports");
  });

  test("returns empty string when source path has no parent directory", () => {
    expect(getResolvedOutputDir("best.pt", "")).toBe("");
  });
});

describe("getExportFooterActions", () => {
  test("uses folder action as primary when export finished", () => {
    expect(getExportFooterActions({ exportStatus: "finished", hasCompletedOutputDir: true })).toEqual({
      secondary: "export_again",
      primary: "show_folder",
    });
  });

  test("keeps retry as primary after failed export", () => {
    expect(getExportFooterActions({ exportStatus: "failed", hasCompletedOutputDir: false })).toEqual({
      secondary: "cancel",
      primary: "export",
    });
  });

  test("keeps retry as primary after cancelled export", () => {
    expect(getExportFooterActions({ exportStatus: "cancelled", hasCompletedOutputDir: false })).toEqual({
      secondary: "cancel",
      primary: "export",
    });
  });
});
