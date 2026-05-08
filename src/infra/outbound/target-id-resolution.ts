import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundChannelRuntime } from "./channel-resolution.js";
import { maybeResolvePluginMessagingTarget } from "./target-normalization.js";

export type ResolvedIdLikeTarget = {
  to: string;
  kind: ChannelDirectoryEntryKind | "channel";
  display?: string;
  source: "normalized" | "directory";
};

export async function maybeResolveIdLikeTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: ChannelDirectoryEntryKind | "channel";
  runtime?: Pick<
    OutboundChannelRuntime,
    "looksLikeTargetId" | "normalizeTarget" | "resolveMessagingTargetFallback"
  >;
}): Promise<ResolvedIdLikeTarget | undefined> {
  const target = await maybeResolvePluginMessagingTarget({
    cfg: params.cfg,
    channel: params.channel,
    input: params.input,
    accountId: params.accountId,
    preferredKind: params.preferredKind,
    requireIdLike: true,
    normalizeTarget: params.runtime?.normalizeTarget,
    looksLikeTargetId: params.runtime?.looksLikeTargetId,
    resolveMessagingTargetFallback: params.runtime?.resolveMessagingTargetFallback,
    allowPluginFallback: !params.runtime,
  });
  if (!target) {
    return undefined;
  }
  return target;
}
