import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRecord } from "./registry.js";
import { defaultSlotIdForKey } from "./slots.js";

export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
  };
  entries: Record<
    string,
    {
      enabled?: boolean;
      hooks?: {
        allowPromptInjection?: boolean;
      };
      config?: unknown;
    }
  >;
};

export const BUNDLED_ENABLED_BY_DEFAULT = new Set<string>([
  "device-pair",
  "phone-control",
  "talk-voice",
]);

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
};

const normalizeSlotValue = (value: unknown): string | null | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  return trimmed;
};

const normalizePluginEntries = (entries: unknown): NormalizedPluginsConfig["entries"] => {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.trim()) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      normalized[key] = {};
      continue;
    }
    const entry = value as Record<string, unknown>;
    const hooksRaw = entry.hooks;
    const hooks =
      hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
        ? {
            allowPromptInjection: (hooksRaw as { allowPromptInjection?: unknown })
              .allowPromptInjection,
          }
        : undefined;
    const normalizedHooks =
      hooks && typeof hooks.allowPromptInjection === "boolean"
        ? {
            allowPromptInjection: hooks.allowPromptInjection,
          }
        : undefined;
    normalized[key] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      hooks: normalizedHooks,
      config: "config" in entry ? entry.config : undefined,
    };
  }
  return normalized;
};

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
    },
    entries: normalizePluginEntries(config?.entries),
  };
};

const hasExplicitMemorySlot = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));

const hasExplicitPluginConfig = (plugins?: OpenClawConfig["plugins"]) => {
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  return false;
};

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig) {
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const plugins = cfg.plugins;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

type EnableStateCode =
  | "plugins_disabled"
  | "blocked_by_denylist"
  | "disabled_in_config"
  | "selected_memory_slot"
  | "not_in_allowlist"
  | "enabled_in_config"
  | "bundled_enabled_by_default"
  | "bundled_disabled_by_default"
  | "enabled";

type EnableStateDecision = {
  enabled: boolean;
  code: EnableStateCode;
};

const ENABLE_STATE_REASON_BY_CODE: Partial<Record<EnableStateCode, string>> = {
  plugins_disabled: "plugins disabled",
  blocked_by_denylist: "blocked by denylist",
  disabled_in_config: "disabled in config",
  not_in_allowlist: "not in allowlist",
  bundled_disabled_by_default: "bundled (disabled by default)",
};

function finalizeEnableState(decision: EnableStateDecision): { enabled: boolean; reason?: string } {
  return {
    enabled: decision.enabled,
    reason: ENABLE_STATE_REASON_BY_CODE[decision.code],
  };
}

function resolveExplicitEnableStateDecision(params: {
  id: string;
  config: NormalizedPluginsConfig;
}): EnableStateDecision | undefined {
  if (!params.config.enabled) {
    return { enabled: false, code: "plugins_disabled" };
  }
  if (params.config.deny.includes(params.id)) {
    return { enabled: false, code: "blocked_by_denylist" };
  }
  if (params.config.entries[params.id]?.enabled === false) {
    return { enabled: false, code: "disabled_in_config" };
  }
  return undefined;
}

function resolveSlotEnableStateDecision(params: {
  id: string;
  config: NormalizedPluginsConfig;
}): EnableStateDecision | undefined {
  if (params.config.slots.memory === params.id) {
    return { enabled: true, code: "selected_memory_slot" };
  }
  return undefined;
}

function resolveAllowlistEnableStateDecision(params: {
  id: string;
  config: NormalizedPluginsConfig;
}): EnableStateDecision | undefined {
  if (params.config.allow.length > 0 && !params.config.allow.includes(params.id)) {
    return { enabled: false, code: "not_in_allowlist" };
  }
  if (params.config.entries[params.id]?.enabled === true) {
    return { enabled: true, code: "enabled_in_config" };
  }
  return undefined;
}

function resolveBundledDefaultEnableStateDecision(
  id: string,
  origin: PluginRecord["origin"],
): EnableStateDecision {
  if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) {
    return { enabled: true, code: "bundled_enabled_by_default" };
  }
  if (origin === "bundled") {
    return { enabled: false, code: "bundled_disabled_by_default" };
  }
  return { enabled: true, code: "enabled" };
}

function resolveEnableStateDecision(
  id: string,
  origin: PluginRecord["origin"],
  config: NormalizedPluginsConfig,
): EnableStateDecision {
  return (
    resolveExplicitEnableStateDecision({ id, config }) ??
    resolveSlotEnableStateDecision({ id, config }) ??
    resolveAllowlistEnableStateDecision({ id, config }) ??
    resolveBundledDefaultEnableStateDecision(id, origin)
  );
}

function applyBundledChannelOverride(params: {
  id: string;
  rootConfig?: OpenClawConfig;
  decision: EnableStateDecision;
}): EnableStateDecision {
  if (
    !params.decision.enabled &&
    params.decision.code === "bundled_disabled_by_default" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { enabled: true, code: "enabled" };
  }
  return params.decision;
}

export function resolveEnableState(
  id: string,
  origin: PluginRecord["origin"],
  config: NormalizedPluginsConfig,
): { enabled: boolean; reason?: string } {
  return finalizeEnableState(resolveEnableStateDecision(id, origin, config));
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
): boolean {
  if (!cfg) {
    return false;
  }
  const channelId = normalizeChatChannelId(pluginId);
  if (!channelId) {
    return false;
  }
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>).enabled === true;
}

export function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginRecord["origin"];
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { enabled: boolean; reason?: string } {
  return finalizeEnableState(
    applyBundledChannelOverride({
      id: params.id,
      rootConfig: params.rootConfig,
      decision: resolveEnableStateDecision(params.id, params.origin, params.config),
    }),
  );
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (params.kind !== "memory") {
    return { enabled: true };
  }
  if (params.slot === null) {
    return { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return {
      enabled: false,
      reason: `memory slot set to "${params.slot}"`,
    };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return {
      enabled: false,
      reason: `memory slot already filled by "${params.selectedId}"`,
    };
  }
  return { enabled: true, selected: true };
}
