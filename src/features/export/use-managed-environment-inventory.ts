import { useCallback, useRef, useState } from "react";
import { scanManagedEnvironments } from "@/lib/tauri/managed-environments";
import type { ManagedEnvironmentKey, ManagedEnvironmentScanResult, ProviderId } from "@/lib/types";

export interface ManagedEnvironmentInventoryController {
  sizes: Record<string, ManagedEnvironmentScanResult>;
  scanProvider(providerId: ProviderId, singleKey?: ManagedEnvironmentKey): Promise<ManagedEnvironmentScanResult[]>;
  invalidate(keys?: ManagedEnvironmentKey[]): void;
}

const keysForProvider = (providerId: ProviderId, singleKey?: ManagedEnvironmentKey): ManagedEnvironmentKey[] =>
  providerId === "ultralytics" ? ["ultralytics-managed"] : [singleKey ?? "rfdetr-all"];

export function useManagedEnvironmentInventory(): ManagedEnvironmentInventoryController {
  const [sizes, setSizes] = useState<Record<string, ManagedEnvironmentScanResult>>({});
  const generation = useRef(0);

  const invalidate = useCallback((keys?: ManagedEnvironmentKey[]) => {
    generation.current += 1;
    setSizes((current) => {
      if (!keys) return {};
      const next = { ...current };
      keys.forEach((key) => delete next[key]);
      return next;
    });
  }, []);

  const scanProvider = useCallback(async (providerId: ProviderId, singleKey?: ManagedEnvironmentKey) => {
    const keys = keysForProvider(providerId, singleKey);
    const cached = keys.map((key) => sizes[key]).filter(Boolean);
    if (cached.length === keys.length && cached.every((result) => result.status === "available" || result.status === "unavailable")) {
      return cached;
    }
    const requestGeneration = generation.current;
    setSizes((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, {
        key,
        status: "calculating",
        estimated_logical_bytes: null,
        size_error: null,
        exists: null,
      } satisfies ManagedEnvironmentScanResult])),
    }));
    try {
      const result = await scanManagedEnvironments(keys);
      if (requestGeneration === generation.current) setSizes((current) => ({ ...current, ...Object.fromEntries(result.map((item) => [item.key, item])) }));
      return result;
    } catch (error) {
      if (requestGeneration === generation.current) setSizes((current) => {
        const next = { ...current };
        keys.forEach((key) => { if (next[key]?.status === "calculating") delete next[key]; });
        return next;
      });
      throw error;
    }
  }, [sizes]);

  return { sizes, scanProvider, invalidate };
}
