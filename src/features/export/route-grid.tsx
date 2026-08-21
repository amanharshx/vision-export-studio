import type { RouteSpec } from "@/lib/types";
import { platformLabel, type AppPlatform } from "@/lib/platform";
import { RouteRow } from "./route-card";
import { getHostSupportResult } from "./host-support";
import type { HostSupportResult } from "@/lib/tauri/app";

interface RouteGridProps {
  routes: RouteSpec[];
  platform: AppPlatform;
  hostSupportResults: HostSupportResult[];
  onSelectRoute: (routeId: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function RouteGrid({ routes, platform, hostSupportResults, onSelectRoute, disabled = false, disabledReason }: RouteGridProps) {
  const hostStatus = (route: RouteSpec) => getHostSupportResult(hostSupportResults, route.id)?.status ?? "checking";
  const compatible = routes.filter(
    (route) => hostStatus(route) === "supported" || hostStatus(route) === "checking",
  );
  const incompatible = routes.filter(
    (route) => hostStatus(route) === "unsupported",
  );
  const unavailable = routes.filter(
    (route) => hostStatus(route) === "error",
  );
  const hasDeferredRoutes = routes.some((route) => hostStatus(route) === "checking");

  return (
    <div className="space-y-2">
      {compatible.map((route) => (
        <RouteRow
          key={route.id}
          route={route}
          hostStatus={hostStatus(route)}
          onSelect={() => onSelectRoute(route.id)}
          disabled={disabled}
          disabledReason={disabledReason}
        />
      ))}
      {hasDeferredRoutes && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Host compatibility is being checked before export.
        </p>
      )}
      {incompatible.length > 0 && (
        <>
          <p className="pt-2 text-sm font-medium text-zinc-400">
            Unsupported on {platformLabel(platform.os, platform.arch)}
          </p>
          {incompatible.map((route) => (
            <RouteRow
              key={route.id}
              route={route}
              hostStatus={hostStatus(route)}
              onSelect={() => onSelectRoute(route.id)}
              disabled={disabled}
              disabledReason={disabledReason}
            />
          ))}
        </>
      )}
      {unavailable.length > 0 && (
        <>
          <p className="pt-2 text-sm font-medium text-zinc-400">
            Unavailable
          </p>
          {unavailable.map((route) => (
            <RouteRow
              key={route.id}
              route={route}
              hostStatus={hostStatus(route)}
              onSelect={() => onSelectRoute(route.id)}
              disabled={disabled}
              disabledReason={disabledReason}
            />
          ))}
        </>
      )}
    </div>
  );
}
