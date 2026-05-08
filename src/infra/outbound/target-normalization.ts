import { getChannelPlugin } from "../../channels/plugins/index.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded-read.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistryVersion } from "../../plugins/runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export function normalizeChannelTargetInput(raw: string): string {
  return raw.trim();
}

type TargetNormalizer = ((raw: string) => string | undefined) | undefined;
type TargetResolverLooksLikeId = ((raw: string, normalized: string) => boolean) | undefined;
type TargetResolverFallback =
  | ((params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      input: string;
      normalized: string;
      preferredKind?: TargetResolveKindLike;
    }) => Promise<
      | {
          to: string;
          kind: TargetResolveKindLike;
          display?: string;
          source?: "normalized" | "directory";
        }
      | null
      | undefined
    >)
  | undefined;
type TargetNormalizerCacheEntry = {
  version: number;
  normalizer: TargetNormalizer;
};

const targetNormalizerCacheByChannelId = new Map<string, TargetNormalizerCacheEntry>();

function resolveChannelPluginForTargetRead(channelId: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginForRead(channelId) ?? getChannelPlugin(channelId);
}

function resetTargetNormalizerCacheForTests(): void {
  targetNormalizerCacheByChannelId.clear();
}

export const __testing = {
  resetTargetNormalizerCacheForTests,
} as const;

function resolveTargetNormalizer(channelId: ChannelId): TargetNormalizer {
  const version = getActivePluginChannelRegistryVersion();
  const cached = targetNormalizerCacheByChannelId.get(channelId);
  if (cached && cached.version === version) {
    return cached.normalizer;
  }
  const plugin = resolveChannelPluginForTargetRead(channelId);
  const normalizer = plugin?.messaging?.normalizeTarget;
  targetNormalizerCacheByChannelId.set(channelId, {
    version,
    normalizer,
  });
  return normalizer;
}

export function normalizeTargetForProvider(
  provider: string,
  raw?: string,
  options?: {
    normalizeTarget?: TargetNormalizer;
  },
): string | undefined {
  if (!raw) {
    return undefined;
  }
  const fallback = normalizeOptionalString(raw);
  if (!fallback) {
    return undefined;
  }
  const providerId = normalizeOptionalLowercaseString(provider);
  const normalizer =
    options?.normalizeTarget ?? (providerId ? resolveTargetNormalizer(providerId) : undefined);
  return normalizeOptionalString(normalizer?.(raw) ?? fallback);
}

export type TargetResolveKindLike = ChannelDirectoryEntryKind | "channel";

export type ResolvedPluginMessagingTarget = {
  to: string;
  kind: TargetResolveKindLike;
  display?: string;
  source: "normalized" | "directory";
};

export function resolveNormalizedTargetInput(
  provider: string,
  raw?: string,
  options?: {
    normalizeTarget?: TargetNormalizer;
  },
): { raw: string; normalized: string } | undefined {
  const trimmed = normalizeChannelTargetInput(raw ?? "");
  if (!trimmed) {
    return undefined;
  }
  return {
    raw: trimmed,
    normalized: normalizeTargetForProvider(provider, trimmed, options) ?? trimmed,
  };
}

export function looksLikeTargetId(params: {
  channel: ChannelId;
  raw: string;
  normalized?: string;
  normalizeTarget?: TargetNormalizer;
  looksLikeTargetId?: TargetResolverLooksLikeId;
}): boolean {
  const normalizedInput =
    params.normalized ??
    normalizeTargetForProvider(params.channel, params.raw, {
      normalizeTarget: params.normalizeTarget,
    });
  const lookup =
    params.looksLikeTargetId ??
    resolveChannelPluginForTargetRead(params.channel)?.messaging?.targetResolver?.looksLikeId;
  if (lookup) {
    return lookup(params.raw, normalizedInput ?? params.raw);
  }
  if (/^(channel|group|user):/i.test(params.raw)) {
    return true;
  }
  if (/^[@#]/.test(params.raw)) {
    return true;
  }
  if (/^\+?\d{6,}$/.test(params.raw)) {
    return true;
  }
  if (params.raw.includes("@thread")) {
    return true;
  }
  return /^(conversation|user):/i.test(params.raw);
}

export async function maybeResolvePluginMessagingTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKindLike;
  requireIdLike?: boolean;
  normalizeTarget?: TargetNormalizer;
  looksLikeTargetId?: TargetResolverLooksLikeId;
  resolveMessagingTargetFallback?: TargetResolverFallback;
}): Promise<ResolvedPluginMessagingTarget | undefined> {
  const normalizedInput = resolveNormalizedTargetInput(params.channel, params.input, {
    normalizeTarget: params.normalizeTarget,
  });
  if (!normalizedInput) {
    return undefined;
  }
  const resolveTarget =
    params.resolveMessagingTargetFallback ??
    resolveChannelPluginForTargetRead(params.channel)?.messaging?.targetResolver?.resolveTarget;
  if (!resolveTarget) {
    return undefined;
  }
  if (
    params.requireIdLike &&
    !looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized: normalizedInput.normalized,
      normalizeTarget: params.normalizeTarget,
      looksLikeTargetId: params.looksLikeTargetId,
    })
  ) {
    return undefined;
  }
  const resolved = await resolveTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    input: normalizedInput.raw,
    normalized: normalizedInput.normalized,
    preferredKind: params.preferredKind,
  });
  if (!resolved) {
    return undefined;
  }
  return {
    to: resolved.to,
    kind: resolved.kind,
    display: resolved.display,
    source: resolved.source ?? "normalized",
  };
}

export function buildTargetResolverSignature(channel: ChannelId): string {
  return buildTargetResolverSignatureForRuntime({
    channel,
  });
}

export function buildTargetResolverSignatureForRuntime(params: {
  channel: ChannelId;
  targetResolverHint?: string;
  looksLikeTargetId?: TargetResolverLooksLikeId;
}): string {
  const plugin = params.looksLikeTargetId
    ? undefined
    : resolveChannelPluginForTargetRead(params.channel);
  const resolver = plugin?.messaging?.targetResolver;
  const hint = params.targetResolverHint ?? resolver?.hint ?? "";
  const looksLike = params.looksLikeTargetId ?? resolver?.looksLikeId;
  const source = looksLike ? looksLike.toString() : "";
  return hashSignature(`${hint}|${source}`);
}

function hashSignature(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
