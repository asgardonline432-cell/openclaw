import { afterEach, describe, expect, it, vi } from "vitest";
import { botNames, botOpenIds, stopFeishuMonitorState, wsClients } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuWSClient: createFeishuWSClientMock,
}));

import { monitorWebSocket } from "./monitor.transport.js";

type MockWsClient = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type MockWsLifecycleCallbacks = {
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
};

function createAccount(accountId: string): ResolvedFeishuAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: `cli_${accountId}`,
    appSecret: `secret_${accountId}`, // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createWsClient(): MockWsClient {
  return {
    start: vi.fn(),
    close: vi.fn(),
  };
}

function getWsLifecycleCallbacks(): MockWsLifecycleCallbacks {
  const callbacks = createFeishuWSClientMock.mock.calls[0]?.[1] as
    | MockWsLifecycleCallbacks
    | undefined;
  if (!callbacks) {
    throw new Error("missing websocket lifecycle callbacks");
  }
  return callbacks;
}

afterEach(() => {
  vi.useRealTimers();
  stopFeishuMonitorState();
  vi.clearAllMocks();
});

describe("feishu websocket cleanup", () => {
  it("closes the websocket client when the monitor aborts", async () => {
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const accountId = "alpha";

    botOpenIds.set(accountId, "ou_alpha");
    botNames.set(accountId, "Alpha");

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(wsClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(wsClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.has(accountId)).toBe(false);
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
  });

  it("reports websocket connection state from SDK lifecycle callbacks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);
    const statusSink = vi.fn();

    const abortController = new AbortController();
    const monitorPromise = monitorWebSocket({
      account: createAccount("status"),
      accountId: "status",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
      statusSink,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
    });
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));

    vi.setSystemTime(10_000);
    getWsLifecycleCallbacks().onReady?.();
    expect(statusSink).toHaveBeenCalledWith({
      connected: true,
      mode: "websocket",
      healthState: "healthy",
      lastConnectedAt: 10_000,
      lastError: null,
    });

    vi.setSystemTime(11_000);
    getWsLifecycleCallbacks().onReconnecting?.();
    expect(statusSink).toHaveBeenCalledWith({
      connected: false,
      mode: "websocket",
      healthState: "reconnecting",
      lastDisconnect: { at: 11_000 },
      lastError: null,
    });

    vi.setSystemTime(12_000);
    getWsLifecycleCallbacks().onError?.(new Error("connect failed"));
    expect(statusSink).toHaveBeenCalledWith({
      connected: false,
      mode: "websocket",
      healthState: "disconnected",
      lastDisconnect: { at: 12_000, error: "connect failed" },
      lastError: "connect failed",
    });

    abortController.abort();
    await monitorPromise;
  });

  it("retries with backoff after websocket start rejects", async () => {
    vi.useFakeTimers();
    const failedClient = createWsClient();
    failedClient.start.mockRejectedValueOnce(
      new Error("connect failed\nAuthorization: Bearer token_abc appSecret=secret_abc"),
    );
    const recoveredClient = createWsClient();
    createFeishuWSClientMock
      .mockResolvedValueOnce(failedClient)
      .mockResolvedValueOnce(recoveredClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const accountId = "retry";

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(failedClient.start).toHaveBeenCalledTimes(1);
      expect(failedClient.close).toHaveBeenCalledTimes(1);
      expect(wsClients.has(accountId)).toBe(false);
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(recoveredClient.start).toHaveBeenCalledTimes(1);
      expect(wsClients.get(accountId)).toBe(recoveredClient);
    });

    abortController.abort();
    await monitorPromise;

    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(2);
    expect(recoveredClient.close).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("WebSocket start failed, retrying in 1000ms"),
    );
    const errorMessage = String(runtime.error.mock.calls[0]?.[0] ?? "");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("token_abc");
    expect(errorMessage).not.toContain("secret_abc");
    expect(errorMessage).toContain("Authorization: Bearer [redacted]");
    expect(errorMessage).toContain("appSecret=[redacted]");
  });

  it("redacts websocket close errors during abort cleanup", async () => {
    const wsClient = createWsClient();
    wsClient.close.mockImplementationOnce(() => {
      throw new Error("close failed\naccess_token=secret_token");
    });
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount("close-error"),
      accountId: "close-error",
      runtime,
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.waitFor(() => {
      expect(wsClient.start).toHaveBeenCalledTimes(1);
    });

    abortController.abort();
    await monitorPromise;

    const errorMessage = String(runtime.error.mock.calls[0]?.[0] ?? "");
    expect(errorMessage).toContain("error closing WebSocket client");
    expect(errorMessage).toContain("access_token=[redacted]");
    expect(errorMessage).not.toContain("\n");
    expect(errorMessage).not.toContain("secret_token");
  });

  it("closes targeted websocket clients during stop cleanup", () => {
    const alphaClient = createWsClient();
    const betaClient = createWsClient();

    wsClients.set("alpha", alphaClient as never);
    wsClients.set("beta", betaClient as never);
    botOpenIds.set("alpha", "ou_alpha");
    botOpenIds.set("beta", "ou_beta");
    botNames.set("alpha", "Alpha");
    botNames.set("beta", "Beta");

    stopFeishuMonitorState("alpha");

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).not.toHaveBeenCalled();
    expect(wsClients.has("alpha")).toBe(false);
    expect(wsClients.has("beta")).toBe(true);
    expect(botOpenIds.has("alpha")).toBe(false);
    expect(botOpenIds.has("beta")).toBe(true);
    expect(botNames.has("alpha")).toBe(false);
    expect(botNames.has("beta")).toBe(true);
  });

  it("closes all websocket clients during global stop cleanup", () => {
    const alphaClient = createWsClient();
    const betaClient = createWsClient();

    wsClients.set("alpha", alphaClient as never);
    wsClients.set("beta", betaClient as never);
    botOpenIds.set("alpha", "ou_alpha");
    botOpenIds.set("beta", "ou_beta");
    botNames.set("alpha", "Alpha");
    botNames.set("beta", "Beta");

    stopFeishuMonitorState();

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.size).toBe(0);
    expect(botOpenIds.size).toBe(0);
    expect(botNames.size).toBe(0);
  });
});
