import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { OutboundChannelRuntime } from "./channel-resolution.js";
import { validateTargetProviderPrefix } from "./channel-target-prefix.js";
import { missingTargetError } from "./target-errors.js";

export type OutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export type ResolveOutboundTargetParams = {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
};

function buildWebChatDeliveryError(): Error {
  return new Error(
    `Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`,
  );
}

export function resolveOutboundTargetWithPlugin(params: {
  plugin: ChannelPlugin | undefined;
  target: ResolveOutboundTargetParams;
  onMissingPlugin?: () => OutboundTargetResolution | undefined;
}): OutboundTargetResolution | undefined {
  return resolveOutboundTargetWithRuntime({
    runtime: params.plugin
      ? {
          label: params.plugin.meta?.label ?? params.plugin.id,
          targetResolverHint: params.plugin.messaging?.targetResolver?.hint,
          resolveAllowFrom: params.plugin.config?.resolveAllowFrom,
          resolveDefaultTo: params.plugin.config?.resolveDefaultTo,
          resolveTarget: params.plugin.outbound?.resolveTarget,
        }
      : undefined,
    target: params.target,
    onMissingRuntime: params.onMissingPlugin,
  });
}

export function resolveOutboundTargetWithRuntime(params: {
  runtime:
    | Pick<
        OutboundChannelRuntime,
        "label" | "resolveAllowFrom" | "resolveDefaultTo" | "resolveTarget" | "targetResolverHint"
      >
    | undefined;
  target: ResolveOutboundTargetParams;
  onMissingRuntime?: () => OutboundTargetResolution | undefined;
}): OutboundTargetResolution | undefined {
  if (params.target.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: buildWebChatDeliveryError(),
    };
  }

  const runtime = params.runtime;
  if (!runtime) {
    return params.onMissingRuntime?.();
  }

  const allowFromRaw =
    params.target.allowFrom ??
    (params.target.cfg && runtime.resolveAllowFrom
      ? runtime.resolveAllowFrom({
          cfg: params.target.cfg,
          accountId: params.target.accountId ?? undefined,
        })
      : undefined);
  const allowFrom = allowFromRaw ? mapAllowFromEntries(allowFromRaw) : undefined;

  const effectiveTo =
    params.target.to?.trim() ||
    (params.target.cfg && runtime.resolveDefaultTo
      ? runtime.resolveDefaultTo({
          cfg: params.target.cfg,
          accountId: params.target.accountId ?? undefined,
        })
      : undefined);
  const targetPrefixError = validateTargetProviderPrefix({
    channel: params.target.channel,
    to: effectiveTo,
  });
  if (targetPrefixError) {
    return { ok: false, error: targetPrefixError };
  }

  const resolveTarget = runtime.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.target.cfg,
      to: effectiveTo,
      allowFrom,
      accountId: params.target.accountId ?? undefined,
      mode: params.target.mode ?? "explicit",
    });
  }

  if (effectiveTo) {
    return { ok: true, to: effectiveTo };
  }
  return {
    ok: false,
    error: missingTargetError(runtime.label ?? params.target.channel, runtime.targetResolverHint),
  };
}
