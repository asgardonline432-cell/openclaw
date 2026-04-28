import type { EffectiveToolInventoryResult } from "../../agents/tools-effective-inventory.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logDebug, logWarn } from "../../logger.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsEffectiveParams,
} from "../protocol/index.js";
import {
  deliveryContextFromSession,
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
  listAgentIds,
  loadSessionEntry,
  resolveEffectiveToolInventory,
  resolveReplyToMode,
  resolveRuntimeConfigCacheKey,
  resolveSessionAgentId,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const TOOLS_EFFECTIVE_FRESH_TTL_MS = 10_000;
const TOOLS_EFFECTIVE_STALE_TTL_MS = 120_000;
const TOOLS_EFFECTIVE_SLOW_LOG_MS = 250;
const TOOLS_EFFECTIVE_CACHE_LIMIT = 128;
const TOOLS_EFFECTIVE_REFRESH_FALLBACK_MS = 100;

let nowForToolsEffectiveCache = () => Date.now();

type TrustedToolsEffectiveContext = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  senderIsOwner: boolean;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  accountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
};

type ToolsEffectiveCacheEntry = {
  value: EffectiveToolInventoryResult;
  createdAtMs: number;
};

const toolsEffectiveCache = new Map<string, ToolsEffectiveCacheEntry>();
const toolsEffectiveInflight = new Map<string, Promise<EffectiveToolInventoryResult>>();

function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: OpenClawConfig;
  respond: RespondFn;
}) {
  const knownAgents = listAgentIds(params.cfg);
  const requestedAgentId = normalizeOptionalString(params.rawAgentId) ?? "";
  if (!requestedAgentId) {
    return undefined;
  }
  if (!knownAgents.includes(requestedAgentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return requestedAgentId;
}

function optionalCacheString(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function buildToolsEffectiveCacheKey(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): string {
  const context = params.context;
  return JSON.stringify({
    v: 1,
    config: resolveRuntimeConfigCacheKey(context.cfg),
    pluginRegistry: getActivePluginRegistryVersion(),
    channelRegistry: getActivePluginChannelRegistryVersion(),
    sessionKey: params.sessionKey,
    agentId: context.agentId,
    senderIsOwner: context.senderIsOwner,
    modelProvider: optionalCacheString(context.modelProvider),
    modelId: optionalCacheString(context.modelId),
    messageProvider: optionalCacheString(context.messageProvider),
    accountId: optionalCacheString(context.accountId),
    currentChannelId: optionalCacheString(context.currentChannelId),
    currentThreadTs: optionalCacheString(context.currentThreadTs),
    groupId: optionalCacheString(context.groupId),
    groupChannel: optionalCacheString(context.groupChannel),
    groupSpace: optionalCacheString(context.groupSpace),
    replyToMode: optionalCacheString(context.replyToMode),
  });
}

function trimToolsEffectiveCache(): void {
  while (toolsEffectiveCache.size > TOOLS_EFFECTIVE_CACHE_LIMIT) {
    const oldest = toolsEffectiveCache.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    toolsEffectiveCache.delete(oldest);
  }
}

function cacheToolsEffectiveResult(key: string, value: EffectiveToolInventoryResult): void {
  toolsEffectiveCache.delete(key);
  toolsEffectiveCache.set(key, { value, createdAtMs: nowForToolsEffectiveCache() });
  trimToolsEffectiveCache();
}

function resolveAndCacheToolsEffectiveResult(params: {
  key: string;
  context: TrustedToolsEffectiveContext;
  startedAt: number;
}): EffectiveToolInventoryResult {
  const value = resolveEffectiveToolInventory({
    cfg: params.context.cfg,
    agentId: params.context.agentId,
    sessionKey: params.context.sessionKey,
    messageProvider: params.context.messageProvider,
    modelProvider: params.context.modelProvider,
    modelId: params.context.modelId,
    senderIsOwner: params.context.senderIsOwner,
    currentChannelId: params.context.currentChannelId,
    currentThreadTs: params.context.currentThreadTs,
    accountId: params.context.accountId,
    groupId: params.context.groupId,
    groupChannel: params.context.groupChannel,
    groupSpace: params.context.groupSpace,
    replyToMode: params.context.replyToMode,
  });
  cacheToolsEffectiveResult(params.key, value);
  const durationMs = nowForToolsEffectiveCache() - params.startedAt;
  if (durationMs >= TOOLS_EFFECTIVE_SLOW_LOG_MS) {
    const toolCount = value.groups.reduce((sum, group) => sum + group.tools.length, 0);
    logDebug(
      `tools-effective: refresh durationMs=${durationMs} agent=${params.context.agentId} session=${redactIdentifier(params.context.sessionKey)} tools=${toolCount}`,
    );
  }
  return value;
}

function scheduleToolsEffectiveRefresh(
  key: string,
  context: TrustedToolsEffectiveContext,
  options: { defer?: boolean } = {},
): Promise<EffectiveToolInventoryResult> {
  const existing = toolsEffectiveInflight.get(key);
  if (existing) {
    return existing;
  }
  const startedAt = nowForToolsEffectiveCache();
  let completed = false;
  let resolveTask!: (value: EffectiveToolInventoryResult) => void;
  let rejectTask!: (reason: unknown) => void;
  const task = new Promise<EffectiveToolInventoryResult>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  toolsEffectiveInflight.set(key, task);

  const run = () => {
    if (completed) {
      return;
    }
    completed = true;
    try {
      resolveTask(resolveAndCacheToolsEffectiveResult({ key, context, startedAt }));
    } catch (err) {
      rejectTask(err);
    } finally {
      toolsEffectiveInflight.delete(key);
    }
  };

  if (options.defer === false) {
    run();
    return task;
  }

  let immediateHandle: ReturnType<typeof setImmediate> | undefined;
  let fallbackHandle: ReturnType<typeof setTimeout> | undefined;
  const runAndCleanup = () => {
    if (completed) {
      return;
    }
    if (immediateHandle) {
      clearImmediate(immediateHandle);
    }
    if (fallbackHandle) {
      clearTimeout(fallbackHandle);
    }
    run();
  };

  try {
    immediateHandle = setImmediate(runAndCleanup);
    fallbackHandle = setTimeout(runAndCleanup, TOOLS_EFFECTIVE_REFRESH_FALLBACK_MS);
    fallbackHandle.unref?.();
  } catch {
    run();
  }

  return task;
}

function refreshToolsEffectiveInBackground(
  key: string,
  context: TrustedToolsEffectiveContext,
): void {
  void scheduleToolsEffectiveRefresh(key, context).catch((err) => {
    logWarn(`tools-effective: background refresh failed: ${formatErrorMessage(err)}`);
  });
}

async function resolveCachedToolsEffective(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): Promise<EffectiveToolInventoryResult> {
  const key = buildToolsEffectiveCacheKey(params);
  const now = nowForToolsEffectiveCache();
  const cached = toolsEffectiveCache.get(key);
  if (cached) {
    const ageMs = now - cached.createdAtMs;
    if (ageMs < TOOLS_EFFECTIVE_FRESH_TTL_MS) {
      return cached.value;
    }
    if (ageMs < TOOLS_EFFECTIVE_STALE_TTL_MS) {
      refreshToolsEffectiveInBackground(key, params.context);
      return cached.value;
    }
  }
  return scheduleToolsEffectiveRefresh(key, params.context, { defer: false });
}

function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  senderIsOwner: boolean;
  respond: RespondFn;
}) {
  const loaded = loadSessionEntry(params.sessionKey);
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: loaded.canonicalKey ?? params.sessionKey,
    config: loaded.cfg,
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      ),
    );
    return null;
  }

  const delivery = deliveryContextFromSession(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  return {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider:
      delivery?.channel ??
      loaded.entry.lastChannel ??
      loaded.entry.channel ??
      loaded.entry.origin?.provider,
    accountId: delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? stringifyRouteThreadId(delivery.threadId)
        : loaded.entry.lastThreadId != null
          ? stringifyRouteThreadId(loaded.entry.lastThreadId)
          : loaded.entry.origin?.threadId != null
            ? stringifyRouteThreadId(loaded.entry.origin.threadId)
            : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ??
        loaded.entry.lastChannel ??
        loaded.entry.channel ??
        loaded.entry.origin?.provider,
      delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
      loaded.entry.chatType ?? loaded.entry.origin?.chatType,
    ),
  };
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": async ({ params, respond, client, context }) => {
    if (!validateToolsEffectiveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgentId = resolveRequestedAgentIdOrRespondError({
      rawAgentId: params.agentId,
      cfg,
      respond,
    });
    if (requestedAgentId === null) {
      return;
    }
    const trustedContext = resolveTrustedToolsEffectiveContext({
      sessionKey: params.sessionKey,
      requestedAgentId,
      senderIsOwner: Array.isArray(client?.connect?.scopes)
        ? client.connect.scopes.includes(ADMIN_SCOPE)
        : false,
      respond,
    });
    if (!trustedContext) {
      return;
    }
    try {
      respond(
        true,
        await resolveCachedToolsEffective({
          sessionKey: params.sessionKey,
          context: trustedContext,
        }),
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `tools.effective failed: ${String(err)}`),
      );
    }
  },
};

export const __testing = {
  resetToolsEffectiveCacheForTest() {
    toolsEffectiveCache.clear();
    toolsEffectiveInflight.clear();
  },
  setToolsEffectiveNowForTest(now: () => number) {
    nowForToolsEffectiveCache = now;
  },
  resetToolsEffectiveNowForTest() {
    nowForToolsEffectiveCache = () => Date.now();
  },
} as const;
