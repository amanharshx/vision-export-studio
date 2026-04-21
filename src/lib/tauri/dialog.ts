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
