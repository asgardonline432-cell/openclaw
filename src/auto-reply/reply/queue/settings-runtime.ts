import type { ReplyChannelRuntime } from "../channel-runtime.js";
import { resolveQueueSettings as resolveQueueSettingsCore } from "./settings.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

export function resolveQueueSettings(params: ResolveQueueSettingsParams): QueueSettings {
  return resolveQueueSettingsCore({
    ...params,
    pluginDebounceMs: params.pluginDebounceMs ?? resolvePreparedDebounce(params.runtime),
  });
}

function resolvePreparedDebounce(
  runtime: Pick<ReplyChannelRuntime, "queueDebounceMs"> | undefined,
): number | undefined {
  const value = runtime?.queueDebounceMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}
