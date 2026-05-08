import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: getChannelPluginMock,
}));

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    getChannelPluginMock.mockReset();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("promotes caption to message for media sends when message is empty", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m1",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({
                channel: "testchat",
                messageId: "t1",
                chatId: "c1",
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        testchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/cat.png",
        caption: "caption-only text",
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption-only text",
        mediaUrl: "https://example.com/cat.png",
      }),
    );
  });

  it("does not misclassify send as poll when zero-valued poll params are present", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m2",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({
                channel: "testchat",
                messageId: "t2",
                chatId: "c1",
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        testchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/file.txt",
        message: "hello",
        pollDurationHours: 0,
        pollDurationSeconds: 0,
        pollMulti: false,
        pollQuestion: "",
        pollOption: [],
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        mediaUrl: "https://example.com/file.txt",
      }),
    );
  });

  it("accepts Telegram numeric forum topic targets through plugin-owned grammar", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
            },
            messaging: {
              normalizeTarget: (raw) =>
                raw === "-1001234567890:topic:42" ? "telegram:-1001234567890:topic:42" : undefined,
              targetResolver: {
                looksLikeId: (raw) => raw === "-1001234567890:topic:42",
              },
            },
          }),
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:test",
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "-1001234567890:topic:42",
        message: "topic hello",
      },
      dryRun: true,
    });

    if (result.kind !== "send") {
      throw new Error(`Expected send result, got ${result.kind}`);
    }
    expect(result.to).toBe("telegram:-1001234567890:topic:42");
    expect(result.payload).toEqual(
      expect.objectContaining({
        to: "telegram:-1001234567890:topic:42",
        dryRun: true,
      }),
    );
  });

  it("uses prepared outbound runtime without falling back to getChannelPlugin for known sends", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m3",
      chatId: "c1",
    });
    getChannelPluginMock.mockImplementation(() => {
      throw new Error("getChannelPlugin should not run for known outbound sends");
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
            messaging: {
              normalizeTarget: (raw) => (raw === "room-one" ? "channel:room-one" : undefined),
              targetResolver: {
                looksLikeId: () => true,
              },
            },
          }),
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          testchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "room-one",
        message: "prepared runtime",
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "channel:room-one",
        text: "prepared runtime",
      }),
    );
    expect(getChannelPluginMock).not.toHaveBeenCalled();
  });
});
