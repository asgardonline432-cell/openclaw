import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebFetchProviderEntry,
  WebFetchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebFetchProviders,
  resolveRuntimeWebFetchProviders,
} from "../plugins/web-fetch-providers.runtime.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "../web/provider-runtime-shared.js";

type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

export type ResolveWebFetchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};

type ResolvedWebFetchDefinition = {
  provider: PluginWebFetchProviderEntry;
  definition: WebFetchProviderToolDefinition;
};

let preparedWebFetchDefinitionsByConfig = new WeakMap<
  OpenClawConfig,
  Map<string, ResolvedWebFetchDefinition>
>();
const preparedWebFetchDefinitionsWithoutConfig = new Map<string, ResolvedWebFetchDefinition>();

export function resolveWebFetchEnabled(params: {
  fetch?: WebFetchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.fetch?.enabled === "boolean") {
    return params.fetch.enabled;
  }
  return true;
}

function resolveFetchConfig(config: OpenClawConfig | undefined): WebFetchConfig | undefined {
  return resolveWebProviderConfig(config, "fetch") as NonNullable<WebFetchConfig> | undefined;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebFetchProviderEntry,
    "envVars" | "getConfiguredCredentialValue" | "getCredentialValue" | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  fetch: WebFetchConfig | undefined,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: fetch as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig, toolConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig) ??
      currentProvider.getCredentialValue(toolConfig),
    resolveEnvValue: ({ provider: currentProvider }) =>
      readWebProviderEnvValue(currentProvider.envVars),
  });
}

export function isWebFetchProviderConfigured(params: {
  provider: Pick<
    PluginWebFetchProviderEntry,
    "envVars" | "getConfiguredCredentialValue" | "getCredentialValue" | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  return hasEntryCredential(params.provider, params.config, resolveFetchConfig(params.config));
}

export function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolveRuntimeWebFetchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function listConfiguredWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function resolveWebFetchProviderId(params: {
  fetch?: WebFetchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebFetchProviderEntry[];
  preferRuntimeProviders?: boolean;
}): string {
  const providers = sortWebFetchProvidersForAutoDetect(
    params.providers ??
      (params.preferRuntimeProviders
        ? resolveRuntimeWebFetchProviders({
            config: params.config,
            bundledAllowlistCompat: true,
          })
        : resolvePluginWebFetchProviders({
            config: params.config,
            bundledAllowlistCompat: true,
            origin: "bundled",
          })),
  );
  const raw =
    params.fetch && "provider" in params.fetch
      ? normalizeLowercaseStringOrEmpty(params.fetch.provider)
      : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  for (const provider of providers) {
    if (!providerRequiresCredential(provider)) {
      logVerbose(
        `web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected keyless provider "${provider.id}"`,
      );
      return provider.id;
    }
    if (!hasEntryCredential(provider, params.config, params.fetch)) {
      continue;
    }
    logVerbose(
      `web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected "${provider.id}" from available API keys`,
    );
    return provider.id;
  }

  return "";
}

function getPreparedWebFetchDefinitionCache(
  config: OpenClawConfig | undefined,
): Map<string, ResolvedWebFetchDefinition> {
  if (!config) {
    return preparedWebFetchDefinitionsWithoutConfig;
  }
  let cache = preparedWebFetchDefinitionsByConfig.get(config);
  if (!cache) {
    cache = new Map<string, ResolvedWebFetchDefinition>();
    preparedWebFetchDefinitionsByConfig.set(config, cache);
  }
  return cache;
}

function createPreparedWebFetchDefinitionCacheKey(params: {
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
}): string {
  return JSON.stringify({
    providerId: normalizeLowercaseStringOrEmpty(params.providerId),
    sandboxed: params.sandboxed === true,
    preferRuntimeProviders: params.preferRuntimeProviders === true,
    runtimeSelectedProvider: normalizeLowercaseStringOrEmpty(
      params.runtimeWebFetch?.selectedProvider,
    ),
    runtimeProviderConfigured: normalizeLowercaseStringOrEmpty(
      params.runtimeWebFetch?.providerConfigured,
    ),
    runtimeProviderSource: params.runtimeWebFetch?.providerSource ?? "",
    runtimeSelectedProviderKeySource: params.runtimeWebFetch?.selectedProviderKeySource ?? "",
  });
}

function readPreparedWebFetchDefinition(params: {
  config?: OpenClawConfig;
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
}): ResolvedWebFetchDefinition | undefined {
  return getPreparedWebFetchDefinitionCache(params.config).get(
    createPreparedWebFetchDefinitionCacheKey(params),
  );
}

function storePreparedWebFetchDefinition(params: {
  config?: OpenClawConfig;
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  resolved: ResolvedWebFetchDefinition;
}): ResolvedWebFetchDefinition {
  const cache = getPreparedWebFetchDefinitionCache(params.config);
  cache.set(createPreparedWebFetchDefinitionCacheKey(params), params.resolved);
  return params.resolved;
}

function resolveWebFetchDefinitionUncached(params: {
  config?: OpenClawConfig;
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
}): ResolvedWebFetchDefinition | null {
  const fetch = resolveWebProviderConfig(params.config, "fetch") as
    | NonNullable<WebFetchConfig>
    | undefined;
  const providers = sortWebFetchProvidersForAutoDetect(
    params.preferRuntimeProviders && !params.sandboxed
      ? resolveRuntimeWebFetchProviders({
          config: params.config,
          bundledAllowlistCompat: true,
        })
      : resolvePluginWebFetchProviders({
          config: params.config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        }),
  );
  return resolveWebProviderDefinition({
    config: params.config,
    toolConfig: fetch as Record<string, unknown> | undefined,
    runtimeMetadata: params.runtimeWebFetch,
    sandboxed: params.sandboxed,
    providerId: params.providerId,
    providers,
    resolveEnabled: ({ toolConfig, sandboxed }) =>
      resolveWebFetchEnabled({
        fetch: toolConfig as WebFetchConfig | undefined,
        sandboxed,
      }),
    resolveAutoProviderId: ({ config, toolConfig, providers }) =>
      resolveWebFetchProviderId({
        config,
        fetch: toolConfig as WebFetchConfig | undefined,
        providers,
        preferRuntimeProviders: params.preferRuntimeProviders,
      }),
    createTool: ({ provider, config, toolConfig, runtimeMetadata }) =>
      provider.createTool({
        config,
        fetchConfig: toolConfig,
        runtimeMetadata,
      }),
  });
}

export function prepareWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): ResolvedWebFetchDefinition | null {
  const runtimeWebFetch = options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadata()?.fetch;
  const prepared = readPreparedWebFetchDefinition({
    config: options?.config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebFetch,
  });
  if (prepared) {
    return prepared;
  }
  const resolved = resolveWebFetchDefinitionUncached({
    config: options?.config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebFetch,
  });
  if (!resolved) {
    return null;
  }
  return storePreparedWebFetchDefinition({
    config: options?.config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebFetch,
    resolved,
  });
}

export function resolveWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): ResolvedWebFetchDefinition | null {
  const runtimeWebFetch = options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadata()?.fetch;
  const prepared = readPreparedWebFetchDefinition({
    config: options?.config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebFetch,
  });
  if (prepared) {
    return prepared;
  }
  const resolved = resolveWebFetchDefinitionUncached({
    config: options?.config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebFetch,
  });
  if (!resolved) {
    return null;
  }
  return storePreparedWebFetchDefinition({
    config: options?.config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebFetch,
    resolved,
  });
}

export const __testing = {
  clearPreparedWebFetchDefinitionCache(): void {
    preparedWebFetchDefinitionsByConfig = new WeakMap<
      OpenClawConfig,
      Map<string, ResolvedWebFetchDefinition>
    >();
    preparedWebFetchDefinitionsWithoutConfig.clear();
  },
  createPreparedWebFetchDefinitionCacheKey,
};
