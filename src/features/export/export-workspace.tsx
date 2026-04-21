import { EnvironmentStatus } from "@/features/environment/environment-status";
import { defaultRoute, ultralyticsRoutes } from "@/lib/routes";
import { useMemo, useState } from "react";
import { DropZone } from "./drop-zone";
import { RouteDetails } from "./route-details";
import { RouteGrid } from "./route-grid";

export function ExportWorkspace() {
  const [selectedRouteId, setSelectedRouteId] = useState(defaultRoute.id);
  const selectedRoute = useMemo(
    () => ultralyticsRoutes.find((route) => route.id === selectedRouteId) ?? defaultRoute,
    [selectedRouteId],
  );

  return (
    <main className="min-h-screen px-5 py-5 text-zinc-950 md:px-8 md:py-7">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-5 border-b border-zinc-900/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase text-teal-700">Local export studio</p>
            <h1 className="text-4xl font-semibold text-zinc-950 md:text-6xl">YOLO Export Studio</h1>
            <p className="max-w-2xl text-base leading-7 text-zinc-700">
              High-fidelity desktop wrapper for Ultralytics export routes, dependency checks,
              and local `yolo export` runs.
            </p>
          </div>
          <EnvironmentStatus />
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_390px]">
          <div className="space-y-5">
            <DropZone />
            <RouteGrid selectedRouteId={selectedRoute.id} onSelectRoute={setSelectedRouteId} />
          </div>
          <RouteDetails route={selectedRoute} />
        </section>
      </div>
    </main>
  );
}
