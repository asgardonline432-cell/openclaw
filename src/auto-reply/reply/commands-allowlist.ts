import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeChannelId } from "../../channels/registry.js";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";
type AllowlistTarget = "both" | "config" | "store";
type ResolvedAllowlistName = {
  input: string;
  resolved: boolean;
  name?: string | null;
};
type AllowlistCommandRuntime = NonNullable<HandleCommandsParams["replyChannelRuntime"]>;

type AllowlistCommand =
  | {
      action: "list";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      resolve?: boolean;
    }
  | {
      action: "add" | "remove";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      entry: string;
      resolve?: boolean;
      target: AllowlistTarget;
    }
  | { action: "error"; message: string };

const ACTIONS = new Set(["list", "add", "remove"]);
const SCOPES = new Set<AllowlistScope>(["dm", "group", "all"]);

function resolveAllowlistAccountId(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  parsedAccount?: string;
  ctxAccountId?: string;
  runtime?: Pick<AllowlistCommandRuntime, "defaultAccountId">;
}): string {
  const explicitAccountId = normalizeOptionalAccountId(params.parsedAccount);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const configuredDefaultAccountId = normalizeOptionalString(
    params.runtime?.defaultAccountId?.(params.cfg) ??
      getChannelPlugin(params.channelId)?.config.defaultAccountId?.(params.cfg),
  );
  const ctxAccountId = normalizeOptionalAccountId(params.ctxAccountId);
  return configuredDefaultAccountId || ctxAccountId || DEFAULT_ACCOUNT_ID;
}

function parseAllowlistCommand(raw: string): AllowlistCommand | null {
  const trimmed = raw.trim();
  const trimmedLower = normalizeOptionalLowercaseString(trimmed) ?? "";
  if (!trimmedLower.startsWith("/allowlist")) {
    return null;
  }
  const rest = trimmed.slice("/allowlist".length).trim();
  if (!rest) {
    return { action: "list", scope: "dm" };
  }

  const tokens = rest.split(/\s+/);
  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "dm";
  let resolve = false;
  let target: AllowlistTarget = "both";
  let channel: string | undefined;
  let account: string | undefined;
  const entryTokens: string[] = [];

  let i = 0;
  const firstAction = normalizeOptionalLowercaseString(tokens[i]);
  if (firstAction && ACTIONS.has(firstAction)) {
    action = firstAction as AllowlistAction;
    i += 1;
  }
  const firstScope = normalizeOptionalLowercaseString(tokens[i]);
  if (firstScope && SCOPES.has(firstScope as AllowlistScope)) {
    scope = firstScope as AllowlistScope;
    i += 1;
  }

  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lowered = normalizeOptionalLowercaseString(token) ?? "";
    if (lowered === "--resolve" || lowered === "resolve") {
      resolve = true;
      continue;
    }
    if (lowered === "--config" || lowered === "config") {
      target = "config";
      continue;
    }
    if (lowered === "--store" || lowered === "store") {
      target = "store";
      continue;
    }
    if (lowered === "--channel" && tokens[i + 1]) {
      channel = tokens[i + 1];
      i += 1;
      continue;
    }
    if (lowered === "--account" && tokens[i + 1]) {
      account = tokens[i + 1];
      i += 1;
      continue;
    }
    const kv = token.split("=");
    if (kv.length === 2) {
      const key = normalizeOptionalLowercaseString(kv[0]);
      const value = normalizeOptionalString(kv[1]);
      if (key === "channel") {
        if (value) {
          channel = value;
        }
        continue;
      }
      if (key === "account") {
        if (value) {
          account = value;
        }
        continue;
      }
      const normalizedValue = normalizeOptionalLowercaseString(value);
      if (key === "scope" && normalizedValue && SCOPES.has(normalizedValue as AllowlistScope)) {
        scope = normalizedValue as AllowlistScope;
        continue;
      }
    }
    entryTokens.push(token);
  }

  if (action === "add" || action === "remove") {
    const entry = entryTokens.join(" ").trim();
    if (!entry) {
      return { action: "error", message: "Usage: /allowlist add|remove <entry>" };
    }
    return { action, scope, entry, channel, account, resolve, target };
  }

  return { action: "list", scope, channel, account, resolve };
}

function normalizeAllowFrom(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  values: Array<string | number>;
  runtime?: Pick<AllowlistCommandRuntime, "formatAllowFrom">;
}): string[] {
  const formatAllowFrom =
    params.runtime?.formatAllowFrom ?? getChannelPlugin(params.channelId)?.config.formatAllowFrom;
  if (formatAllowFrom) {
    return formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.values,
    });
  }
  return normalizeStringEntries(params.values);
}

function formatEntryList(entries: string[], resolved?: Map<string, string>): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .map((entry) => {
      const name = resolved?.get(entry);
      return name ? `${entry} (${name})` : entry;
    })
    .join(", ");
}

async function updatePairingStoreAllowlist(params: {
  action: "add" | "remove";
  channelId: ChannelId;
  accountId?: string;
  entry: string;
}) {
  const storeEntry = {
    channel: params.channelId,
    entry: params.entry,
    accountId: params.accountId,
  };
  if (params.action === "add") {
    await addChannelAllowFromStoreEntry(storeEntry);
    return;
  }

  await removeChannelAllowFromStoreEntry(storeEntry);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    await removeChannelAllowFromStoreEntry({
      channel: params.channelId,
      entry: params.entry,
    });
  }
}

function mapResolvedAllowlistNames(entries: ResolvedAllowlistName[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.resolved && entry.name) {
      map.set(entry.input, entry.name);
    }
  }
  return map;
}

async function resolveAllowlistNames(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  scope: "dm" | "group";
  entries: string[];
  runtime?: Pick<AllowlistCommandRuntime, "allowlist">;
}) {
  const allowlist = params.runtime?.allowlist ?? getChannelPlugin(params.channelId)?.allowlist;
  const resolved = await allowlist?.resolveNames?.({
    cfg: params.cfg,
    accountId: params.accountId,
    scope: params.scope,
    entries: params.entries,
  });
  return mapResolvedAllowlistNames(resolved ?? []);
}

async function readAllowlistConfig(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  runtime?: Pick<AllowlistCommandRuntime, "allowlist">;
}) {
  const allowlist = params.runtime?.allowlist ?? getChannelPlugin(params.channelId)?.allowlist;
  return (
    (await allowlist?.readConfig?.({
      cfg: params.cfg,
      accountId: params.accountId,
    })) ?? {}
  );
}

export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.action === "error") {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.message}` } };
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
  if (unauthorized) {
    return unauthorized;
  }
  if (parsed.action !== "list") {
    const nonOwner = rejectNonOwnerCommand(params, "/allowlist");
    if (nonOwner) {
      return nonOwner;
    }
  }

  const channelId =
    normalizeChannelId(parsed.channel) ??
    params.command.channelId ??
    normalizeChannelId(params.command.channel);
  if (!channelId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Unknown channel. Add channel=<id> to the command." },
    };
  }
  const runtime =
    params.replyChannelRuntime && params.replyChannelRuntime.id === channelId
      ? params.replyChannelRuntime
      : undefined;
  if (normalizeOptionalString(parsed.account) && !normalizeOptionalAccountId(parsed.account)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Invalid account id. Reserved keys (__proto__, constructor, prototype) are blocked.",
      },
    };
  }
  const accountId = resolveAllowlistAccountId({
    cfg: params.cfg,
    channelId,
    parsedAccount: parsed.account,
    ctxAccountId: params.ctx.AccountId,
    runtime,
  });
  const plugin = runtime ? undefined : getChannelPlugin(channelId);
  const allowlist = runtime?.allowlist ?? plugin?.allowlist;
  const pairing = runtime?.pairing ?? plugin?.pairing;

  if (parsed.action === "list") {
    const supportsStore = Boolean(pairing);
    if (!allowlist?.readConfig && !supportsStore) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${channelId} does not expose allowlist configuration.` },
      };
    }
    const storeAllowFrom = supportsStore
      ? await readChannelAllowFromStore(channelId, process.env, accountId).catch(() => [])
      : [];
    const configState = await readAllowlistConfig({
      cfg: params.cfg,
      channelId,
      accountId,
      runtime,
    });

    const dmAllowFrom = (configState.dmAllowFrom ?? []).map(String);
    const groupAllowFrom = (configState.groupAllowFrom ?? []).map(String);
    const groupOverrides = (configState.groupOverrides ?? []).map((entry) => ({
      label: entry.label,
      entries: entry.entries.map(String).filter(Boolean),
    }));

    const dmDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: dmAllowFrom,
      runtime,
    });
    const groupDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: groupAllowFrom,
      runtime,
    });
    const groupOverrideEntries = groupOverrides.flatMap((entry) => entry.entries);
    const groupOverrideDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: groupOverrideEntries,
      runtime,
    });

    const resolvedDm =
      parsed.resolve && dmDisplay.length > 0
        ? await resolveAllowlistNames({
            cfg: params.cfg,
            channelId,
            accountId,
            scope: "dm",
            entries: dmDisplay,
            runtime,
          })
        : undefined;
    const resolvedGroup =
      parsed.resolve && groupOverrideDisplay.length > 0
        ? await resolveAllowlistNames({
            cfg: params.cfg,
            channelId,
            accountId,
            scope: "group",
            entries: groupOverrideDisplay,
            runtime,
          })
        : undefined;

    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
    if (configState.dmPolicy) {
      lines.push(`DM policy: ${configState.dmPolicy}`);
    }
    if (configState.groupPolicy) {
      lines.push(`Group policy: ${configState.groupPolicy}`);
    }

    const showDm = parsed.scope === "dm" || parsed.scope === "all";
    const showGroup = parsed.scope === "group" || parsed.scope === "all";
    if (showDm) {
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay, resolvedDm)}`);
    }
    if (supportsStore && storeAllowFrom.length > 0) {
      const storeLabel = normalizeAllowFrom({
        cfg: params.cfg,
        channelId,
        accountId,
        values: storeAllowFrom,
        runtime,
      });
      lines.push(`Paired allowFrom (store): ${formatEntryList(storeLabel)}`);
    }
    if (showGroup) {
      if (groupAllowFrom.length > 0) {
        lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay, resolvedGroup)}`);
      }
      if (groupOverrides.length > 0) {
        lines.push("Group overrides:");
        for (const entry of groupOverrides) {
          const normalized = normalizeAllowFrom({
            cfg: params.cfg,
            channelId,
            accountId,
            values: entry.entries,
            runtime,
          });
          lines.push(`- ${entry.label}: ${formatEntryList(normalized, resolvedGroup)}`);
        }
      }
    }

    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/allowlist write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /allowlist add|remove requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/allowlist edits",
    configKey: "config",
    disabledVerb: "are",
  });
  if (disabled) {
    return disabled;
  }

  const shouldUpdateConfig = parsed.target !== "store";
  const shouldTouchStore = parsed.target !== "config" && Boolean(pairing);

  if (shouldUpdateConfig) {
    if (parsed.scope === "all") {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ /allowlist add|remove requires scope dm or group." },
      };
    }
    if (!allowlist?.applyConfigEdit) {
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
        },
      };
    }

    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Config file is invalid; fix it before using /allowlist." },
      };
    }
    const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
    const editResult = await allowlist.applyConfigEdit({
      cfg: params.cfg,
      parsedConfig,
      accountId,
      scope: parsed.scope,
      action: parsed.action,
      entry: parsed.entry,
    });
    if (!editResult) {
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
        },
      };
    }
    if (editResult.kind === "invalid-entry") {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Invalid allowlist entry." },
      };
    }
    const deniedText = resolveConfigWriteDeniedText({
      cfg: params.cfg,
      channel: params.command.channel,
      channelId,
      accountId,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target: editResult.writeTarget,
    });
    if (deniedText) {
      return {
        shouldContinue: false,
        reply: {
          text: deniedText,
        },
      };
    }
    const configChanged = editResult.changed;

    if (configChanged) {
      const validated = validateConfigObjectWithPlugins(parsedConfig);
      if (!validated.ok) {
        const issue = validated.issues[0];
        return {
          shouldContinue: false,
          reply: { text: `⚠️ Config invalid after update (${issue.path}: ${issue.message}).` },
        };
      }
      await replaceConfigFile({
        nextConfig: validated.config,
        afterWrite: { mode: "auto" },
      });
    }

    if (!configChanged && !shouldTouchStore) {
      const message = parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found.";
      return { shouldContinue: false, reply: { text: message } };
    }

    if (shouldTouchStore) {
      await updatePairingStoreAllowlist({
        action: parsed.action,
        channelId,
        accountId,
        entry: parsed.entry,
      });
    }

    const actionLabel = parsed.action === "add" ? "added" : "removed";
    const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
    const locations: string[] = [];
    if (configChanged) {
      locations.push(editResult.pathLabel);
    }
    if (shouldTouchStore) {
      locations.push("pairing store");
    }
    const targetLabel = locations.length > 0 ? locations.join(" + ") : "no-op";
    return {
      shouldContinue: false,
      reply: {
        text: `✅ ${scopeLabel} allowlist ${actionLabel}: ${targetLabel}.`,
      },
    };
  }

  if (!shouldTouchStore) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ This channel does not support allowlist storage." },
    };
  }

  await updatePairingStoreAllowlist({
    action: parsed.action,
    channelId,
    accountId,
    entry: parsed.entry,
  });

  const actionLabel = parsed.action === "add" ? "added" : "removed";
  const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
  return {
    shouldContinue: false,
    reply: { text: `✅ ${scopeLabel} allowlist ${actionLabel} in pairing store.` },
  };
};
