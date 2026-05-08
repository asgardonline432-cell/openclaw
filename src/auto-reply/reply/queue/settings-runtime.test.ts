import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveQueueSettings } from "./settings-runtime.js";

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => channelPluginMocks.getChannelPlugin(...args),
}));

describe("resolveQueueSettings runtime wrapper", () => {
  it("uses prepared runtime debounce without loading channel plugins", () => {
    channelPluginMocks.getChannelPlugin.mockImplementation(() => {
      throw new Error("unexpected channel plugin lookup");
    });

    expect(
      resolveQueueSettings({
        cfg: {} as OpenClawConfig,
        channel: "discord",
        runtime: {
          queueDebounceMs: 1250,
        },
      }),
    ).toEqual({
      mode: "steer",
      debounceMs: 1250,
      cap: 20,
      dropPolicy: "summarize",
    });
    expect(channelPluginMocks.getChannelPlugin).not.toHaveBeenCalled();
  });
});
