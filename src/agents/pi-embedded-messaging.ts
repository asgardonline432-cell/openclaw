import type { ChannelMessageActionAdapter } from "../channels/plugins/types.public.js";
import type { OutboundChannelRuntime } from "../infra/outbound/channel-resolution.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeToolName } from "./tool-policy.js";

const CORE_MESSAGING_TOOLS = new Set(["sessions_send", "message"]);
const MESSAGE_TOOL_SEND_ACTIONS = new Set([
  "send",
  "thread-reply",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
]);

export function isMessageToolSendActionName(action: unknown): boolean {
  const normalized = normalizeOptionalString(action) ?? "";
  return MESSAGE_TOOL_SEND_ACTIONS.has(normalized);
}

export type ChannelActionExtractToolSend = NonNullable<
  ChannelMessageActionAdapter["extractToolSend"]
>;

export type PreparedMessagingActionToolRuntime = {
  actionExtractorsByToolName?: ReadonlyMap<string, ChannelActionExtractToolSend>;
  targetNormalizersByProvider?: ReadonlyMap<
    string,
    NonNullable<OutboundChannelRuntime["normalizeTarget"]>
  >;
};

export function buildActionExtractorsByToolName(
  runtime?: Pick<OutboundChannelRuntime, "id" | "actions">,
): ReadonlyMap<string, ChannelActionExtractToolSend> | undefined {
  const extractToolSend = runtime?.actions?.extractToolSend;
  const toolName = runtime?.id ? normalizeToolName(runtime.id) : undefined;
  if (!extractToolSend || !toolName) {
    return undefined;
  }
  return new Map([[toolName, extractToolSend]]);
}

export function buildTargetNormalizersByProvider(
  runtime?: Pick<OutboundChannelRuntime, "id" | "normalizeTarget">,
): ReadonlyMap<string, NonNullable<OutboundChannelRuntime["normalizeTarget"]>> | undefined {
  const normalizeTarget = runtime?.normalizeTarget;
  const providerId = runtime?.id ? normalizeToolName(runtime.id) : undefined;
  if (!normalizeTarget || !providerId) {
    return undefined;
  }
  return new Map([[providerId, normalizeTarget]]);
}

// Provider docking: any plugin with `actions` opts into messaging tool handling.
export function isMessagingTool(
  toolName: string,
  runtime?: PreparedMessagingActionToolRuntime,
): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  if (CORE_MESSAGING_TOOLS.has(normalizedToolName)) {
    return true;
  }
  if (normalizedToolName && runtime?.actionExtractorsByToolName?.has(normalizedToolName)) {
    return true;
  }
  return false;
}

export function isMessagingToolSendAction(
  toolName: string,
  args: Record<string, unknown>,
  runtime?: PreparedMessagingActionToolRuntime,
): boolean {
  const action = normalizeOptionalString(args.action) ?? "";
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName === "sessions_send") {
    return true;
  }
  if (normalizedToolName === "message") {
    return isMessageToolSendActionName(action);
  }
  const extractToolSend = normalizedToolName
    ? runtime?.actionExtractorsByToolName?.get(normalizedToolName)
    : undefined;
  if (extractToolSend) {
    return Boolean(extractToolSend({ args })?.to);
  }
  return false;
}
