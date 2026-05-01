import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import { ensureRuntimePluginsLoaded } from "../agents/runtime-plugins.js";
import { prepareSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import {
  markReplyRuntimePluginRegistryPrepared,
  markReplyRuntimeProviderAuthPrepared,
  markReplyRuntimeProviderPrepared,
} from "./reply-runtime-readiness-monitor.js";

type Awaitable<T> = T | Promise<T>;

type ReplyRuntimeReadinessPhaseName =
  | "runtime-plugin-registry"
  | "selected-model-metadata"
  | "selected-provider-runtime"
  | "selected-provider-auth"
  | "tool-contracts";

type StartupTrace = {
  measure?: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

export type ReplyRuntimeReadinessPhaseResult = {
  phase: ReplyRuntimeReadinessPhaseName;
  status: "ready" | "degraded";
  durationMs: number;
  detail?: string;
};

export type ReplyRuntimeReadinessResult = {
  status: "ready" | "degraded";
  provider: string;
  model: string;
  phases: ReplyRuntimeReadinessPhaseResult[];
  reasons: string[];
};

async function measurePhase<T>(
  startupTrace: StartupTrace | undefined,
  traceName: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace?.measure ? await startupTrace.measure(traceName, run) : await run();
}

function resolveSelectedHarnessAuthProfileId(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  workspaceDir: string;
  harnessId: string;
}): string | undefined {
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessId,
    allowHarnessAuthProfileForwarding: true,
  });
  if (!runtimeAuthPlan.harnessAuthProvider) {
    return undefined;
  }
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  return resolveAuthProfileOrder({
    cfg: params.cfg,
    store: authStore,
    provider: runtimeAuthPlan.harnessAuthProvider,
  })[0]?.trim();
}

function collectReplyRuntimeWarmTargets(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultAgentId: string;
}): Array<{ provider: string; model: string }> {
  const targets = new Map<string, { provider: string; model: string }>();
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const addTarget = (provider: string, model: string) => {
    const providerId = provider.trim();
    const modelId = model.trim();
    if (!providerId || !modelId) {
      return;
    }
    targets.set(`${providerId}/${modelId}`, { provider: providerId, model: modelId });
  };
  const addRawRef = (raw: string | undefined, providerOverride?: string) => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return;
    }
    const parsed = resolveModelRefFromString({
      cfg: params.cfg,
      raw: providerOverride?.trim() ? `${providerOverride}/${trimmed}` : trimmed,
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (parsed?.ref) {
      addTarget(parsed.ref.provider, parsed.ref.model);
    }
  };

  const selected = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  addTarget(selected.provider, selected.model);

  const fallbackModels =
    typeof params.cfg.agents?.defaults?.model === "object"
      ? params.cfg.agents?.defaults?.model?.fallbacks
      : undefined;
  for (const fallback of Array.isArray(fallbackModels) ? fallbackModels : []) {
    addRawRef(fallback);
  }

  const configuredProviders = params.cfg.models?.providers;
  if (configuredProviders && typeof configuredProviders === "object") {
    for (const [provider, config] of Object.entries(configuredProviders)) {
      if (!Array.isArray(config?.models)) {
        continue;
      }
      for (const model of config.models) {
        if (typeof model?.id === "string" && model.id.trim()) {
          addTarget(provider, model.id);
        }
      }
    }
  }

  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.defaultAgentId,
  });
  const store = loadSessionStore(storePath);
  for (const entry of Object.values(store)) {
    addRawRef(entry.modelOverride, entry.providerOverride);
  }

  return [...targets.values()];
}

export async function prepareReplyRuntimeForChannels(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  startupTrace?: StartupTrace;
}): Promise<ReplyRuntimeReadinessResult> {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, defaultAgentId);
  const agentDir = resolveAgentDir(params.cfg, defaultAgentId);
  const phases: ReplyRuntimeReadinessPhaseResult[] = [];
  const reasons: string[] = [];
  const selected = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const warmTargets = collectReplyRuntimeWarmTargets({
    cfg: params.cfg,
    defaultProvider: selected.provider,
    defaultAgentId,
  });

  const runPhase = async (
    phase: ReplyRuntimeReadinessPhaseName,
    detail: string,
    run: () => Promise<void>,
  ): Promise<boolean> => {
    const startedAt = Date.now();
    try {
      await measurePhase(params.startupTrace, `reply-runtime-readiness.${phase}`, run);
      phases.push({
        phase,
        status: "ready",
        durationMs: Date.now() - startedAt,
        detail,
      });
      return true;
    } catch (error) {
      const reason = `${phase}: ${formatErrorMessage(error)}`;
      phases.push({
        phase,
        status: "degraded",
        durationMs: Date.now() - startedAt,
        detail: reason,
      });
      reasons.push(reason);
      return false;
    }
  };

  if (
    !(await runPhase("runtime-plugin-registry", "loaded runtime plugin registry", async () => {
      ensureRuntimePluginsLoaded({
        config: params.cfg,
        workspaceDir,
        source: "gateway.reply-runtime-readiness.runtime-plugin-registry",
      });
      markReplyRuntimePluginRegistryPrepared();
    }))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }
  if (
    !(await runPhase(
      "selected-model-metadata",
      `prepared metadata for ${warmTargets.length} reply model target(s)`,
      async () => {
        const catalog = await loadModelCatalog({ config: params.cfg });
        for (const target of warmTargets) {
          if (
            !catalog.some(
              (entry) => entry.provider === target.provider && entry.id === target.model,
            )
          ) {
            throw new Error(
              `Reply model ${target.provider}/${target.model} is not available after readiness model preparation.`,
            );
          }
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "selected-provider-runtime",
      `activated provider runtimes for ${new Set(warmTargets.map((target) => target.provider)).size} provider(s)`,
      async () => {
        for (const provider of new Set(warmTargets.map((target) => target.provider))) {
          const ownerPluginIds =
            resolveOwningPluginIdsForProvider({
              provider,
              config: params.cfg,
              workspaceDir,
              env: process.env,
            }) ?? [];
          if (ownerPluginIds.length === 0) {
            continue;
          }
          const plugin = resolveProviderRuntimePlugin({
            provider,
            config: params.cfg,
            workspaceDir,
            env: process.env,
          });
          if (!plugin) {
            throw new Error(`No provider runtime resolved for ${provider}.`);
          }
          markReplyRuntimeProviderPrepared(provider);
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "selected-provider-auth",
      `prepared runtime auth for ${warmTargets.length} reply model target(s)`,
      async () => {
        for (const target of warmTargets) {
          const selectedHarness = selectAgentHarness({
            provider: target.provider,
            modelId: target.model,
            config: params.cfg,
            agentId: defaultAgentId,
          });
          if (!selectedHarness) {
            throw new Error(`No harness selected for ${target.provider}/${target.model}.`);
          }
          if (selectedHarness.id !== "pi") {
            const authProfileId = resolveSelectedHarnessAuthProfileId({
              cfg: params.cfg,
              agentDir,
              provider: target.provider,
              workspaceDir,
              harnessId: selectedHarness.id,
            });
            if (selectedHarness.prepareReplyRuntime) {
              await selectedHarness.prepareReplyRuntime({
                config: params.cfg,
                agentDir,
                workspaceDir,
                provider: target.provider,
                modelId: target.model,
                ...(authProfileId ? { authProfileId } : {}),
              });
            }
            markReplyRuntimeProviderAuthPrepared(target.provider);
            continue;
          }
          const prepared = await prepareSimpleCompletionModel({
            cfg: params.cfg,
            provider: target.provider,
            modelId: target.model,
            agentDir,
            allowMissingApiKeyModes: ["aws-sdk"],
            primeReplyRuntimeCache: true,
          });
          if ("error" in prepared) {
            throw new Error(prepared.error);
          }
          markReplyRuntimeProviderAuthPrepared(target.provider);
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "tool-contracts",
      "prepared stable core and plugin tool contracts",
      async () => {
        createOpenClawTools({
          config: params.cfg,
          workspaceDir,
          agentDir,
          agentSessionKey: buildAgentMainSessionKey({
            agentId: defaultAgentId,
            mainKey: params.cfg.session?.mainKey,
          }),
        });
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  return {
    status: "ready",
    provider: selected.provider,
    model: selected.model,
    phases,
    reasons,
  };
}
