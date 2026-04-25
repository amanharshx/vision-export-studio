import { ultralyticsRoutes } from "@/lib/routes";
import { getOS, isCompatible, OS_LABEL } from "@/lib/platform";
import { RouteRow } from "./route-card";

const os = getOS();

interface RouteGridProps {
  onSelectRoute: (routeId: string) => void;
}

export function RouteGrid({ onSelectRoute }: RouteGridProps) {
  const compatible = ultralyticsRoutes.filter((r) => isCompatible(r.platformLock, os));
  const incompatible = ultralyticsRoutes.filter((r) => !isCompatible(r.platformLock, os));

  return (
    <div className="space-y-2">
      {compatible.map((route) => (
        <RouteRow
          key={route.id}
          route={route}
          onSelect={() => onSelectRoute(route.id)}
        />
      ))}
      {incompatible.length > 0 && (
        <>
          <p className="pt-2 text-sm font-medium text-zinc-400">Unsupported on {OS_LABEL[os]}</p>
          {incompatible.map((route) => (
            <RouteRow
              key={route.id}
              route={route}
              onSelect={() => onSelectRoute(route.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}
