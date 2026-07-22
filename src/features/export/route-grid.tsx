import type { RouteSpec } from "@/lib/types";
import { isCompatible, platformLabel, type AppPlatform } from "@/lib/platform";
import { RouteRow } from "./route-card";

interface RouteGridProps {
  routes: RouteSpec[];
  platform: AppPlatform;
  onSelectRoute: (routeId: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function RouteGrid({ routes, platform, onSelectRoute, disabled = false, disabledReason }: RouteGridProps) {
  const compatible = routes.filter((r) => isCompatible(r.platformLock, platform.os, platform.arch));
  const incompatible = routes.filter((r) => !isCompatible(r.platformLock, platform.os, platform.arch));

  return (
    <div className="space-y-2">
      {compatible.map((route) => (
        <RouteRow
          key={route.id}
          route={route}
          platform={platform}
          onSelect={() => onSelectRoute(route.id)}
          disabled={disabled}
          disabledReason={disabledReason}
        />
      ))}
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
