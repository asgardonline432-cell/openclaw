import fs from "node:fs";
import { AGENT_MODEL_CONFIG_KEYS } from "../../../config/model-refs.js";
import { loadSessionStore, updateSessionStore } from "../../../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { AgentRuntimePolicyConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type CodexRouteHit = {
  path: string;
  model: string;
  canonicalModel: string;
  runtime?: string;
};

type MutableRecord = Record<string, unknown>;
type SessionRouteRepairResult = {
  changed: boolean;
  sessionKeys: string[];
};
type CodexSessionRouteRepairSummary = {
  scannedStores: number;
  repairedStores: number;
  repairedSessions: number;
  warnings: string[];
  changes: string[];
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function asMutableRecord(value: unknown): MutableRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MutableRecord)
    : undefined;
}

function isOpenAICodexModelRef(model: string | undefined): model is string {
  return normalizeString(model)?.startsWith("openai-codex/") === true;
}

function toCanonicalOpenAIModelRef(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId ? `openai/${modelId}` : undefined;
}

function resolveRuntime(params: {
  env?: NodeJS.ProcessEnv;
  agentRuntime?: AgentRuntimePolicyConfig;
  defaultsRuntime?: AgentRuntimePolicyConfig;
}): string | undefined {
  return (
    normalizeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeString(params.agentRuntime?.id) ??
    normalizeString(params.defaultsRuntime?.id)
  );
}

function recordCodexModelHit(params: {
  hits: CodexRouteHit[];
  path: string;
  model: string;
  runtime?: string;
}): string | undefined {
  const canonicalModel = toCanonicalOpenAIModelRef(params.model);
  if (!canonicalModel) {
    return undefined;
  }
  params.hits.push({
    path: params.path,
    model: params.model,
    canonicalModel,
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  return canonicalModel;
}

function collectStringModelSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
}): boolean {
  if (typeof params.value !== "string") {
    return false;
  }
  const model = params.value.trim();
  if (!model || !isOpenAICodexModelRef(model)) {
    return false;
  }
  return !!recordCodexModelHit({
    hits: params.hits,
    path: params.path,
    model,
    runtime: params.runtime,
  });
}

function collectModelConfigSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
}): boolean {
  if (typeof params.value === "string") {
    return collectStringModelSlot({
      hits: params.hits,
      path: params.path,
      value: params.value,
      runtime: params.runtime,
    });
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return false;
  }
  let rewrotePrimary = false;
  if (typeof record.primary === "string") {
    rewrotePrimary = collectStringModelSlot({
      hits: params.hits,
      path: `${params.path}.primary`,
      value: record.primary,
      runtime: params.runtime,
    });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      collectStringModelSlot({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        value: entry,
      });
    }
  }
  return rewrotePrimary;
}

function collectModelsMapRefs(params: {
  hits: CodexRouteHit[];
  path: string;
  models: unknown;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const modelRef of Object.keys(record)) {
    if (!isOpenAICodexModelRef(modelRef)) {
      continue;
    }
    recordCodexModelHit({
      hits: params.hits,
      path: `${params.path}.${modelRef}`,
      model: modelRef,
    });
  }
}

function collectAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: unknown;
  path: string;
  runtime?: string;
  collectModelsMap?: boolean;
}): void {
  const agent = asMutableRecord(params.agent);
  if (!agent) {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    collectModelConfigSlot({
      hits: params.hits,
      path: `${params.path}.${key}`,
      value: agent[key],
      runtime: key === "model" ? params.runtime : undefined,
    });
  }
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent.heartbeat)?.model,
  });
  collectModelConfigSlot({
    hits: params.hits,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent.subagents)?.model,
  });
  const compaction = asMutableRecord(agent.compaction);
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.model`,
    value: compaction?.model,
  });
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.memoryFlush.model`,
    value: asMutableRecord(compaction?.memoryFlush)?.model,
  });
  if (params.collectModelsMap) {
    collectModelsMapRefs({
      hits: params.hits,
      path: `${params.path}.models`,
      models: agent.models,
    });
  }
}

function collectConfigModelRefs(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): CodexRouteHit[] {
  const hits: CodexRouteHit[] = [];
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = defaults?.agentRuntime;
  collectAgentModelRefs({
    hits,
    agent: defaults,
    path: "agents.defaults",
    runtime: resolveRuntime({ env, defaultsRuntime }),
    collectModelsMap: true,
  });

  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    collectAgentModelRefs({
      hits,
      agent,
      path: `agents.list.${id}`,
      runtime: resolveRuntime({
        env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
    });
  }

  const channelsModelByChannel = asMutableRecord(cfg.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const [targetId, model] of Object.entries(targets)) {
        collectStringModelSlot({
          hits,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
          value: model,
        });
      }
    }
  }

  for (const [index, mapping] of (cfg.hooks?.mappings ?? []).entries()) {
    collectStringModelSlot({
      hits,
      path: `hooks.mappings.${index}.model`,
      value: mapping.model,
    });
  }
  collectStringModelSlot({
    hits,
    path: "hooks.gmail.model",
    value: cfg.hooks?.gmail?.model,
  });
  collectModelConfigSlot({
    hits,
    path: "tools.subagents.model",
    value: cfg.tools?.subagents?.model,
  });
  collectStringModelSlot({
    hits,
    path: "messages.tts.summaryModel",
    value: cfg.messages?.tts?.summaryModel,
  });
  collectStringModelSlot({
    hits,
    path: "channels.discord.voice.model",
    value: asMutableRecord(asMutableRecord(cfg.channels?.discord)?.voice)?.model,
  });
  return hits;
}

function formatCodexRoutePreservation(hit: CodexRouteHit): string {
  return `${hit.path}: ${hit.model} is accepted as a compatibility alias for ${hit.canonicalModel}${
    hit.runtime ? `; current runtime is "${hit.runtime}"` : ""
  }.`;
}

export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  if (hits.length === 0) {
    return [];
  }
  return [
    [
      "- Compatibility `openai-codex/*` model refs are present.",
      ...hits.map((hit) => `- ${formatCodexRoutePreservation(hit)}`),
      "- New config should use `openai/*`; existing `openai-codex/*` refs are routed through the alias router and are preserved by `openclaw doctor --fix`.",
    ].join("\n"),
  ];
}

export function maybeRepairCodexRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  if (hits.length === 0) {
    return { cfg: params.cfg, warnings: [], changes: [] };
  }
  if (!params.shouldRepair) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({ cfg: params.cfg, env: params.env }),
      changes: [],
    };
  }
  return {
    cfg: params.cfg,
    warnings: [
      `Preserved Codex compatibility model aliases:\n${hits
        .map((hit) => `- ${formatCodexRoutePreservation(hit)}`)
        .join("\n")}`,
    ],
    changes: [],
  };
}

function sessionModelPairHasCodexAlias(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
}): boolean {
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  if (provider === "openai-codex") {
    return true;
  }
  return !!model && isOpenAICodexModelRef(model);
}

function clearStaleCodexFallbackNotice(entry: SessionEntry): boolean {
  if (
    !isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) &&
    !isOpenAICodexModelRef(entry.fallbackNoticeActiveModel)
  ) {
    return false;
  }
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  return true;
}

function clearStaleSessionRuntimePins(entry: SessionEntry): boolean {
  let changed = false;
  if (entry.agentHarnessId !== undefined) {
    delete entry.agentHarnessId;
    changed = true;
  }
  if (entry.agentRuntimeOverride !== undefined) {
    delete entry.agentRuntimeOverride;
    changed = true;
  }
  return changed;
}

export function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  now?: number;
}): SessionRouteRepairResult {
  const now = params.now ?? Date.now();
  const sessionKeys: string[] = [];
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry) {
      continue;
    }
    const hasRuntimeModelRoute = sessionModelPairHasCodexAlias({
      entry,
      providerKey: "modelProvider",
      modelKey: "model",
    });
    const hasOverrideModelRoute = sessionModelPairHasCodexAlias({
      entry,
      providerKey: "providerOverride",
      modelKey: "modelOverride",
    });
    const hasCodexRoute = hasRuntimeModelRoute || hasOverrideModelRoute;
    const changedFallbackNotice = clearStaleCodexFallbackNotice(entry);
    const changedRuntimePins =
      hasCodexRoute || changedFallbackNotice ? clearStaleSessionRuntimePins(entry) : false;
    if (!changedFallbackNotice && !changedRuntimePins) {
      continue;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

function scanCodexSessionStoreRoutes(store: Record<string, SessionEntry>): string[] {
  return Object.entries(store).flatMap(([sessionKey, entry]) => {
    if (!entry) {
      return [];
    }
    const hasCodexRoute =
      normalizeString(entry.modelProvider) === "openai-codex" ||
      normalizeString(entry.providerOverride) === "openai-codex" ||
      isOpenAICodexModelRef(entry.model) ||
      isOpenAICodexModelRef(entry.modelOverride);
    const hasStaleFallbackNotice =
      isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) ||
      isOpenAICodexModelRef(entry.fallbackNoticeActiveModel);
    const hasRuntimePin =
      entry.agentHarnessId !== undefined || entry.agentRuntimeOverride !== undefined;
    return hasStaleFallbackNotice || (hasCodexRoute && hasRuntimePin) ? [sessionKey] : [];
  });
}

export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): Promise<CodexSessionRouteRepairSummary> {
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, {
    env: params.env ?? process.env,
  }).filter((target) => fs.existsSync(target.storePath));
  if (targets.length === 0) {
    return {
      scannedStores: 0,
      repairedStores: 0,
      repairedSessions: 0,
      warnings: [],
      changes: [],
    };
  }
  if (!params.shouldRepair) {
    const stale = targets.flatMap((target) => {
      const sessionKeys = scanCodexSessionStoreRoutes(loadSessionStore(target.storePath));
      return sessionKeys.map((sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings:
        stale.length > 0
          ? [
              [
                "- Stale Codex session runtime/fallback state detected.",
                `- Affected sessions: ${stale.length}.`,
                "- Run `openclaw doctor --fix` to clear stale session runtime/fallback pins while preserving compatibility provider/model aliases.",
              ].join("\n"),
            ]
          : [],
      changes: [],
    };
  }
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const staleSessionKeys = scanCodexSessionStoreRoutes(loadSessionStore(target.storePath));
    if (staleSessionKeys.length === 0) {
      continue;
    }
    const result = await updateSessionStore(
      target.storePath,
      (store) => repairCodexSessionStoreRoutes({ store }),
      { skipMaintenance: true },
    );
    if (!result.changed) {
      continue;
    }
    repairedStores += 1;
    repairedSessions += result.sessionKeys.length;
  }
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings: [],
    changes:
      repairedSessions > 0
        ? [
            `Repaired Codex session routes: moved ${repairedSessions} session${
              repairedSessions === 1 ? "" : "s"
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} by clearing stale runtime/fallback pins while preserving compatibility provider/model aliases.`,
          ]
        : [],
  };
}
