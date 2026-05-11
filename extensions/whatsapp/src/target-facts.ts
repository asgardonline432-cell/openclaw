import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppTarget,
} from "./normalize.js";
import { toWhatsappJid, toWhatsappJidWithLid, type JidToE164Options } from "./targets-runtime.js";

const TARGET_FORMAT_HINT = "<E.164|group JID|newsletter JID>";

export type WhatsAppTargetChatType = "direct" | "group" | "channel";

export type WhatsAppTargetFacts = {
  normalizedTarget: string;
  chatType: WhatsAppTargetChatType;
  routePeer: {
    kind: WhatsAppTargetChatType;
    id: string;
  };
  authorization: { allowed: true } | { allowed: false; error: Error };
  wireDelivery: {
    jid: string;
    shouldSendComposingPresence: boolean;
  };
};

export type WhatsAppTargetFactsResolution =
  | { ok: true; facts: WhatsAppTargetFacts }
  | { ok: false; error: Error };

export type ResolveWhatsAppTargetFactsParams = {
  target: string | null | undefined;
  allowFrom?: Array<string | number> | null;
  lidOptions?: JidToE164Options;
};

function targetError(): WhatsAppTargetFactsResolution {
  return {
    ok: false,
    error: missingTargetError("WhatsApp", TARGET_FORMAT_HINT),
  };
}

function chatTypeFor(normalizedTarget: string): WhatsAppTargetChatType {
  if (isWhatsAppGroupJid(normalizedTarget)) {
    return "group";
  }
  if (isWhatsAppNewsletterJid(normalizedTarget)) {
    return "channel";
  }
  return "direct";
}

function authorizeDirectTarget(params: {
  normalizedTarget: string;
  allowFrom: Array<string | number> | null | undefined;
}): WhatsAppTargetFacts["authorization"] {
  const allowFrom = (params.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (allowFrom.includes("*")) {
    return { allowed: true };
  }

  const normalizedAllowFrom = allowFrom
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (normalizedAllowFrom.length === 0 || normalizedAllowFrom.includes(params.normalizedTarget)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: new Error(
      `Target "${params.normalizedTarget}" is not listed in the configured WhatsApp allowFrom policy.`,
    ),
  };
}

function stripWhatsAppTargetPrefix(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

function wireJidFor(params: {
  rawTarget: string;
  normalizedTarget: string;
  chatType: WhatsAppTargetChatType;
  lidOptions: JidToE164Options | undefined;
}): string {
  if (params.chatType !== "direct") {
    return params.normalizedTarget;
  }
  const strippedRawTarget = stripWhatsAppTargetPrefix(params.rawTarget);
  const targetForWire = strippedRawTarget.includes("@")
    ? strippedRawTarget
    : params.normalizedTarget;
  return params.lidOptions
    ? toWhatsappJidWithLid(targetForWire, params.lidOptions)
    : toWhatsappJid(targetForWire);
}

export function resolveWhatsAppTargetFacts(
  params: ResolveWhatsAppTargetFactsParams,
): WhatsAppTargetFactsResolution {
  const rawTarget = params.target?.trim() ?? "";
  if (!rawTarget) {
    return targetError();
  }

  const normalizedTarget = normalizeWhatsAppTarget(rawTarget);
  if (!normalizedTarget) {
    return targetError();
  }

  const chatType = chatTypeFor(normalizedTarget);
  return {
    ok: true,
    facts: {
      normalizedTarget,
      chatType,
      routePeer: { kind: chatType, id: normalizedTarget },
      authorization:
        chatType === "direct"
          ? authorizeDirectTarget({ normalizedTarget, allowFrom: params.allowFrom })
          : { allowed: true },
      wireDelivery: {
        jid: wireJidFor({
          rawTarget,
          normalizedTarget,
          chatType,
          lidOptions: params.lidOptions,
        }),
        shouldSendComposingPresence: chatType !== "channel",
      },
    },
  };
}

export function requireWhatsAppTargetFacts(
  params: ResolveWhatsAppTargetFactsParams,
): WhatsAppTargetFacts {
  const resolution = resolveWhatsAppTargetFacts(params);
  if (!resolution.ok) {
    throw resolution.error;
  }
  return resolution.facts;
}
