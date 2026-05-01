import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
} from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { OpenClawPluginToolContext } from "./types.js";

export type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();
const allowlistedRegistryEntriesCache = new WeakMap<
  object,
  Map<
    string,
    Array<{
      pluginId: string;
      source: string;
      optional: boolean;
      names?: string[];
      factory: (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
    }>
  >
>();
const pluginToolFactoryResultsCache = new WeakMap<
  object,
  Map<
    string,
    Map<
      object,
      {
        listRaw: unknown[];
      }
    >
  >
>();
const objectIdentityCache = new WeakMap<object, number>();
let nextObjectIdentity = 1;

export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

/**
 * Builds a collision-proof key for plugin-owned tool metadata lookups.
 */
export function buildPluginToolMetadataKey(pluginId: string, toolName: string): string {
  return JSON.stringify([pluginId, toolName]);
}

function normalizeAllowlist(list?: string[]) {
  return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.allowlist.has("group:plugins");
}

function isRegistryEntryAllowlisted(params: {
  names: readonly string[] | undefined;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return true;
  }
  if (
    params.allowlist.has(normalizeToolName(params.pluginId)) ||
    params.allowlist.has("group:plugins")
  ) {
    return true;
  }
  const names = params.names?.map((name) => normalizeToolName(name)).filter(Boolean) ?? [];
  if (names.length === 0) {
    return true;
  }
  return names.some((name) => params.allowlist.has(name));
}

function buildAllowlistCacheKey(allowlist: Set<string>): string {
  return allowlist.size === 0
    ? "*"
    : [...allowlist].toSorted((left, right) => left.localeCompare(right)).join(",");
}

function getObjectIdentity(value: object | undefined): number {
  if (!value) {
    return 0;
  }
  let cached = objectIdentityCache.get(value);
  if (cached) {
    return cached;
  }
  cached = nextObjectIdentity++;
  objectIdentityCache.set(value, cached);
  return cached;
}

function hasPerDeliveryPluginToolContext(context: OpenClawPluginToolContext): boolean {
  if (context.requesterSenderId?.trim()) {
    return true;
  }
  if (context.senderIsOwner !== undefined) {
    return true;
  }
  const deliveryContext = context.deliveryContext;
  return Boolean(
    deliveryContext &&
    (deliveryContext.channel ||
      deliveryContext.to ||
      deliveryContext.accountId ||
      deliveryContext.threadId !== undefined),
  );
}

function buildPluginToolFactoryCacheKey(params: {
  registry: object;
  allowlist: Set<string>;
  context: OpenClawPluginToolContext;
}): string | null {
  if (hasPerDeliveryPluginToolContext(params.context)) {
    return null;
  }
  return JSON.stringify([
    getObjectIdentity(params.registry),
    buildAllowlistCacheKey(params.allowlist),
    getObjectIdentity(params.context.config),
    getObjectIdentity(params.context.runtimeConfig),
    params.context.workspaceDir ?? "",
    params.context.agentDir ?? "",
    params.context.agentId ?? "",
    params.context.sessionKey ?? "",
    params.context.sessionId ?? "",
    params.context.browser?.sandboxBridgeUrl ?? "",
    params.context.browser?.allowHostControl === true,
    params.context.messageChannel ?? "",
    params.context.agentAccountId ?? "",
    params.context.fsPolicy?.workspaceOnly === true,
    params.context.sandboxed === true,
  ]);
}

function resolvePluginToolFactoryResult(params: {
  registry: object;
  entry: {
    factory: (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
  };
  context: OpenClawPluginToolContext;
  allowlist: Set<string>;
}): { listRaw: unknown[] } | null | undefined {
  const cacheKey = buildPluginToolFactoryCacheKey({
    registry: params.registry,
    allowlist: params.allowlist,
    context: params.context,
  });
  if (cacheKey) {
    let registryCache = pluginToolFactoryResultsCache.get(params.registry);
    if (!registryCache) {
      registryCache = new Map();
      pluginToolFactoryResultsCache.set(params.registry, registryCache);
    }
    let entryCache = registryCache.get(cacheKey);
    if (!entryCache) {
      entryCache = new Map();
      registryCache.set(cacheKey, entryCache);
    }
    const cached = entryCache.get(params.entry);
    if (cached) {
      return cached;
    }
    const resolved = params.entry.factory(params.context);
    if (!resolved) {
      return resolved;
    }
    const materialized = {
      listRaw: Array.isArray(resolved) ? resolved : [resolved],
    };
    entryCache.set(params.entry, materialized);
    return materialized;
  }
  const resolved = params.entry.factory(params.context);
  if (!resolved) {
    return resolved;
  }
  return {
    listRaw: Array.isArray(resolved) ? resolved : [resolved],
  };
}

function resolveAllowlistedRegistryEntries(params: {
  registry: {
    tools: Array<{
      pluginId: string;
      source: string;
      optional: boolean;
      names?: string[];
      factory: (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
    }>;
  };
  allowlist: Set<string>;
}) {
  if (params.allowlist.size === 0) {
    return params.registry.tools;
  }
  let cache = allowlistedRegistryEntriesCache.get(params.registry);
  if (!cache) {
    cache = new Map();
    allowlistedRegistryEntriesCache.set(params.registry, cache);
  }
  const cacheKey = buildAllowlistCacheKey(params.allowlist);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const filtered = params.registry.tools.filter((entry) =>
    isRegistryEntryAllowlisted({
      names: entry.names,
      pluginId: entry.pluginId,
      allowlist: params.allowlist,
    }),
  );
  cache.set(cacheKey, filtered);
  return filtered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPluginToolName(tool: unknown): string {
  if (!isRecord(tool)) {
    return "";
  }
  // Optional-tool allowlists need a best-effort name before full shape validation.
  return typeof tool.name === "string" ? tool.name.trim() : "";
}

function describeMalformedPluginTool(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return "tool must be an object";
  }
  const name = readPluginToolName(tool);
  if (!name) {
    return "missing non-empty name";
  }
  if (typeof tool.execute !== "function") {
    return `${name} missing execute function`;
  }
  if (!isRecord(tool.parameters)) {
    return `${name} missing parameters object`;
  }
  return undefined;
}

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  allowGatewaySubagentBinding?: boolean;
}) {
  if (
    params.allowGatewaySubagentBinding &&
    getActivePluginRegistryKey() &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable"
  ) {
    return getActivePluginRegistry() ?? resolveRuntimePluginRegistry(params.loadOptions);
  }
  return resolveRuntimePluginRegistry(params.loadOptions);
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const context = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.context.workspaceDir,
  });
  const normalized = normalizePluginsConfig(context.config.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    runtimeOptions,
  });
  const registry = resolvePluginToolRegistry({
    loadOptions,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  if (!registry) {
    return [];
  }

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();

  for (const entry of resolveAllowlistedRegistryEntries({ registry, allowlist })) {
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      if (!params.suppressNameConflicts) {
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
      }
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    let resolved: { listRaw: unknown[] } | null | undefined = null;
    try {
      resolved = resolvePluginToolFactoryResult({
        registry,
        entry,
        context: params.context,
        allowlist,
      });
    } catch (err) {
      context.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) {
      if ((entry.names?.length ?? 0) > 0) {
        context.logger.debug?.(
          `plugin tool factory returned null (${entry.pluginId}): [${entry.names?.join(", ") ?? ""}]`,
        );
      }
      continue;
    }
    const list = entry.optional
      ? resolved.listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: readPluginToolName(tool),
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : resolved.listRaw;
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const toolRaw of list) {
      // Plugin factories run at request time and can return arbitrary values; isolate
      // malformed tools here so one bad plugin tool cannot poison every provider.
      const malformedReason = describeMalformedPluginTool(toolRaw);
      if (malformedReason) {
        const message = `plugin tool is malformed (${entry.pluginId}): ${malformedReason}`;
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      const tool = toolRaw as AnyAgentTool;
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        if (!params.suppressNameConflicts) {
          context.logger.error(message);
          registry.diagnostics.push({
            level: "error",
            pluginId: entry.pluginId,
            source: entry.source,
            message,
          });
        }
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      tools.push(tool);
    }
  }

  return tools;
}
