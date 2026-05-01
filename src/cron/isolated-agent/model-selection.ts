import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadModelCatalog,
  normalizeModelSelection,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "./run-model-selection.runtime.js";

type CronSessionModelOverrides = {
  modelOverride?: string;
  providerOverride?: string;
};

export type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
};

export type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      error: string;
    };

function formatCronPayloadModelRejection(modelOverride: string, error: string): string {
  if (error.startsWith("model not allowed:")) {
    const modelRef = error.slice("model not allowed:".length).trim();
    return `cron payload.model '${modelOverride}' rejected by agents.defaults.models allowlist: ${modelRef}`;
  }
  return `cron payload.model '${modelOverride}' rejected: ${error}`;
}

export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;

  let cacheOnlyCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  let runtimeDiscoveryCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalogOnce = async (intent: "cacheOnly" | "runtimeDiscovery" = "cacheOnly") => {
    if (intent === "runtimeDiscovery") {
      if (!runtimeDiscoveryCatalog) {
        runtimeDiscoveryCatalog = await loadModelCatalog({
          config: params.cfgWithAgentDefaults,
          intent: "runtimeDiscovery",
          source: "cron.model-selection.discovery",
        });
      }
      return runtimeDiscoveryCatalog;
    }
    if (!cacheOnlyCatalog) {
      cacheOnlyCatalog = await loadModelCatalog({
        config: params.cfgWithAgentDefaults,
        intent: "cacheOnly",
        source: "cron.model-selection",
      });
    }
    return cacheOnlyCatalog;
  };
  const resolveAllowedModelRefWithFallback = async (raw: string) => {
    const cached = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce("cacheOnly"),
      raw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (!("error" in cached)) {
      return cached;
    }
    return resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce("runtimeDiscovery"),
      raw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
  };
  const getModelRefStatusWithFallback = async (ref: { provider: string; model: string }) => {
    const cached = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalogOnce("cacheOnly"),
      ref,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (cached.allowed) {
      return cached;
    }
    return getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalogOnce("runtimeDiscovery"),
      ref,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
  };

  const subagentModelRaw =
    normalizeModelSelection(params.agentConfigOverride?.subagents?.model) ??
    normalizeModelSelection(params.agentConfigOverride?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
  if (subagentModelRaw) {
    const resolvedSubagent = await resolveAllowedModelRefWithFallback(subagentModelRaw);
    if (!("error" in resolvedSubagent)) {
      provider = resolvedSubagent.ref.provider;
      model = resolvedSubagent.ref.model;
    }
  }

  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = await getModelRefStatusWithFallback(hooksGmailModelRef);
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
    }
  }

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = await resolveAllowedModelRefWithFallback(modelOverride);
    if ("error" in resolvedOverride) {
      return {
        ok: false,
        error: formatCronPayloadModelRejection(modelOverride, resolvedOverride.error),
      };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }

  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = await resolveAllowedModelRefWithFallback(
        `${sessionProviderOverride}/${sessionModelOverride}`,
      );
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
      }
    }
  }

  return { ok: true, provider, model };
}
