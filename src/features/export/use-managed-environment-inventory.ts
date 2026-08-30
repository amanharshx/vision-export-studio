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
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const inFlight = useRef(new Map<string, Promise<ManagedEnvironmentScanResult[]>>());
  const completed = useRef(new Map<string, { generation: number; results: ManagedEnvironmentScanResult[] }>());

  const invalidate = useCallback((keys?: ManagedEnvironmentKey[]) => {
    generation.current += 1;
    if (!keys) completed.current.clear();
    else for (const [requestKey, entry] of completed.current) {
      if (keys.includes("rfdetr-all") || entry.results.some((result) => keys.includes(result.key as ManagedEnvironmentKey))) {
        completed.current.delete(requestKey);
      }
    }
    setSizes((current) => {
      if (!keys) return {};
      const next = { ...current };
      if (keys.includes("rfdetr-all")) {
        Object.keys(next).filter((key) => key.startsWith("rfdetr-")).forEach((key) => delete next[key]);
      } else {
        keys.forEach((key) => delete next[key]);
      }
      return next;
    });
  }, []);

  const scanProvider = useCallback(async (providerId: ProviderId, singleKey?: ManagedEnvironmentKey) => {
    const keys = keysForProvider(providerId, singleKey);
    const requestKey = keys.join(",");
    const existingRequest = inFlight.current.get(requestKey);
    if (existingRequest) return existingRequest;
    const previous = completed.current.get(requestKey);
    if (previous?.generation === generation.current) return previous.results;
    const cached = keys.map((key) => sizesRef.current[key]).filter(Boolean);
    if (singleKey && cached.length === keys.length && cached.every((result) => result.status === "available" || result.status === "unavailable")) {
      return cached;
    }
    const requestGeneration = generation.current;
    if (singleKey || providerId === "ultralytics") setSizes((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, {
        key,
        status: "calculating",
        estimated_logical_bytes: null,
        size_error: null,
        exists: null,
      } satisfies ManagedEnvironmentScanResult])),
    }));
    const request = (async () => {
      const result = await scanManagedEnvironments(keys);
      if (requestGeneration === generation.current) {
        setSizes((current) => {
          const next = { ...current };
          keys.forEach((key) => delete next[key]);
          result.forEach((item) => { next[item.key] = item; });
          return next;
        });
        completed.current.set(requestKey, { generation: requestGeneration, results: result });
      }
      return result;
    })();
    inFlight.current.set(requestKey, request);
    try {
      return await request;
    } catch (error) {
      if (requestGeneration === generation.current) setSizes((current) => {
        const next = { ...current };
        keys.forEach((key) => { if (next[key]?.status === "calculating") delete next[key]; });
        return next;
      });
      throw error;
    } finally {
      if (inFlight.current.get(requestKey) === request) inFlight.current.delete(requestKey);
    }
  }, []);

  return { sizes, scanProvider, invalidate };
}
