// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findRoute } from "@/lib/providers";
import type { HostSupportResult } from "@/lib/tauri/app";
import { HostSupportBadge, HostSupportReason } from "./export-modal";
import { getEffectiveHostSupportResult } from "./host-support";
import { RouteGrid } from "./route-grid";

describe("getEffectiveHostSupportResult", () => {
  test("keeps version-gated macOS route checking until Rust responds", () => {
    const route = findRoute("rfdetr.pth.executorch")!;

    expect(getEffectiveHostSupportResult(route, { os: "macos", arch: "aarch64" }, true, null)).toBeNull();
  });

  test("uses TypeScript provisional result for fully classifiable platform locks", () => {
    const route = findRoute("rfdetr.pth.coreml")!;

    expect(getEffectiveHostSupportResult(route, { os: "windows", arch: "x86_64" }, true, null)).toEqual({
      route_id: route.id,
      status: "unsupported",
      reason: route.unsupportedNote,
    });
  });

  test("authoritative result renders consistently in grid and modal consumers", () => {
    const route = findRoute("rfdetr.pth.coreml")!;
    const result: HostSupportResult = {
      route_id: route.id,
      status: "unsupported",
      reason: "This format is not supported on Windows.",
    };
    const gridHtml = renderToStaticMarkup(
      React.createElement(RouteGrid, {
        routes: [route],
        platform: { os: "windows", arch: "x86_64" },
        hostSupportResults: [result],
        onSelectRoute: () => {},
      }),
    );
    const badgeHtml = renderToStaticMarkup(React.createElement(HostSupportBadge, { result }));
    const reasonHtml = renderToStaticMarkup(React.createElement(HostSupportReason, { result }));

    expect(gridHtml).toContain("Unsupported on Windows x86-64");
    expect(badgeHtml).toContain("Unsupported");
    expect(reasonHtml).toContain(result.reason);
  });

  test("disables version-gated route while host result is checking", () => {
    const route = findRoute("rfdetr.pth.executorch")!;
    const html = renderToStaticMarkup(
      React.createElement(RouteGrid, {
        routes: [route],
        platform: { os: "macos", arch: "aarch64" },
        hostSupportResults: [],
        onSelectRoute: () => {},
      }),
    );

    expect(html).toContain("Host compatibility is being checked before export.");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Checking host compatibility");
  });

  test("renders failed host checks as unavailable, not unsupported", () => {
    const route = findRoute("rfdetr.pth.onnx")!;
    const html = renderToStaticMarkup(
      React.createElement(RouteGrid, {
        routes: [route],
        platform: { os: "linux", arch: "x86_64" },
        hostSupportResults: [{ route_id: route.id, status: "error", reason: "unknown route" }],
        onSelectRoute: () => {},
      }),
    );

    expect(html).toContain("Unavailable");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Unsupported on");
  });

  test("authoritative Rust result overrides provisional compatibility", () => {
    const route = findRoute("rfdetr.pth.executorch")!;
    const result: HostSupportResult = {
      route_id: route.id,
      status: "unsupported",
      reason: "This format is not supported on macOS 13. RF-DETR ExecuTorch requires macOS 14 or newer.",
    };

    expect(getEffectiveHostSupportResult(route, { os: "macos", arch: "aarch64" }, true, [result])?.status).toBe("unsupported");
  });

  test("unknown authoritative result fails closed", () => {
    const route = findRoute("rfdetr.pth.onnx")!;
    const result: HostSupportResult = {
      route_id: route.id,
      status: "error",
      reason: "unknown route",
    };

    expect(getEffectiveHostSupportResult(route, { os: "linux", arch: "x86_64" }, true, [result])?.status).toBe("error");
  });
});
