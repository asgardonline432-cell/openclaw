import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import {
  getCurrentCapabilityMetadataSnapshot,
  hasSnapshotCapabilityAvailability,
  hasSnapshotProviderEnvAvailability,
} from "./tools/manifest-capability-availability.js";

export type OptionalMediaToolFactoryPlan = {
  imageGenerate: boolean;
  videoGenerate: boolean;
  musicGenerate: boolean;
  pdf: boolean;
};

type ToolModelConfig = { primary?: string; fallbacks?: string[] };

function loadCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  return (
    getCurrentCapabilityMetadataSnapshot(params) ??
    ({
      index: { plugins: [] },
      plugins: [],
    } as Pick<PluginMetadataSnapshot, "index" | "plugins">)
  );
}

function coerceFactoryToolModelConfig(model?: AgentModelConfig): ToolModelConfig {
  const primary = resolveAgentModelPrimaryValue(model);
  const fallbacks = resolveAgentModelFallbackValues(model);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

function hasToolModelConfig(model: ToolModelConfig | undefined): boolean {
  return Boolean(
    model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0),
  );
}

function hasExplicitToolModelConfig(modelConfig: AgentModelConfig | undefined): boolean {
  return hasToolModelConfig(coerceFactoryToolModelConfig(modelConfig));
}

function hasExplicitImageModelConfig(config: OpenClawConfig | undefined): boolean {
  return hasExplicitToolModelConfig(config?.agents?.defaults?.imageModel);
}

function hasExplicitPdfModelConfig(config: OpenClawConfig | undefined): boolean {
  return (
    hasExplicitToolModelConfig(config?.agents?.defaults?.pdfModel) ||
    hasExplicitImageModelConfig(config)
  );
}

function isToolAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  return isToolAllowedByPolicyName(params.toolName, {
    allow: params.allowlist,
    deny: params.denylist,
  });
}

export function isToolExplicitlyAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByFactoryPolicy(params);
}

export function mergeFactoryPolicyList(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

export function resolveImageToolFactoryAvailable(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  modelHasVision?: boolean;
  authStore?: AuthProfileStore;
  workspaceDir?: string;
  loadCapabilitySnapshot?: () => Pick<PluginMetadataSnapshot, "index" | "plugins">;
}): boolean {
  if (!params.agentDir?.trim()) {
    return false;
  }
  if (params.modelHasVision || hasExplicitImageModelConfig(params.config)) {
    return true;
  }
  const snapshot =
    params.loadCapabilitySnapshot?.() ??
    loadCapabilityMetadataSnapshot({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  return (
    hasSnapshotCapabilityAvailability({
      snapshot,
      authStore: params.authStore,
      key: "mediaUnderstandingProviders",
      config: params.config,
    }) ||
    hasConfiguredVisionModelAuthSignal({
      config: params.config,
      snapshot,
      authStore: params.authStore,
    })
  );
}

function hasConfiguredVisionModelAuthSignal(params: {
  config?: OpenClawConfig;
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  authStore?: AuthProfileStore;
}): boolean {
  const providers = params.config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (
      !providerConfig?.models?.some(
        (model) => Array.isArray(model?.input) && model.input.includes("image"),
      )
    ) {
      continue;
    }
    if (params.authStore && listProfilesForProvider(params.authStore, providerId).length > 0) {
      return true;
    }
    if (
      hasSnapshotProviderEnvAvailability({
        snapshot: params.snapshot,
        providerId,
        config: params.config,
      })
    ) {
      return true;
    }
  }
  return false;
}

export function resolveOptionalMediaToolFactoryPlan(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  coreToolAllowlist?: string[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  loadCapabilitySnapshot?: () => Pick<PluginMetadataSnapshot, "index" | "plugins">;
}): OptionalMediaToolFactoryPlan {
  const defaults = params.config?.agents?.defaults;
  const coreToolAllowlist = mergeFactoryPolicyList(
    params.config?.tools?.allow,
    params.coreToolAllowlist,
  );
  const toolAllowlist = mergeFactoryPolicyList(params.config?.tools?.allow, params.toolAllowlist);
  const toolDenylist = mergeFactoryPolicyList(params.config?.tools?.deny, params.toolDenylist);
  const isCoreToolAllowed = (toolName: string) =>
    isToolAllowedByFactoryPolicy({
      toolName,
      allowlist: coreToolAllowlist,
      denylist: toolDenylist,
    });
  const isOptionalMediaToolAllowed = (toolName: string) =>
    isCoreToolAllowed(toolName) &&
    isToolAllowedByFactoryPolicy({
      toolName,
      allowlist: toolAllowlist,
      denylist: toolDenylist,
    });
  const allowImageGenerate = isOptionalMediaToolAllowed("image_generate");
  const allowVideoGenerate = isOptionalMediaToolAllowed("video_generate");
  const allowMusicGenerate = isOptionalMediaToolAllowed("music_generate");
  const allowPdf = isOptionalMediaToolAllowed("pdf");
  const explicitImageGeneration = hasExplicitToolModelConfig(defaults?.imageGenerationModel);
  const explicitVideoGeneration = hasExplicitToolModelConfig(defaults?.videoGenerationModel);
  const explicitMusicGeneration = hasExplicitToolModelConfig(defaults?.musicGenerationModel);
  const explicitPdf = hasExplicitPdfModelConfig(params.config);
  if (params.config?.plugins?.enabled === false) {
    return {
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    };
  }
  const needsSnapshot =
    (allowImageGenerate && !explicitImageGeneration) ||
    (allowVideoGenerate && !explicitVideoGeneration) ||
    (allowMusicGenerate && !explicitMusicGeneration) ||
    (allowPdf && !explicitPdf);
  const snapshot =
    needsSnapshot &&
    (params.loadCapabilitySnapshot?.() ??
      loadCapabilityMetadataSnapshot({
        config: params.config,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      }));
  const hasCapability = (key: Parameters<typeof hasSnapshotCapabilityAvailability>[0]["key"]) =>
    !!snapshot &&
    hasSnapshotCapabilityAvailability({
      snapshot,
      authStore: params.authStore,
      key,
      config: params.config,
    });
  return {
    imageGenerate:
      allowImageGenerate && (explicitImageGeneration || hasCapability("imageGenerationProviders")),
    videoGenerate:
      allowVideoGenerate && (explicitVideoGeneration || hasCapability("videoGenerationProviders")),
    musicGenerate:
      allowMusicGenerate && (explicitMusicGeneration || hasCapability("musicGenerationProviders")),
    pdf:
      allowPdf &&
      (explicitPdf ||
        hasCapability("mediaUnderstandingProviders") ||
        (!!snapshot &&
          hasConfiguredVisionModelAuthSignal({
            config: params.config,
            snapshot,
            authStore: params.authStore,
          }))),
  };
}
