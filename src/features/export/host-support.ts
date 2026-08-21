import type { AppPlatform } from "@/lib/platform";
import { architectureMatters, incompatibleReason, isCompatible, UNKNOWN_ARCH } from "@/lib/platform";
import type { HostSupportResult } from "@/lib/tauri/app";
import type { RouteSpec } from "@/lib/types";

function requiresRustVersionCheck(route: RouteSpec, platform: AppPlatform): boolean {
  return route.platformLock === "macos_arm64_linux_windows_x86_64"
    && platform.os === "macos"
    && platform.arch === "aarch64";
}

function canUseProvisionalPlatformResult(
  route: RouteSpec,
  platform: AppPlatform,
  platformResolved: boolean,
): boolean {
  if (!platformResolved || requiresRustVersionCheck(route, platform)) return false;
  return !(platform.arch === UNKNOWN_ARCH && architectureMatters(route.platformLock, platform.os));
}

export function getEffectiveHostSupportResult(
  route: RouteSpec,
  platform: AppPlatform,
  platformResolved: boolean,
  results: HostSupportResult[] | null,
): HostSupportResult | null {
  const authoritative = results?.find((result) => result.route_id === route.id) ?? null;
  if (authoritative) return authoritative;
  if (!canUseProvisionalPlatformResult(route, platform, platformResolved)) return null;
  const supported = isCompatible(route.platformLock, platform.os, platform.arch);
  return {
    route_id: route.id,
    status: supported ? "supported" : "unsupported",
    reason: supported
      ? undefined
      : route.unsupportedNote ?? incompatibleReason(route.platformLock, platform.os, platform.arch) ?? "Host platform is unsupported.",
  };
}

export function getHostSupportResult(
  results: HostSupportResult[],
  routeId: string,
): HostSupportResult | null {
  return results.find((result) => result.route_id === routeId) ?? null;
}
