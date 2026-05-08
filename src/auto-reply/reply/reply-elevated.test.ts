import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => channelPluginMocks.getChannelPlugin(...args),
}));

function buildConfig(allowFrom: string[]): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          whatsapp: allowFrom,
        },
      },
    },
  } as OpenClawConfig;
}

function buildContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderId: "+15550001111",
    From: "whatsapp:+15550001111",
    SenderE164: "+15550001111",
    To: "+15559990000",
    ...overrides,
  } as MsgContext;
}

function expectAllowFromDecision(params: {
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
}) {
  const result = resolveElevatedPermissions({
    cfg: buildConfig(params.allowFrom),
    agentId: "main",
    provider: "whatsapp",
    ctx: buildContext(params.ctx),
  });

  expect(result.enabled).toBe(true);
  expect(result.allowed).toBe(params.allowed);
  if (params.allowed) {
    expect(result.failures).toHaveLength(0);
    return;
  }

  expect(result.failures).toContainEqual({
    gate: "allowFrom",
    key: "tools.elevated.allowFrom.whatsapp",
  });
}

describe("resolveElevatedPermissions", () => {
  it("authorizes when sender matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15550001111"],
      allowed: true,
    });
  });

  it("does not authorize when only recipient matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15559990000"],
      allowed: false,
    });
  });

  it("does not authorize untyped mutable sender fields", () => {
    expectAllowFromDecision({
      allowFrom: ["owner-display-name"],
      allowed: false,
      ctx: {
        SenderName: "owner-display-name",
        SenderUsername: "owner-display-name",
        SenderTag: "owner-display-name",
      },
    });
  });

  it("authorizes mutable sender fields only with explicit prefix", () => {
    expectAllowFromDecision({
      allowFrom: ["username:owner_username"],
      allowed: true,
      ctx: {
        SenderUsername: "owner_username",
      },
    });
  });

  it("uses prepared elevated runtime without loading the channel plugin", () => {
    channelPluginMocks.getChannelPlugin.mockImplementation(() => {
      throw new Error("unexpected channel plugin lookup");
    });

    const result = resolveElevatedPermissions({
      cfg: {
        tools: {
          elevated: {},
        },
      } as OpenClawConfig,
      agentId: "main",
      provider: "whatsapp",
      ctx: buildContext(),
      runtime: {
        allowFromFallback: () => ["whatsapp:+15550001111"],
        formatAllowFrom: ({ allowFrom }) =>
          allowFrom.map((entry) => String(entry).replace(/^wa:/u, "whatsapp:")),
      },
    });

    expect(result).toEqual({
      enabled: true,
      allowed: true,
      failures: [],
    });
    expect(channelPluginMocks.getChannelPlugin).not.toHaveBeenCalled();
  });
});
