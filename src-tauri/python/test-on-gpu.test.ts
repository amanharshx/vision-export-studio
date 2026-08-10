// @ts-expect-error Bun provides this module at test runtime.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("RF-DETR GPU smoke script uses native TensorRT prerequisites", () => {
  const script = readFileSync(join(import.meta.dir, "test-on-gpu.sh"), "utf8");

  expect(script).not.toContain("rfdetr.pth.tflite");
  expect(script).not.toContain("rfdetr[onnx,tflite]");
  expect(script).not.toContain("TFLite");
  expect(script).not.toContain("trtexec");
  expect(script).not.toContain("inference_model.engine");
  expect(script).toContain('rfdetr[onnx,tensorrt]>=1.7.1');
  expect(script).toContain("command -v nvidia-smi >/dev/null 2>&1 && \"$PY\" -c 'import tensorrt'");
  expect(script).toContain('`.trt`');
  expect(script).toContain('--precision fp32');
});
