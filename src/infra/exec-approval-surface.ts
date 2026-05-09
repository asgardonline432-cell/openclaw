import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import type { ChannelApprovalCapability } from "../channels/plugins/types.adapters.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string; accountId?: string }
  | { kind: "disabled"; channel: string; channelLabel: string; accountId?: string }
  | { kind: "unsupported"; channel: string; channelLabel: string; accountId?: string };

export type ExecApprovalSurfaceRuntime = {
  id?: string | null;
  channel?: string | null;
  label?: string;
  approvalCapability?: ChannelApprovalCapability;
};

function runtimeMatchesChannel(
  runtime: ExecApprovalSurfaceRuntime | undefined,
  channel?: string | null,
): boolean {
  if (!runtime) {
    return false;
  }
  const runtimeChannel =
    normalizeMessageChannel(runtime.id) ?? normalizeMessageChannel(runtime.channel);
  return runtimeChannel === channel;
}

function labelForChannel(channel?: string, runtime?: ExecApprovalSurfaceRuntime): string {
  if (channel === "tui") {
    return "terminal UI";
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return "Web UI";
  }
  if (runtimeMatchesChannel(runtime, channel) && runtime?.label) {
    return runtime.label;
  }
  if (runtime) {
    return channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform";
  }
  return (
    getChannelPlugin(channel ?? "")?.meta.label ??
    (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform")
  );
}

function resolveApprovalCapabilityForChannel(
  channel?: string,
  runtime?: ExecApprovalSurfaceRuntime,
): ChannelApprovalCapability | undefined {
  if (runtime) {
    return runtimeMatchesChannel(runtime, channel) ? runtime.approvalCapability : undefined;
  }
  return resolveChannelApprovalCapability(getChannelPlugin(channel ?? ""));
}

function hasNativeExecApprovalCapability(
  channel?: string,
  runtime?: ExecApprovalSurfaceRuntime,
): boolean {
  const capability = resolveApprovalCapabilityForChannel(channel, runtime);
  if (!capability?.native) {
    return false;
  }
  return Boolean(capability.getExecInitiatingSurfaceState || capability.getActionAvailabilityState);
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  runtime?: ExecApprovalSurfaceRuntime;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel, params.runtime);
  const accountId = normalizeOptionalString(params.accountId);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel, accountId };
  }

  const cfg = params.cfg ?? getRuntimeConfig();
  const capability = resolveApprovalCapabilityForChannel(channel, params.runtime);
  const state =
    capability?.getExecInitiatingSurfaceState?.({
      cfg,
      accountId: params.accountId,
      action: "approve",
    }) ??
    capability?.getActionAvailabilityState?.({
      cfg,
      accountId: params.accountId,
      action: "approve",
      approvalKind: "exec",
    });
  if (state) {
    return { ...state, channel, channelLabel, accountId };
  }
  if (isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel, accountId };
  }
  return { kind: "unsupported", channel, channelLabel, accountId };
}

export function supportsNativeExecApprovalClient(
  channel?: string | null,
  runtime?: ExecApprovalSurfaceRuntime,
): boolean {
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL || normalized === "tui") {
    return true;
  }
  return hasNativeExecApprovalCapability(normalized, runtime);
}

export function listNativeExecApprovalClientLabels(params?: {
  excludeChannel?: string | null;
}): string[] {
  const excludeChannel = normalizeMessageChannel(params?.excludeChannel);
  return listChannelPlugins()
    .filter((plugin) => plugin.id !== excludeChannel)
    .filter((plugin) => hasNativeExecApprovalCapability(plugin.id))
    .map((plugin) => normalizeOptionalString(plugin.meta.label))
    .filter((label): label is string => Boolean(label))
    .toSorted((a, b) => a.localeCompare(b));
}

export function describeNativeExecApprovalClientSetup(params: {
  channel?: string | null;
  channelLabel?: string | null;
  accountId?: string | null;
  runtime?: ExecApprovalSurfaceRuntime;
}): string | null {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return null;
  }
  const channelLabel =
    normalizeOptionalString(params.channelLabel) ?? labelForChannel(channel, params.runtime);
  const accountId = normalizeOptionalString(params.accountId);
  return (
    resolveApprovalCapabilityForChannel(channel, params.runtime)?.describeExecApprovalSetup?.({
      channel,
      channelLabel,
      accountId,
    }) ?? null
  );
}
