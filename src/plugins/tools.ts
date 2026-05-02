import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildToolPlan } from "../tools/planner.js";
import type { ToolAvailabilityExpression, ToolDescriptor } from "../tools/types.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { hasManifestToolAvailability } from "./manifest-tool-availability.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
} from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { buildPluginToolAvailabilityContext } from "./tool-availability-context.js";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";
import { listPluginManifestToolDescriptors } from "./tool-descriptors.js";
import type { OpenClawPluginToolContext } from "./types.js";

export type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

type PluginToolFactoryTimingResult = "array" | "error" | "null" | "single";

type PluginToolFactoryTiming = {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  result: PluginToolFactoryTimingResult;
  resultCount: number;
  optional: boolean;
};

const log = createSubsystemLogger("plugins/tools");
const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5_000;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1_000;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

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

function isOptionalToolEntryPotentiallyAllowed(params: {
  names: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey) || params.allowlist.has("group:plugins")) {
    return true;
  }
  if (params.names.length === 0) {
    return true;
  }
  return params.names.some((name) => params.allowlist.has(normalizeToolName(name)));
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

function toElapsedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function describePluginToolFactoryResult(
  resolved: AnyAgentTool | AnyAgentTool[] | null | undefined,
  failed: boolean,
): { result: PluginToolFactoryTimingResult; resultCount: number } {
  if (failed) {
    return { result: "error", resultCount: 0 };
  }
  if (!resolved) {
    return { result: "null", resultCount: 0 };
  }
  if (Array.isArray(resolved)) {
    return { result: "array", resultCount: resolved.length };
  }
  return { result: "single", resultCount: 1 };
}

function formatPluginToolFactoryTiming(timing: PluginToolFactoryTiming): string {
  const names = timing.names.length > 0 ? timing.names.join("|") : "-";
  return [
    `${timing.pluginId}:${timing.durationMs}ms@${timing.elapsedMs}ms`,
    `names=[${names}]`,
    `result=${timing.result}`,
    `count=${timing.resultCount}`,
    `optional=${String(timing.optional)}`,
  ].join(" ");
}

function formatPluginToolFactoryTimingSummary(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): string {
  const ranked = params.timings
    .toSorted(
      (left, right) =>
        right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId),
    )
    .slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
  const omitted = Math.max(0, params.timings.length - ranked.length);
  const factories =
    ranked.length > 0
      ? ranked.map((timing) => formatPluginToolFactoryTiming(timing)).join(", ")
      : "none";
  return [
    "[trace:plugin-tools] factory timings",
    `totalMs=${params.totalMs}`,
    `factoryCount=${params.timings.length}`,
    `shown=${ranked.length}`,
    `omitted=${omitted}`,
    `factories=${factories}`,
  ].join(" ");
}

function shouldWarnPluginToolFactoryTimings(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): boolean {
  return (
    params.totalMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS ||
    params.timings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS)
  );
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

function pluginToolNamesMatchAllowlist(params: {
  names: readonly string[];
  pluginId: string;
  optional: boolean;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return !params.optional;
  }
  return isOptionalToolEntryPotentiallyAllowed(params);
}

function manifestToolContractMatchesAllowlist(params: {
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.toolNames.length === 0) {
    return false;
  }
  if (params.allowlist.size === 0) {
    return true;
  }
  if (params.allowlist.has("*") || params.allowlist.has("group:plugins")) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.toolNames.some((name) => params.allowlist.has(normalizeToolName(name)));
}

function listManifestToolNamesForAvailability(params: {
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): string[] {
  if (
    params.allowlist.size === 0 ||
    params.allowlist.has("*") ||
    params.allowlist.has("group:plugins")
  ) {
    return [...params.toolNames];
  }
  if (params.allowlist.has(normalizeToolName(params.pluginId))) {
    return [...params.toolNames];
  }
  return params.toolNames.filter((name) => params.allowlist.has(normalizeToolName(name)));
}

function resolvePluginToolRuntimePluginIds(params: {
  config: PluginLoadOptions["config"];
  availabilityConfig?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  toolAllowlist?: string[];
  hasAuthForProvider?: (providerId: string) => boolean;
  snapshot?: ReturnType<typeof loadManifestContractSnapshot>;
}): string[] {
  const pluginIds = new Set<string>();
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const snapshot =
    params.snapshot ??
    loadManifestContractSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    const toolNames = plugin.contracts?.tools ?? [];
    if (
      manifestToolContractMatchesAllowlist({
        toolNames,
        pluginId: plugin.id,
        allowlist,
      }) &&
      hasManifestToolAvailability({
        plugin,
        toolNames: listManifestToolNamesForAvailability({
          toolNames,
          pluginId: plugin.id,
          allowlist,
        }),
        config: params.availabilityConfig ?? params.config,
        env: params.env,
        hasAuthForProvider: params.hasAuthForProvider,
      })
    ) {
      pluginIds.add(plugin.id);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

function registryContainsPluginIds(
  registry: ReturnType<typeof getActivePluginRegistry>,
  pluginIds?: readonly string[],
): boolean {
  if (!registry || pluginIds === undefined || pluginIds.length === 0) {
    return false;
  }
  const loadedPluginIds = new Set(
    (registry.plugins ?? [])
      .filter((plugin) => plugin.status === undefined || plugin.status === "loaded")
      .map((plugin) => plugin.id),
  );
  return pluginIds.every((pluginId) => loadedPluginIds.has(pluginId));
}

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  onlyPluginIds?: readonly string[];
}) {
  const activeRegistry = getActivePluginRegistry();
  const channelRegistry = getActivePluginChannelRegistry();
  const activeRegistryIsGatewayBindable =
    getActivePluginRegistryKey() && getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  const hasPinnedGatewayRegistry = Boolean(channelRegistry && channelRegistry !== activeRegistry);
  if (
    channelRegistry &&
    (activeRegistryIsGatewayBindable || hasPinnedGatewayRegistry) &&
    registryContainsPluginIds(channelRegistry, params.onlyPluginIds)
  ) {
    return channelRegistry;
  }
  return resolveRuntimePluginRegistry(params.loadOptions);
}

function createDescriptorBackedPluginTool(params: {
  descriptor: ToolDescriptor;
  env: NodeJS.ProcessEnv;
  context: OpenClawPluginToolContext;
  allowGatewaySubagentBinding?: boolean;
}): AnyAgentTool {
  const executor =
    params.descriptor.executor?.kind === "plugin" ? params.descriptor.executor : undefined;
  if (!executor) {
    throw new Error(`plugin tool descriptor missing plugin executor: ${params.descriptor.name}`);
  }
  const loadRuntimeTool = async (): Promise<AnyAgentTool> => {
    const config =
      params.context.getRuntimeConfig?.() ?? params.context.runtimeConfig ?? params.context.config;
    const baseConfig = applyTestPluginDefaults(config ?? {}, params.env);
    const runtimeContext = resolvePluginRuntimeLoadContext({
      config: baseConfig,
      env: params.env,
      workspaceDir: params.context.workspaceDir,
    });
    const runtimeOptions = params.allowGatewaySubagentBinding
      ? { allowGatewaySubagentBinding: true as const }
      : undefined;
    const registry = resolvePluginToolRegistry({
      loadOptions: buildPluginRuntimeLoadOptions(runtimeContext, {
        activate: false,
        toolDiscovery: true,
        onlyPluginIds: [executor.pluginId],
        runtimeOptions,
      }),
      onlyPluginIds: [executor.pluginId],
    });
    for (const entry of registry?.tools ?? []) {
      if (entry.pluginId !== executor.pluginId) {
        continue;
      }
      if (
        !entry.names.some(
          (name) => normalizeToolName(name) === normalizeToolName(executor.toolName),
        )
      ) {
        continue;
      }
      const resolved = entry.factory(params.context);
      const listRaw: unknown[] = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
      for (const toolRaw of listRaw) {
        const malformedReason = describeMalformedPluginTool(toolRaw);
        if (malformedReason) {
          throw new Error(`plugin tool is malformed (${entry.pluginId}): ${malformedReason}`);
        }
        const tool = toolRaw as AnyAgentTool;
        if (normalizeToolName(tool.name) === normalizeToolName(executor.toolName)) {
          return tool;
        }
      }
    }
    throw new Error(
      `plugin tool implementation not registered: ${executor.pluginId}/${executor.toolName}`,
    );
  };

  return {
    name: params.descriptor.name,
    label: params.descriptor.title ?? params.descriptor.name,
    description: params.descriptor.description,
    parameters: params.descriptor.inputSchema as never,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      (await loadRuntimeTool()).execute(...args),
  } as AnyAgentTool;
}

function listAvailableManifestToolNames(params: {
  plugin: PluginManifestRecord;
  config: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  allowlist: Set<string>;
  hasAuthForProvider?: (providerId: string) => boolean;
}): string[] {
  return listManifestToolNamesForAvailability({
    toolNames: params.plugin.contracts?.tools ?? [],
    pluginId: params.plugin.id,
    allowlist: params.allowlist,
  }).filter((toolName) =>
    hasManifestToolAvailability({
      plugin: params.plugin,
      toolNames: [toolName],
      config: params.config,
      env: params.env,
      hasAuthForProvider: params.hasAuthForProvider,
    }),
  );
}

function collectAuthProviderIdsFromAvailability(
  expression: ToolAvailabilityExpression | undefined,
  into: Set<string>,
): void {
  if (!expression) {
    return;
  }
  if ("kind" in expression) {
    if (expression.kind === "auth") {
      into.add(expression.providerId);
    }
    return;
  }
  for (const entry of "allOf" in expression ? expression.allOf : expression.anyOf) {
    collectAuthProviderIdsFromAvailability(entry, into);
  }
}

function listAvailableDescriptorAuthProviderIds(params: {
  snapshotPlugins: readonly PluginManifestRecord[];
  hasAuthForProvider?: (providerId: string) => boolean;
  descriptorsByPlugin: Map<string, Map<string, ToolDescriptor>>;
}): Set<string> {
  const providerIds = new Set<string>();
  for (const plugin of params.snapshotPlugins) {
    const descriptors = listPluginManifestToolDescriptors(plugin);
    params.descriptorsByPlugin.set(
      plugin.id,
      new Map(descriptors.map((descriptor) => [descriptor.name, descriptor])),
    );
    for (const descriptor of descriptors) {
      collectAuthProviderIdsFromAvailability(descriptor.availability, providerIds);
    }
  }
  if (!params.hasAuthForProvider) {
    return new Set();
  }
  return new Set(
    Array.from(providerIds).filter((providerId) => params.hasAuthForProvider?.(providerId)),
  );
}

function buildDescriptorBackedPluginTools(params: {
  snapshotPlugins: readonly PluginManifestRecord[];
  config: PluginLoadOptions["config"];
  availabilityConfig: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  context: OpenClawPluginToolContext;
  allowlist: Set<string>;
  existing: Set<string>;
  existingNormalized: Set<string>;
  hasAuthForProvider?: (providerId: string) => boolean;
  allowGatewaySubagentBinding?: boolean;
}): {
  tools: AnyAgentTool[];
  fullyHandledPluginIds: Set<string>;
  descriptorManagedToolNames: Map<string, Set<string>>;
} {
  const tools: AnyAgentTool[] = [];
  const fullyHandledPluginIds = new Set<string>();
  const descriptorManagedToolNames = new Map<string, Set<string>>();
  const descriptorsByPlugin = new Map<string, Map<string, ToolDescriptor>>();
  const descriptorAuthProviderIds = listAvailableDescriptorAuthProviderIds({
    snapshotPlugins: params.snapshotPlugins,
    hasAuthForProvider: params.hasAuthForProvider,
    descriptorsByPlugin,
  });
  const availability = buildPluginToolAvailabilityContext({
    config: params.availabilityConfig ?? {},
    env: params.env,
    enabledPluginIds: params.snapshotPlugins.map((plugin) => plugin.id),
    authProviderIds: descriptorAuthProviderIds,
    agentId: params.context.agentId,
    sessionKey: params.context.sessionKey,
  });
  for (const plugin of params.snapshotPlugins) {
    if (params.existingNormalized.has(normalizeToolName(plugin.id))) {
      continue;
    }
    const availableToolNames = listAvailableManifestToolNames({
      plugin,
      config: params.availabilityConfig,
      env: params.env,
      allowlist: params.allowlist,
      hasAuthForProvider: params.hasAuthForProvider,
    });
    if (availableToolNames.length === 0) {
      continue;
    }
    const descriptorsByName = descriptorsByPlugin.get(plugin.id) ?? new Map();
    const descriptorToolNames = new Set<string>();
    const descriptorPlan = buildToolPlan({
      descriptors: availableToolNames.flatMap((toolName) => {
        const descriptor = descriptorsByName.get(toolName);
        if (!descriptor) {
          return [];
        }
        descriptorToolNames.add(toolName);
        return [descriptor];
      }),
      availability,
    });
    if (descriptorToolNames.size > 0) {
      descriptorManagedToolNames.set(
        plugin.id,
        new Set(Array.from(descriptorToolNames, (toolName) => normalizeToolName(toolName))),
      );
    }
    for (const { descriptor } of descriptorPlan.visible) {
      const toolName = descriptor.name;
      if (params.existingNormalized.has(normalizeToolName(toolName))) {
        continue;
      }
      const tool = createDescriptorBackedPluginTool({
        descriptor,
        env: params.env,
        context: params.context,
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      });
      setPluginToolMeta(tool, {
        pluginId: plugin.id,
        optional: false,
      });
      params.existing.add(tool.name);
      params.existingNormalized.add(normalizeToolName(tool.name));
      tools.push(tool);
    }
    if (descriptorToolNames.size === availableToolNames.length) {
      fullyHandledPluginIds.add(plugin.id);
    }
  }
  return { tools, fullyHandledPluginIds, descriptorManagedToolNames };
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
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
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const snapshot = loadManifestContractSnapshot({
    config: context.config,
    workspaceDir: context.workspaceDir,
    env,
  });
  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const descriptorPlan = buildDescriptorBackedPluginTools({
    snapshotPlugins: snapshot.plugins.filter((plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: context.config,
      }),
    ),
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    env,
    context: params.context,
    allowlist,
    existing,
    existingNormalized,
    hasAuthForProvider: params.hasAuthForProvider,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  tools.push(...descriptorPlan.tools);
  const onlyPluginIds = resolvePluginToolRuntimePluginIds({
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    workspaceDir: context.workspaceDir,
    env,
    toolAllowlist: params.toolAllowlist,
    hasAuthForProvider: params.hasAuthForProvider,
    snapshot,
  }).filter((pluginId) => !descriptorPlan.fullyHandledPluginIds.has(pluginId));
  if (onlyPluginIds.length === 0) {
    return tools;
  }
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    ...(onlyPluginIds !== undefined ? { onlyPluginIds } : {}),
    runtimeOptions,
  });
  const registry = resolvePluginToolRegistry({
    loadOptions,
    onlyPluginIds,
  });
  if (!registry) {
    return tools;
  }

  const scopedPluginIds = new Set(onlyPluginIds);
  const blockedPlugins = new Set<string>();
  const factoryTimingStartedAt = Date.now();
  const factoryTimings: PluginToolFactoryTiming[] = [];

  for (const entry of registry.tools) {
    if (!scopedPluginIds.has(entry.pluginId)) {
      continue;
    }
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
    const declaredNames = entry.names ?? [];
    if (
      !pluginToolNamesMatchAllowlist({
        names: declaredNames,
        pluginId: entry.pluginId,
        optional: entry.optional,
        allowlist,
      })
    ) {
      continue;
    }
    let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
    let factoryFailed = false;
    const factoryStartedAt = Date.now();
    try {
      resolved = entry.factory(params.context);
    } catch (err) {
      factoryFailed = true;
      context.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
    } finally {
      const factoryEndedAt = Date.now();
      const result = describePluginToolFactoryResult(resolved, factoryFailed);
      factoryTimings.push({
        pluginId: entry.pluginId,
        names: declaredNames,
        durationMs: toElapsedMs(factoryEndedAt - factoryStartedAt),
        elapsedMs: toElapsedMs(factoryEndedAt - factoryTimingStartedAt),
        result: result.result,
        resultCount: result.resultCount,
        optional: entry.optional,
      });
    }
    if (factoryFailed) {
      continue;
    }
    if (!resolved) {
      if (declaredNames.length > 0) {
        context.logger.debug?.(
          `plugin tool factory returned null (${entry.pluginId}): [${declaredNames.join(", ")}]`,
        );
      }
      continue;
    }
    const listRaw: unknown[] = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: readPluginToolName(tool),
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : listRaw;
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
      if (
        descriptorPlan.descriptorManagedToolNames
          .get(entry.pluginId)
          ?.has(normalizeToolName(tool.name))
      ) {
        continue;
      }
      const undeclared = entry.declaredNames
        ? findUndeclaredPluginToolNames({
            declaredNames: entry.declaredNames,
            toolNames: [tool.name],
          })
        : [];
      if (undeclared.length > 0) {
        const message = `plugin tool is undeclared (${entry.pluginId}): ${undeclared.join(", ")}`;
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
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

  if (factoryTimings.length > 0) {
    const totalMs =
      factoryTimings.at(-1)?.elapsedMs ?? toElapsedMs(Date.now() - factoryTimingStartedAt);
    const timingSummary = { totalMs, timings: factoryTimings };
    if (shouldWarnPluginToolFactoryTimings(timingSummary)) {
      log.warn(formatPluginToolFactoryTimingSummary(timingSummary));
    } else if (log.isEnabled("trace")) {
      log.trace(formatPluginToolFactoryTimingSummary(timingSummary));
    }
  }

  return tools;
}
