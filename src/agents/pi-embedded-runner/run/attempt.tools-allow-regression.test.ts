import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

describe("runEmbeddedAttempt toolsAllow startup cost", () => {
  const tempPaths: string[] = [];

  function createTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    };
  }

  async function runWithAllowlist(params: { toolsAllow: string[]; toolNames: string[] }) {
    const hoisted = getHoisted();
    hoisted.createOpenClawCodingToolsMock.mockReturnValue(params.toolNames.map(createTool));

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      attemptOverrides: {
        toolsAllow: params.toolsAllow,
      },
      sessionKey: "agent:main:main",
      tempPaths,
    });

    return hoisted;
  }

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("keeps plugin-only allowlists on the shared tool policy path", async () => {
    const hoisted = await runWithAllowlist({
      toolsAllow: ["plugin_extra"],
      toolNames: ["plugin_extra", "workflow_tool"],
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeCoreTools: false,
        runtimeToolAllowlist: ["plugin_extra"],
      }),
    );
    const createSessionOptions = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as
      | { customTools?: { name: string }[] }
      | undefined;
    expect(createSessionOptions?.customTools?.map((tool) => tool.name)).toEqual(["plugin_extra"]);
  });

  it.each([
    {
      label: "process",
      toolsAllow: ["process"],
      toolNames: ["process", "memory_search"],
      expectedTools: ["process"],
    },
    {
      label: "heartbeat_respond",
      toolsAllow: ["heartbeat_respond"],
      toolNames: ["heartbeat_respond", "memory_search"],
      expectedTools: ["heartbeat_respond"],
    },
    {
      label: "group:runtime",
      toolsAllow: ["group:runtime"],
      toolNames: ["process", "memory_search"],
      expectedTools: ["process"],
    },
    {
      label: "group:openclaw",
      toolsAllow: ["group:openclaw"],
      toolNames: ["heartbeat_respond", "plugin_extra"],
      expectedTools: ["heartbeat_respond"],
    },
  ])("builds core coding tools for $label allowlists", async (params) => {
    const hoisted = await runWithAllowlist(params);

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeCoreTools: true,
        runtimeToolAllowlist: params.toolsAllow,
      }),
    );
    const createSessionOptions = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as
      | { customTools?: { name: string }[] }
      | undefined;
    expect(createSessionOptions?.customTools?.map((tool) => tool.name)).toEqual(
      params.expectedTools,
    );
  });
});
