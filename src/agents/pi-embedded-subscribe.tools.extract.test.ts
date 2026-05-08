import { beforeEach, describe, expect, it, vi } from "vitest";
import * as channelPlugins from "../channels/plugins/index.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { extractMessagingToolSend } from "./pi-embedded-subscribe.tools.js";

function normalizeTelegramMessagingTargetForTest(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed ? `telegram:${trimmed}` : undefined;
}

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { normalizeTarget: normalizeTelegramMessagingTargetForTest },
          },
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
          },
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({ id: "discord" }),
          source: "test",
        },
      ]),
    );
  });

  it("uses channel as provider for message tool", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("prefers provider when both provider and channel are set", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "slack",
      channel: "telegram",
      to: "channel:C1",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("slack");
    expect(result?.to).toBe("channel:c1");
  });

  it("accepts target alias when to is omitted", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      target: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("recognizes attachment-style message tool sends", () => {
    const upload = extractMessagingToolSend("message", {
      action: "upload-file",
      channel: "discord",
      to: "channel:123",
      path: "/tmp/song.mp3",
    });
    const attachment = extractMessagingToolSend("message", {
      action: "sendAttachment",
      provider: "discord",
      to: "channel:123",
      filePath: "/tmp/song.mp3",
    });
    const effect = extractMessagingToolSend("message", {
      action: "sendWithEffect",
      provider: "discord",
      to: "channel:123",
      content: "done",
    });

    expect(upload?.tool).toBe("message");
    expect(upload?.provider).toBe("discord");
    expect(upload?.to).toBe("channel:123");
    expect(attachment?.tool).toBe("message");
    expect(attachment?.provider).toBe("discord");
    expect(attachment?.to).toBe("channel:123");
    expect(effect?.tool).toBe("message");
    expect(effect?.provider).toBe("discord");
    expect(effect?.to).toBe("channel:123");
  });

  it("keeps thread id evidence for thread replies", () => {
    const result = extractMessagingToolSend("message", {
      action: "thread-reply",
      provider: "discord",
      to: "channel:123",
      threadId: "456",
      content: "done",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("discord");
    expect(result?.to).toBe("channel:123");
    expect(result?.threadId).toBe("456");
  });

  it("uses prepared action extractors without resolving channel plugins", () => {
    const getChannelPluginSpy = vi
      .spyOn(channelPlugins, "getChannelPlugin")
      .mockImplementation(() => {
        throw new Error("unexpected channel plugin lookup");
      });
    const actionExtractorsByToolName = new Map([
      [
        "slack",
        ({ args }: { args: Record<string, unknown> }) => ({
          to: String(args.channelId ?? ""),
          accountId: "acct-prepared",
        }),
      ],
    ]);

    try {
      expect(
        extractMessagingToolSend(
          "slack",
          {
            channelId: "C123",
          },
          actionExtractorsByToolName,
        ),
      ).toEqual({
        tool: "slack",
        provider: "slack",
        accountId: "acct-prepared",
        to: "C123",
      });
      expect(getChannelPluginSpy).not.toHaveBeenCalled();
    } finally {
      getChannelPluginSpy.mockRestore();
    }
  });
});
