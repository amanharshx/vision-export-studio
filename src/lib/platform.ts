import type { PlatformLock } from "./types";

export type AppOS = "macos" | "windows" | "linux";

export function getOS(): AppOS {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  return "linux";
}

export function platformTags(lock: PlatformLock): string[] {
  switch (lock) {
    case "any": return [];
    case "linux":
    case "linux_x86_64": return ["Linux"];
    case "linux_windows": return ["Linux", "Windows"];
    case "macos": return ["macOS"];
    case "macos_linux": return ["macOS", "Linux"];
    case "windows": return ["Windows"];
  }
}

export function isCompatible(lock: PlatformLock, os: AppOS): boolean {
  switch (lock) {
    case "any": return true;
    case "linux":
    case "linux_x86_64": return os === "linux";
    case "linux_windows": return os === "linux" || os === "windows";
    case "macos": return os === "macos";
    case "macos_linux": return os === "macos" || os === "linux";
    case "windows": return os === "windows";
  }
}

export const OS_LABEL: Record<AppOS, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export function incompatibleReason(lock: PlatformLock, os: AppOS): string | null {
  if (isCompatible(lock, os)) return null;
  const current = OS_LABEL[os];
  const supported = platformTags(lock).join(" and ");
  return `This format is not supported on ${current}. Available on ${supported} only.`;
}
