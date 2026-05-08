import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveOutboundChannelRuntime,
  type OutboundChannelRuntime,
} from "../../infra/outbound/channel-resolution.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

export type ReplyChannelRuntime = OutboundChannelRuntime;

export function resolveReplyChannelRuntime(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
}): ReplyChannelRuntime | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  return resolveOutboundChannelRuntime({ channel, cfg: params.cfg });
}
