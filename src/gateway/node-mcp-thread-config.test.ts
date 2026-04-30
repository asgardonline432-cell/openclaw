import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import type { NodeMcpClientTransportOptions } from "./node-mcp-client-transport.js";
import { resolveNodeHostedThreadMcpServers } from "./node-mcp-thread-config.js";
import { NodeRegistry } from "./node-registry.js";
import type { ConnectParams } from "./protocol/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createNodeClient(): GatewayWsClient {
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
    mcpServers: [{ id: "computer-use", displayName: "Computer Use", status: "ready" }],
    device: {
      id: "mac-node",
      publicKey: "public-key",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    },
  };
  return {
    socket: { send() {} } as unknown as WebSocket,
    connect,
    connId: "mac-node-conn",
    usesSharedGatewayAuth: false,
  };
}

afterEach(async () => {
  await closeMcpLoopbackServer();
});

describe("resolveNodeHostedThreadMcpServers", () => {
  it("mints a distinct loopback URL for each Codex MCP client config", async () => {
    const nodeRegistry = new NodeRegistry();
    nodeRegistry.register(createNodeClient(), {});
    const context = {
      nodeRegistry,
      createNodeMcpClientTransport(_options: NodeMcpClientTransportOptions) {
        throw new Error("transport should not start while building thread config");
      },
    };

    const first = await resolveNodeHostedThreadMcpServers({ context, senderIsOwner: true });
    const second = await resolveNodeHostedThreadMcpServers({ context, senderIsOwner: true });

    const firstUrl = first?.["computer-use"]?.url;
    const secondUrl = second?.["computer-use"]?.url;
    expect(firstUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/node\/mac-node\/computer-use\/.+$/);
    expect(secondUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/node\/mac-node\/computer-use\/.+$/);
    expect(firstUrl).not.toBe(secondUrl);
  });
});
