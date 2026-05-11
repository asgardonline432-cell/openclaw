import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { resolveWhatsAppTargetFacts } from "./target-facts.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const resolution = resolveWhatsAppTargetFacts({ target: params.target });
  if (!resolution.ok) {
    return null;
  }
  const facts = resolution.facts;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: facts.routePeer,
    chatType: facts.chatType,
    from: facts.normalizedTarget,
    to: facts.normalizedTarget,
  });
}
