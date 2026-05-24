import { open } from "@tauri-apps/plugin-dialog";

export async function openModelFilePicker(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: [{ name: "PyTorch Weights", extensions: ["pt"] }],
  });
  // open() with multiple:false returns string | string[] | null per plugin types.
  // In practice it returns string | null, but guard against array defensively.
  if (typeof result === "string") return result;
  return null;
}

export async function openCalibrationDataPicker(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Dataset YAML", extensions: ["yaml", "yml"] }],
  });
  return typeof result === "string" ? result : null;
}

export async function openPythonExecutablePicker(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
  });
  return typeof result === "string" ? result : null;
}

export async function openRuntimeDirPicker(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: true,
  });
  return typeof result === "string" ? result : null;
}

export async function openOutputDirPicker(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: true,
  });
  return typeof result === "string" ? result : null;
}
