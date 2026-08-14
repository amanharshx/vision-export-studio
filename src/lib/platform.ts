import type { PlatformLock } from "./types";

export type AppOS = "macos" | "windows" | "linux";
export type AppArch = string;
export interface AppPlatform {
  os: AppOS;
  arch: AppArch;
}

export const UNKNOWN_ARCH = "unknown";

export function getOS(): AppOS {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  return "linux";
}

export function platformTags(lock: PlatformLock): string[] {
  switch (lock) {
    case "any": return [];
    case "linux": return ["Linux"];
    case "linux_x86_64": return ["Linux x86-64"];
    case "linux_windows": return ["Linux", "Windows"];
    case "macos": return ["macOS"];
    case "macos_arm64_linux_windows_x86_64": return ["macOS ARM64", "Linux x86-64", "Windows x86-64"];
    case "macos_linux": return ["macOS", "Linux"];
    case "macos_linux_x86_64": return ["macOS", "Linux x86-64"];
    case "windows": return ["Windows"];
  }
}

export function isCompatible(lock: PlatformLock, os: AppOS, arch: AppArch = UNKNOWN_ARCH): boolean {
  switch (lock) {
    case "any": return true;
    case "linux": return os === "linux";
    case "linux_x86_64": return os === "linux" && arch === "x86_64";
    case "linux_windows": return os === "linux" || os === "windows";
    case "macos": return os === "macos";
    case "macos_arm64_linux_windows_x86_64":
      return (os === "macos" && arch === "aarch64")
        || ((os === "linux" || os === "windows") && arch === "x86_64");
    case "macos_linux": return os === "macos" || os === "linux";
    case "macos_linux_x86_64":
      return os === "macos" || (os === "linux" && arch === "x86_64");
    case "windows": return os === "windows";
  }
}

export const OS_LABEL: Record<AppOS, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export const ARCH_LABEL: Record<string, string> = {
  aarch64: "ARM64",
  arm: "ARM",
  x86: "x86",
  x86_64: "x86-64",
  unknown: "unknown architecture",
};

export function platformLabel(os: AppOS, arch: AppArch): string {
  return `${OS_LABEL[os]} ${ARCH_LABEL[arch] ?? arch}`;
}

export function incompatibleReason(
  lock: PlatformLock,
  os: AppOS,
  arch: AppArch = UNKNOWN_ARCH,
): string | null {
  if (isCompatible(lock, os, arch)) return null;
  const current = (lock === "linux_x86_64" || lock === "macos_linux_x86_64") && os === "linux"
    ? platformLabel(os, arch)
    : OS_LABEL[os];
  const supported = platformTags(lock).join(" and ");
  return `This format is not supported on ${current}. Available on ${supported} only.`;
}
