import type { RouteSpec } from "@/lib/types";
import { architectureMatters, isCompatible, platformLabel, type AppPlatform, UNKNOWN_ARCH } from "@/lib/platform";
import { RouteRow } from "./route-card";

interface RouteGridProps {
  routes: RouteSpec[];
  platform: AppPlatform;
  platformResolved: boolean;
  onSelectRoute: (routeId: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function RouteGrid({ routes, platform, platformResolved, onSelectRoute, disabled = false, disabledReason }: RouteGridProps) {
  const defersToRust = (route: RouteSpec) => !platformResolved
    || (platform.arch === UNKNOWN_ARCH && architectureMatters(route.platformLock, platform.os));
  const compatible = routes.filter(
    (route) => defersToRust(route) || isCompatible(route.platformLock, platform.os, platform.arch),
  );
  const incompatible = routes.filter(
    (route) => !defersToRust(route) && !isCompatible(route.platformLock, platform.os, platform.arch),
  );
  const hasDeferredRoutes = routes.some(defersToRust);

  return (
    <div className="space-y-2">
      {compatible.map((route) => (
        <RouteRow
          key={route.id}
          route={route}
          platform={platform}
          platformResolved={platformResolved}
          onSelect={() => onSelectRoute(route.id)}
          disabled={disabled}
          disabledReason={disabledReason}
        />
      ))}
      {platformResolved && platform.arch === UNKNOWN_ARCH && hasDeferredRoutes && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Architecture unavailable; compatibility is checked before export.
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
              platform={platform}
              platformResolved={platformResolved}
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
