import { beforeEach, describe, expect, it, vi } from "vitest";
import * as channelPlugins from "../../channels/plugins/index.js";
import type { OutboundChannelRuntime } from "../../infra/outbound/channel-resolution.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

describe("resolveAnnounceTargetFromKey", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("lets plugins own session-derived target shapes", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: undefined,
    });
    expect(resolveAnnounceTargetFromKey("agent:main:slack:group:C123")).toEqual({
      channel: "slack",
      to: "channel:C123",
      threadId: undefined,
    });
  });

  it("uses prepared outbound runtime without resolving the channel plugin", () => {
    const getChannelPluginSpy = vi
      .spyOn(channelPlugins, "getChannelPlugin")
      .mockImplementation(() => {
        throw new Error("unexpected channel plugin lookup");
      });
    const runtime = {
      id: "slack",
      label: "Slack",
      chatTypes: ["group"],
      resolveSessionTarget: ({ kind, id }) => `prepared:${kind}:${id}`,
    } satisfies OutboundChannelRuntime;

    try {
      expect(resolveAnnounceTargetFromKey("agent:main:slack:group:C123", runtime)).toEqual({
        channel: "slack",
        to: "prepared:group:C123",
        threadId: undefined,
      });
      expect(getChannelPluginSpy).not.toHaveBeenCalled();
    } finally {
      getChannelPluginSpy.mockRestore();
    }
  });

  it("keeps generic topic extraction and plugin normalization for other channels", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:telegram:group:-100123:topic:99")).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "99",
    });
  });

  it("preserves decimal thread ids for Slack-style session keys", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:slack:channel:general:thread:1699999999.0001"),
    ).toEqual({
      channel: "slack",
      to: "channel:general",
      threadId: "1699999999.0001",
    });
  });

  it("preserves colon-delimited matrix ids for channel and thread targets", () => {
    expect(
      resolveAnnounceTargetFromKey(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      channel: "matrix",
      to: "channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
  });

  it("preserves feishu conversation ids that embed :topic: in the base id", () => {
    expect(
      resolveAnnounceTargetFromKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      channel: "feishu",
      to: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
  });
});
