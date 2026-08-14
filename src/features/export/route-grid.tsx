import type { RouteSpec } from "@/lib/types";
import { isCompatible, platformLabel, type AppPlatform } from "@/lib/platform";
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
  const compatibilityKnown = platformResolved && platform.arch !== "unknown";
  const compatible = compatibilityKnown
    ? routes.filter((r) => isCompatible(r.platformLock, platform.os, platform.arch))
    : routes;
  const incompatible = compatibilityKnown
    ? routes.filter((r) => !isCompatible(r.platformLock, platform.os, platform.arch))
    : [];

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
      {platformResolved && platform.arch === "unknown" && (
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
