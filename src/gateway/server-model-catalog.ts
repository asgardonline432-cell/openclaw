import { getRuntimeConfig } from "../config/io.js";

export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;
export type GatewayModelCatalogMode = "cacheOnly" | "cachePreferred" | "runtimeDiscovery";

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadModelCatalog = (params: {
  config: GatewayModelCatalogConfig;
  intent?: Exclude<GatewayModelCatalogMode, "cachePreferred">;
  source?: string;
}) => Promise<GatewayModelChoice[]>;
type LoadGatewayModelCatalogParams = {
  getConfig?: () => GatewayModelCatalogConfig;
  loadModelCatalog?: LoadModelCatalog;
  mode?: GatewayModelCatalogMode;
};

let lastSuccessfulCacheOnlyCatalog: GatewayModelChoice[] | null = null;
let lastSuccessfulRuntimeDiscoveryCatalog: GatewayModelChoice[] | null = null;
let inFlightRefresh: Promise<GatewayModelChoice[]> | null = null;
let inFlightRuntimeDiscoveryRefresh: Promise<GatewayModelChoice[]> | null = null;
let staleGeneration = 0;
let appliedCacheOnlyGeneration = 0;
let appliedRuntimeDiscoveryGeneration = 0;

function resetGatewayModelCatalogState(): void {
  lastSuccessfulCacheOnlyCatalog = null;
  lastSuccessfulRuntimeDiscoveryCatalog = null;
  inFlightRefresh = null;
  inFlightRuntimeDiscoveryRefresh = null;
  staleGeneration = 0;
  appliedCacheOnlyGeneration = 0;
  appliedRuntimeDiscoveryGeneration = 0;
}

function isGatewayModelCatalogStale(
  mode: Exclude<GatewayModelCatalogMode, "cachePreferred">,
): boolean {
  return (
    (mode === "runtimeDiscovery" ? appliedRuntimeDiscoveryGeneration : appliedCacheOnlyGeneration) <
    staleGeneration
  );
}

async function resolveLoadModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadModelCatalog> {
  if (params?.loadModelCatalog) {
    return params.loadModelCatalog;
  }
  const { loadModelCatalog } = await import("../agents/model-catalog.js");
  return loadModelCatalog;
}

function startGatewayModelCatalogRefresh(
  mode: Exclude<GatewayModelCatalogMode, "cachePreferred">,
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const refreshGeneration = staleGeneration;
  const refresh = resolveLoadModelCatalog(params)
    .then((loadModelCatalog) =>
      loadModelCatalog({
        config,
        intent: mode,
        source:
          mode === "runtimeDiscovery"
            ? "gateway.model-catalog.runtime-discovery"
            : "gateway.model-catalog",
      }),
    )
    .then((catalog) => {
      if (catalog.length > 0 && refreshGeneration === staleGeneration) {
        if (mode === "runtimeDiscovery") {
          lastSuccessfulRuntimeDiscoveryCatalog = catalog;
          appliedRuntimeDiscoveryGeneration = staleGeneration;
        } else {
          lastSuccessfulCacheOnlyCatalog = catalog;
          appliedCacheOnlyGeneration = staleGeneration;
        }
      }
      return catalog;
    })
    .finally(() => {
      if (mode === "runtimeDiscovery") {
        if (inFlightRuntimeDiscoveryRefresh === refresh) {
          inFlightRuntimeDiscoveryRefresh = null;
        }
        return;
      }
      if (inFlightRefresh === refresh) {
        inFlightRefresh = null;
      }
    });
  if (mode === "runtimeDiscovery") {
    inFlightRuntimeDiscoveryRefresh = refresh;
  } else {
    inFlightRefresh = refresh;
  }
  return refresh;
}

export function markGatewayModelCatalogStaleForReload(): void {
  staleGeneration += 1;
}

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export async function __resetModelCatalogCacheForTest(): Promise<void> {
  resetGatewayModelCatalogState();
  const { resetModelCatalogCacheForTest } = await import("../agents/model-catalog.js");
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const mode = params?.mode ?? "cacheOnly";
  if (mode === "cachePreferred") {
    const isRuntimeDiscoveryStale = isGatewayModelCatalogStale("runtimeDiscovery");
    if (!isRuntimeDiscoveryStale && lastSuccessfulRuntimeDiscoveryCatalog) {
      return lastSuccessfulRuntimeDiscoveryCatalog;
    }
    if (isRuntimeDiscoveryStale && lastSuccessfulRuntimeDiscoveryCatalog) {
      if (!inFlightRuntimeDiscoveryRefresh) {
        void startGatewayModelCatalogRefresh("runtimeDiscovery", params).catch(() => undefined);
      }
      return lastSuccessfulRuntimeDiscoveryCatalog;
    }
    if (inFlightRuntimeDiscoveryRefresh) {
      return await inFlightRuntimeDiscoveryRefresh;
    }
    return await startGatewayModelCatalogRefresh("runtimeDiscovery", params);
  }
  if (mode === "runtimeDiscovery") {
    const isRuntimeDiscoveryStale = isGatewayModelCatalogStale("runtimeDiscovery");
    if (!isRuntimeDiscoveryStale && lastSuccessfulRuntimeDiscoveryCatalog) {
      return lastSuccessfulRuntimeDiscoveryCatalog;
    }
    if (isRuntimeDiscoveryStale && lastSuccessfulRuntimeDiscoveryCatalog) {
      if (!inFlightRuntimeDiscoveryRefresh) {
        void startGatewayModelCatalogRefresh("runtimeDiscovery", params).catch(() => undefined);
      }
      return lastSuccessfulRuntimeDiscoveryCatalog;
    }
    if (inFlightRuntimeDiscoveryRefresh) {
      return await inFlightRuntimeDiscoveryRefresh;
    }
    return await startGatewayModelCatalogRefresh("runtimeDiscovery", params);
  }
  const isCacheOnlyStale = isGatewayModelCatalogStale("cacheOnly");
  if (!isCacheOnlyStale && lastSuccessfulCacheOnlyCatalog) {
    return lastSuccessfulCacheOnlyCatalog;
  }
  if (isCacheOnlyStale && lastSuccessfulCacheOnlyCatalog) {
    if (!inFlightRefresh) {
      void startGatewayModelCatalogRefresh("cacheOnly", params).catch(() => undefined);
    }
    return lastSuccessfulCacheOnlyCatalog;
  }
  if (inFlightRefresh) {
    return await inFlightRefresh;
  }
  return await startGatewayModelCatalogRefresh("cacheOnly", params);
}
