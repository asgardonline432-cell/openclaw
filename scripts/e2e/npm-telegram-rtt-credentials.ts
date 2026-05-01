#!/usr/bin/env -S node --import tsx
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

type CredentialSource = "convex" | "env";
type CredentialRole = "ci" | "maintainer";

type TelegramCredentialPayload = {
  groupId: string;
  driverToken: string;
  sutToken: string;
};

type LeaseMetadata = {
  actorRole?: CredentialRole;
  credentialId?: string;
  heartbeatIntervalMs: number;
  kind: "telegram";
  leaseToken?: string;
  leaseTtlMs: number;
  ownerId?: string;
  source: CredentialSource;
};

type ConvexConfig = {
  acquireTimeoutMs: number;
  acquireUrl: string;
  authToken: string;
  heartbeatIntervalMs: number;
  heartbeatUrl: string;
  httpTimeoutMs: number;
  leaseTtlMs: number;
  ownerId: string;
  releaseUrl: string;
  role: CredentialRole;
};

class BrokerError extends Error {
  code: string;
  retryAfterMs?: number;

  constructor(params: { code: string; message: string; retryAfterMs?: number }) {
    super(params.message);
    this.name = "BrokerError";
    this.code = params.code;
    this.retryAfterMs = params.retryAfterMs;
  }
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 90_000;
const DEFAULT_ENDPOINT_PREFIX = "/qa-credentials/v1";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1_000;
const RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000] as const;
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function resolveCredentialSource(env: NodeJS.ProcessEnv): CredentialSource {
  const raw = env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE ?? env.OPENCLAW_QA_CREDENTIAL_SOURCE;
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "convex" || normalized === "env") {
    return normalized;
  }
  if (normalized) {
    throw new Error(`Credential source must be one of env or convex, got "${raw}".`);
  }
  if (
    isTruthyOptIn(env.CI) &&
    env.OPENCLAW_QA_CONVEX_SITE_URL?.trim() &&
    (env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim() || env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim())
  ) {
    return "convex";
  }
  return "env";
}

function resolveCredentialRole(env: NodeJS.ProcessEnv): CredentialRole {
  const raw = env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE ?? env.OPENCLAW_QA_CREDENTIAL_ROLE;
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "ci" || normalized === "maintainer") {
    return normalized;
  }
  if (normalized) {
    throw new Error(`Credential role must be one of maintainer or ci, got "${raw}".`);
  }
  return isTruthyOptIn(env.CI) ? "ci" : "maintainer";
}

function normalizeSiteUrl(raw: string, env: NodeJS.ProcessEnv) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OPENCLAW_QA_CONVEX_SITE_URL must be a valid URL.`);
  }
  if (url.protocol === "https:") {
    return url.toString().replace(/\/$/u, "");
  }
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127.");
  if (
    url.protocol === "http:" &&
    isLoopback &&
    isTruthyOptIn(env.OPENCLAW_QA_ALLOW_INSECURE_HTTP)
  ) {
    return url.toString().replace(/\/$/u, "");
  }
  throw new Error("OPENCLAW_QA_CONVEX_SITE_URL must use https://.");
}

function normalizeEndpointPrefix(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_ENDPOINT_PREFIX;
  }
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const normalized = prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    throw new Error("OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must be an absolute path.");
  }
  if (normalized.includes("\\") || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX must not contain path traversal.");
  }
  return normalized;
}

function joinEndpoint(baseUrl: string, prefix: string, suffix: string) {
  const url = new URL(baseUrl);
  url.pathname = `${prefix}/${suffix}`.replace(/\/{2,}/gu, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveAuthToken(env: NodeJS.ProcessEnv, role: CredentialRole) {
  const token =
    role === "ci"
      ? env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim()
      : env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  if (token) {
    return token;
  }
  if (role === "ci") {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SECRET_CI for CI credential access.");
  }
  throw new Error("Missing OPENCLAW_QA_CONVEX_SECRET_MAINTAINER for maintainer credential access.");
}

function resolveConvexConfig(env: NodeJS.ProcessEnv, role: CredentialRole): ConvexConfig {
  const siteUrl = env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  if (!siteUrl) {
    throw new Error("Missing OPENCLAW_QA_CONVEX_SITE_URL for Convex credential access.");
  }
  const baseUrl = normalizeSiteUrl(siteUrl, env);
  const endpointPrefix = normalizeEndpointPrefix(env.OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX);
  const ownerId =
    env.OPENCLAW_QA_CREDENTIAL_OWNER_ID?.trim() ||
    `npm-telegram-rtt-${role}-${process.pid}-${randomUUID().slice(0, 8)}`;
  return {
    role,
    ownerId,
    authToken: resolveAuthToken(env, role),
    leaseTtlMs: parsePositiveIntegerEnv(
      env,
      "OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS",
      DEFAULT_LEASE_TTL_MS,
    ),
    heartbeatIntervalMs: parsePositiveIntegerEnv(
      env,
      "OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS",
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    acquireTimeoutMs: parsePositiveIntegerEnv(
      env,
      "OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS",
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    ),
    httpTimeoutMs: parsePositiveIntegerEnv(
      env,
      "OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS",
      DEFAULT_HTTP_TIMEOUT_MS,
    ),
    acquireUrl: joinEndpoint(baseUrl, endpointPrefix, "acquire"),
    heartbeatUrl: joinEndpoint(baseUrl, endpointPrefix, "heartbeat"),
    releaseUrl: joinEndpoint(baseUrl, endpointPrefix, "release"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload.");
  }
  return value as Record<string, unknown>;
}

function parseTelegramPayload(value: unknown): TelegramCredentialPayload {
  const payload = asRecord(value);
  const groupId = typeof payload.groupId === "string" ? payload.groupId.trim() : "";
  const driverToken = typeof payload.driverToken === "string" ? payload.driverToken.trim() : "";
  const sutToken = typeof payload.sutToken === "string" ? payload.sutToken.trim() : "";
  if (!/^-?\d+$/u.test(groupId)) {
    throw new Error("Telegram credential payload groupId must be a numeric Telegram chat id.");
  }
  if (!driverToken || !sutToken) {
    throw new Error("Telegram credential payload must include driverToken and sutToken.");
  }
  return { groupId, driverToken, sutToken };
}

function resolveEnvPayload(env: NodeJS.ProcessEnv): TelegramCredentialPayload {
  return parseTelegramPayload({
    groupId: env.OPENCLAW_QA_TELEGRAM_GROUP_ID,
    driverToken: env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN,
    sutToken: env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN,
  });
}

async function postJson(params: {
  authToken: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  url: string;
}) {
  const response = await fetch(params.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const text = await response.text();
  const payload = (() => {
    if (!text.trim()) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  })();
  const parsed =
    payload !== undefined &&
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
      ? asRecord(payload)
      : undefined;
  if (parsed?.status === "error") {
    throw new BrokerError({
      code: typeof parsed.code === "string" ? parsed.code : "UNKNOWN",
      message:
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message
          : `Convex credential broker request failed (${response.status}).`,
      retryAfterMs: typeof parsed.retryAfterMs === "number" ? parsed.retryAfterMs : undefined,
    });
  }
  if (!response.ok) {
    throw new Error(`Convex credential broker request failed with HTTP ${response.status}.`);
  }
  return payload;
}

function assertOk(payload: unknown, action: string) {
  if (payload === undefined) {
    return;
  }
  const parsed = asRecord(payload);
  if (parsed.status === "ok") {
    return;
  }
  throw new Error(`Convex credential ${action} failed with an invalid response payload.`);
}

function computeBackoffMs(params: { attempt: number; retryAfterMs?: number }) {
  if (params.retryAfterMs && params.retryAfterMs > 0) {
    return params.retryAfterMs;
  }
  const base = RETRY_BACKOFF_MS[Math.min(RETRY_BACKOFF_MS.length - 1, params.attempt - 1)];
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(100, Math.round(base * jitter));
}

async function acquireConvex(env: NodeJS.ProcessEnv): Promise<{
  lease: LeaseMetadata;
  payload: TelegramCredentialPayload;
}> {
  const role = resolveCredentialRole(env);
  const config = resolveConvexConfig(env, role);
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const response = asRecord(
        await postJson({
          authToken: config.authToken,
          timeoutMs: config.httpTimeoutMs,
          url: config.acquireUrl,
          body: {
            kind: "telegram",
            ownerId: config.ownerId,
            actorRole: config.role,
            leaseTtlMs: config.leaseTtlMs,
            heartbeatIntervalMs: config.heartbeatIntervalMs,
          },
        }),
      );
      if (response.status !== "ok") {
        throw new Error("Convex credential acquire returned an invalid response payload.");
      }
      const credentialId =
        typeof response.credentialId === "string" ? response.credentialId.trim() : "";
      const leaseToken = typeof response.leaseToken === "string" ? response.leaseToken.trim() : "";
      if (!credentialId || !leaseToken) {
        throw new Error("Convex credential acquire response is missing lease metadata.");
      }
      const leaseTtlMs =
        typeof response.leaseTtlMs === "number" && response.leaseTtlMs > 0
          ? response.leaseTtlMs
          : config.leaseTtlMs;
      const heartbeatIntervalMs =
        typeof response.heartbeatIntervalMs === "number" && response.heartbeatIntervalMs > 0
          ? response.heartbeatIntervalMs
          : config.heartbeatIntervalMs;
      return {
        payload: parseTelegramPayload(response.payload),
        lease: {
          source: "convex",
          kind: "telegram",
          actorRole: config.role,
          ownerId: config.ownerId,
          credentialId,
          leaseToken,
          leaseTtlMs,
          heartbeatIntervalMs,
        },
      };
    } catch (error) {
      if (error instanceof BrokerError && RETRYABLE_ACQUIRE_CODES.has(error.code)) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= config.acquireTimeoutMs) {
          throw new Error(
            `Convex credential pool exhausted for kind "telegram" after ${config.acquireTimeoutMs}ms.`,
          );
        }
        const delayMs = Math.min(
          computeBackoffMs({ attempt, retryAfterMs: error.retryAfterMs }),
          Math.max(0, config.acquireTimeoutMs - elapsed),
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
}

async function postLeaseAction(action: "heartbeat" | "release", lease: LeaseMetadata) {
  if (lease.source !== "convex") {
    return;
  }
  if (!lease.actorRole || !lease.ownerId || !lease.credentialId || !lease.leaseToken) {
    throw new Error(`Convex credential ${action} is missing lease metadata.`);
  }
  const config = resolveConvexConfig(process.env, lease.actorRole);
  const payload = await postJson({
    authToken: config.authToken,
    timeoutMs: config.httpTimeoutMs,
    url: action === "heartbeat" ? config.heartbeatUrl : config.releaseUrl,
    body: {
      kind: lease.kind,
      ownerId: lease.ownerId,
      credentialId: lease.credentialId,
      leaseToken: lease.leaseToken,
      actorRole: lease.actorRole,
      ...(action === "heartbeat" ? { leaseTtlMs: lease.leaseTtlMs } : {}),
    },
  });
  assertOk(payload, action);
}

async function runCommand(args: string[]) {
  const separator = args.indexOf("--");
  const command = separator >= 0 ? args[separator + 1] : undefined;
  const commandArgs = separator >= 0 ? args.slice(separator + 2) : [];
  if (!command) {
    throw new Error("usage: run -- COMMAND [ARGS...]");
  }
  const source = resolveCredentialSource(process.env);
  const acquired =
    source === "convex"
      ? await acquireConvex(process.env)
      : {
          payload: resolveEnvPayload(process.env),
          lease: {
            source: "env" as const,
            kind: "telegram" as const,
            leaseTtlMs: 0,
            heartbeatIntervalMs: 0,
          },
        };
  process.stderr.write(`[rtt] credential source: ${acquired.lease.source}\n`);
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatFailure: Error | undefined;
  let childProcess: ReturnType<typeof spawn> | undefined;
  const scheduleHeartbeat = () => {
    if (acquired.lease.source !== "convex" || acquired.lease.heartbeatIntervalMs < 1) {
      return;
    }
    heartbeatTimer = setTimeout(() => {
      void postLeaseAction("heartbeat", acquired.lease)
        .then(scheduleHeartbeat)
        .catch((error) => {
          heartbeatFailure = error instanceof Error ? error : new Error(String(error));
          childProcess?.kill("SIGTERM");
        });
    }, acquired.lease.heartbeatIntervalMs);
  };
  scheduleHeartbeat();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      childProcess = spawn(command, commandArgs, {
        env: {
          ...process.env,
          OPENCLAW_QA_TELEGRAM_GROUP_ID: acquired.payload.groupId,
          OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: acquired.payload.driverToken,
          OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: acquired.payload.sutToken,
        },
        stdio: "inherit",
      });
      childProcess.once("error", reject);
      childProcess.once("exit", (code) => resolve(code ?? 1));
    });
    if (heartbeatFailure) {
      throw heartbeatFailure;
    }
    process.exitCode = exitCode;
  } finally {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
    await postLeaseAction("release", acquired.lease);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") {
    await runCommand(args);
  } else {
    throw new Error("usage: npm-telegram-rtt-credentials.ts run -- COMMAND [ARGS...]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `RTT credential setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export const __testing = {
  parseTelegramPayload,
  resolveCredentialRole,
  resolveCredentialSource,
};
