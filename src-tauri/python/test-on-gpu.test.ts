// @ts-expect-error Bun provides this module at test runtime.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("RF-DETR GPU smoke script no longer references removed TFLite route", () => {
  const script = readFileSync(join(import.meta.dir, "test-on-gpu.sh"), "utf8");

  expect(script).not.toContain("rfdetr.pth.tflite");
  expect(script).not.toContain("rfdetr[onnx,tflite]");
  expect(script).not.toContain("TFLite");
});
