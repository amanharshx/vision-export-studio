// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { getExportFailedUserMessage, getIncompatibleExportMessage, getResolvedOutputDir } from "./export-workspace";
import { getExportFooterActions } from "./export-modal";
import { findRoute } from "@/lib/providers";

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

describe("getExportFailedUserMessage", () => {
  test("uses backend failure payload when export process fails", () => {
    expect(getExportFailedUserMessage("exit code: 1")).toBe("Export failed: exit code: 1");
  });

  test("falls back when backend failure payload is empty", () => {
    expect(getExportFailedUserMessage("")).toBe("Export failed.");
  });
});

describe("getIncompatibleExportMessage", () => {
  const engineRoute = findRoute("ultralytics.pt.engine")!;
  const onnxRoute = findRoute("ultralytics.pt.onnx")!;
  const coremlRoute = findRoute("ultralytics.pt.coreml")!;
  const rknnRoute = findRoute("ultralytics.pt.rknn")!;

  test("returns null for a cross-platform route on any OS", () => {
    expect(getIncompatibleExportMessage(onnxRoute, "macos")).toBeNull();
    expect(getIncompatibleExportMessage(onnxRoute, "windows")).toBeNull();
    expect(getIncompatibleExportMessage(onnxRoute, "linux")).toBeNull();
  });

  test("blocks TensorRT on macOS with the route's unsupported note", () => {
    expect(getIncompatibleExportMessage(engineRoute, "macos")).toBe(engineRoute.unsupportedNote);
  });

  test("allows TensorRT on Linux and Windows", () => {
    expect(getIncompatibleExportMessage(engineRoute, "linux")).toBeNull();
    expect(getIncompatibleExportMessage(engineRoute, "windows")).toBeNull();
  });

  test("blocks CoreML on non-macOS per its declared lock", () => {
    expect(getIncompatibleExportMessage(coremlRoute, "windows")).toBe(coremlRoute.unsupportedNote);
    expect(getIncompatibleExportMessage(coremlRoute, "linux")).toBe(coremlRoute.unsupportedNote);
    expect(getIncompatibleExportMessage(coremlRoute, "macos")).toBeNull();
  });

  test("blocks Linux-only vendor routes on macOS and Windows", () => {
    expect(getIncompatibleExportMessage(rknnRoute, "macos")).toBe(rknnRoute.unsupportedNote);
    expect(getIncompatibleExportMessage(rknnRoute, "windows")).toBe(rknnRoute.unsupportedNote);
    expect(getIncompatibleExportMessage(rknnRoute, "linux")).toBeNull();
  });
});
