import { ultralyticsRoutes } from "@/lib/routes";
import { RouteCard } from "./route-card";

interface RouteGridProps {
  selectedRouteId: string;
  onSelectRoute: (routeId: string) => void;
}

export function RouteGrid({ selectedRouteId, onSelectRoute }: RouteGridProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-zinc-950">Targets</h2>
        <span className="text-sm text-zinc-600">{ultralyticsRoutes.length} routes</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ultralyticsRoutes.map((route) => (
          <RouteCard
            key={route.id}
            route={route}
            active={route.id === selectedRouteId}
            onSelect={() => onSelectRoute(route.id)}
          />
        ))}
      </div>
    </section>
  );
}
