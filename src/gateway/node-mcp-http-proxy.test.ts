import { Buffer } from "node:buffer";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  closeMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
  startMcpLoopbackServer,
} from "./mcp-http.js";
import { resolveMcpLoopbackBearerToken } from "./mcp-http.loopback-runtime.js";
import { NodeMcpClientTransport } from "./node-mcp-client-transport.js";
import { NodeRegistry } from "./node-registry.js";
import type { ConnectParams } from "./protocol/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createNodeClient(params: { nodeId?: string; mcpServers?: unknown[] }): {
  client: GatewayWsClient;
  sent: Array<{ event: string; payload: unknown }>;
} {
  const sent: Array<{ event: string; payload: unknown }> = [];
  const nodeId = params.nodeId ?? "mac-node";
  const connect: ConnectParams = {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "node-host",
      displayName: "Mac",
      version: "dev",
      platform: "macOS",
      mode: "node",
    },
    role: "node",
    scopes: [],
    caps: ["mcpHost"],
    commands: [],
    mcpServers: params.mcpServers as ConnectParams["mcpServers"],
    device: {
      id: nodeId,
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
  };
  const socket = {
    send(data: string) {
      const frame = JSON.parse(data) as { event?: string; payload?: unknown };
      if (frame.event) {
        sent.push({ event: frame.event, payload: frame.payload });
      }
    },
  } as unknown as WebSocket;
  return {
    client: {
      socket,
      connect,
      connId: `${nodeId}-conn`,
      usesSharedGatewayAuth: false,
    },
    sent,
  };
}

function sendNodeMcpRequest(params: {
  port: number;
  token: string;
  nodeId?: string;
  serverId?: string;
  clientId?: string;
  body: unknown;
  signal?: AbortSignal;
}) {
  const nodeId = encodeURIComponent(params.nodeId ?? "mac-node");
  const serverId = encodeURIComponent(params.serverId ?? "computer-use");
  const clientSuffix = params.clientId ? `/${encodeURIComponent(params.clientId)}` : "";
  return fetch(`http://127.0.0.1:${params.port}/mcp/node/${nodeId}/${serverId}${clientSuffix}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
  });
}

afterEach(async () => {
  await closeMcpLoopbackServer();
});

describe("node MCP loopback proxy", () => {
  it("forwards HTTP MCP JSON-RPC to a node-hosted MCP session", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", displayName: "Computer Use", status: "ready" }],
    });
    registry.register(client, {});
    const server = await startMcpLoopbackServer(0, {
      createNodeMcpClientTransport: (options) => new NodeMcpClientTransport(registry, options),
    });
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime).toBeTruthy();

    const responsePromise = sendNodeMcpRequest({
      port: server.port,
      token: resolveMcpLoopbackBearerToken(runtime!, true),
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.event === "node.mcp.session.open")).toBe(true);
    });
    const openPayload = sent.find((entry) => entry.event === "node.mcp.session.open")?.payload as {
      sessionId?: string;
    };
    expect(openPayload.sessionId).toBeTruthy();
    registry.handleMcpSessionOpenResult({
      sessionId: openPayload.sessionId!,
      nodeId: "mac-node",
      serverId: "computer-use",
      ok: true,
      pid: 42,
    });

    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.event === "node.mcp.session.input")).toBe(true);
    });
    const inputPayload = sent.find((entry) => entry.event === "node.mcp.session.input")
      ?.payload as {
      dataBase64?: string;
      seq?: number;
    };
    expect(Buffer.from(inputPayload.dataBase64 ?? "", "base64").toString("utf8")).toBe(
      serializeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );

    registry.handleMcpSessionOutput({
      sessionId: openPayload.sessionId!,
      nodeId: "mac-node",
      seq: inputPayload.seq ?? 0,
      stream: "stdout",
      dataBase64: Buffer.from(
        serializeMessage({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "mock-computer-use", version: "1" },
          },
        }),
      ).toString("base64"),
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: "mock-computer-use" },
      },
    });
  });

  it("isolates node MCP sessions by loopback client id", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", displayName: "Computer Use", status: "ready" }],
    });
    registry.register(client, {});
    const server = await startMcpLoopbackServer(0, {
      createNodeMcpClientTransport: (options) => new NodeMcpClientTransport(registry, options),
    });
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime).toBeTruthy();
    const token = resolveMcpLoopbackBearerToken(runtime!, true);

    const firstResponsePromise = sendNodeMcpRequest({
      port: server.port,
      token,
      clientId: "thread-a",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    const secondResponsePromise = sendNodeMcpRequest({
      port: server.port,
      token,
      clientId: "thread-b",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });

    await vi.waitFor(() => {
      expect(sent.filter((entry) => entry.event === "node.mcp.session.open")).toHaveLength(2);
    });
    const openPayloads = sent
      .filter((entry) => entry.event === "node.mcp.session.open")
      .map((entry) => entry.payload as { sessionId?: string });
    expect(new Set(openPayloads.map((entry) => entry.sessionId)).size).toBe(2);
    for (const openPayload of openPayloads) {
      expect(openPayload.sessionId).toBeTruthy();
      registry.handleMcpSessionOpenResult({
        sessionId: openPayload.sessionId!,
        nodeId: "mac-node",
        serverId: "computer-use",
        ok: true,
        pid: 42,
      });
    }

    await vi.waitFor(() => {
      expect(sent.filter((entry) => entry.event === "node.mcp.session.input")).toHaveLength(2);
    });
    const inputPayloads = sent
      .filter((entry) => entry.event === "node.mcp.session.input")
      .map(
        (entry) =>
          entry.payload as {
            dataBase64?: string;
            seq?: number;
            sessionId?: string;
          },
      );
    for (const inputPayload of inputPayloads) {
      expect(Buffer.from(inputPayload.dataBase64 ?? "", "base64").toString("utf8")).toBe(
        serializeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      );
      registry.handleMcpSessionOutput({
        sessionId: inputPayload.sessionId!,
        nodeId: "mac-node",
        seq: inputPayload.seq ?? 0,
        stream: "stdout",
        dataBase64: Buffer.from(
          serializeMessage({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: `mock-${inputPayload.sessionId}`, version: "1" },
            },
          }),
        ).toString("base64"),
      });
    }

    const responses = await Promise.all([firstResponsePromise, secondResponsePromise]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies).toEqual([
      expect.objectContaining({ id: 1, result: expect.any(Object) }),
      expect.objectContaining({ id: 1, result: expect.any(Object) }),
    ]);
  });

  it("closes node MCP startup when the HTTP request aborts before open resolves", async () => {
    const registry = new NodeRegistry();
    const { client, sent } = createNodeClient({
      mcpServers: [{ id: "computer-use", displayName: "Computer Use", status: "ready" }],
    });
    registry.register(client, {});
    const server = await startMcpLoopbackServer(0, {
      createNodeMcpClientTransport: (options) => new NodeMcpClientTransport(registry, options),
    });
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime).toBeTruthy();
    const controller = new AbortController();

    const responsePromise = sendNodeMcpRequest({
      port: server.port,
      token: resolveMcpLoopbackBearerToken(runtime!, true),
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.event === "node.mcp.session.open")).toBe(true);
    });
    const openPayload = sent.find((entry) => entry.event === "node.mcp.session.open")?.payload as {
      sessionId?: string;
    };
    expect(openPayload.sessionId).toBeTruthy();

    controller.abort();

    await expect(responsePromise).rejects.toThrow();
    await vi.waitFor(() => {
      expect(sent.at(-1)).toEqual({
        event: "node.mcp.session.close",
        payload: {
          sessionId: openPayload.sessionId,
          nodeId: "mac-node",
          reason: "client_close",
        },
      });
    });
    expect(
      registry.handleMcpSessionOpenResult({
        sessionId: openPayload.sessionId!,
        nodeId: "mac-node",
        serverId: "computer-use",
        ok: true,
        pid: 42,
      }),
    ).toBe(false);
  });

  it("requires the owner loopback token for node-hosted MCP servers", async () => {
    const server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    expect(runtime).toBeTruthy();

    const response = await sendNodeMcpRequest({
      port: server.port,
      token: resolveMcpLoopbackBearerToken(runtime!, false),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Owner token required" },
    });
  });
});
