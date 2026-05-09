import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import {
  isOpenAICodexProvider,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../openai-codex-routing.js";
import {
  normalizeEmbeddedAgentRuntime,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";
import type { AgentHarnessDeliveryDefaults } from "./types.js";

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
};

const CODEX_DELIVERY_DEFAULTS = Object.freeze({
  sourceVisibleReplies: "automatic",
} satisfies AgentHarnessDeliveryDefaults);

function normalizeExplicitRuntime(value: unknown): EmbeddedAgentRuntime | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const runtime = normalizeEmbeddedAgentRuntime(value);
  return runtime === "auto" || runtime === "default" ? undefined : runtime;
}

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const configuredRuntime = configured.policy?.id?.trim();
  const runtimeSource = configured.source ?? "implicit";
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? normalizeEmbeddedAgentRuntime(configuredRuntime)
      : "auto";
  if (
    openAIProviderUsesCodexRuntimeByDefault({ provider: params.provider, config: params.config })
  ) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  if (isOpenAICodexProvider(params.provider)) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}

export function resolveAgentHarnessDeliveryDefaults(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
}): AgentHarnessDeliveryDefaults | undefined {
  const runtime =
    normalizeExplicitRuntime(params.agentHarnessId) ?? resolveAgentHarnessPolicy(params).runtime;
  if (runtime === "codex") {
    return CODEX_DELIVERY_DEFAULTS;
  }
  return undefined;
}
