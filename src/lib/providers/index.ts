import type { ProviderId, ProviderSpec, RouteSpec } from "@/lib/types";
import { rfdetrProvider, rfdetrRoutes } from "./rfdetr";
import { ultralyticsProvider, ultralyticsRoutes } from "./ultralytics";

export const providers: Record<ProviderId, ProviderSpec> = {
  ultralytics: ultralyticsProvider,
  rfdetr: rfdetrProvider,
};

export const routesByProvider: Record<ProviderId, RouteSpec[]> = {
  ultralytics: ultralyticsRoutes,
  rfdetr: rfdetrRoutes,
};

export function providerList(): ProviderSpec[] {
  return [providers.ultralytics, providers.rfdetr];
}

export function routesForProvider(providerId: ProviderId): RouteSpec[] {
  return routesByProvider[providerId];
}

export function defaultRouteForProvider(providerId: ProviderId): RouteSpec {
  return routesForProvider(providerId).find((item) => item.targetFormat === "onnx") ?? routesForProvider(providerId)[0];
}

export function findRoute(routeId: string): RouteSpec | undefined {
  return [...ultralyticsRoutes, ...rfdetrRoutes].find((route) => route.id === routeId);
}

export function hasAllowedSourceExtension(path: string, provider: ProviderSpec): boolean {
  const lower = path.trim().toLowerCase();
  return provider.sourceExtensions.some((extension) => lower.endsWith(extension));
}

export { rfdetrRoutes, ultralyticsRoutes };
