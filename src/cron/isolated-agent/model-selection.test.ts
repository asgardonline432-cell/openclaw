import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async () => [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }]),
  resolveConfiguredModelRef: vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  })),
  resolveAllowedModelRef: vi.fn(() => ({
    ref: { provider: "openai", model: "gpt-5.4" },
    key: "openai/gpt-5.4",
  })),
  getModelRefStatus: vi.fn(() => ({
    allowed: true,
    inCatalog: true,
    key: "openai/gpt-5.4",
  })),
  normalizeModelSelection: vi.fn((value: unknown) =>
    typeof value === "string" ? value : undefined,
  ),
  resolveHooksGmailModel: vi.fn(() => null),
}));

vi.mock("./run-model-selection.runtime.js", () => ({
  DEFAULT_MODEL: "gpt-5.4",
  DEFAULT_PROVIDER: "openai",
  getModelRefStatus: hoisted.getModelRefStatus,
  loadModelCatalog: hoisted.loadModelCatalog,
  normalizeModelSelection: hoisted.normalizeModelSelection,
  resolveAllowedModelRef: hoisted.resolveAllowedModelRef,
  resolveConfiguredModelRef: hoisted.resolveConfiguredModelRef,
  resolveHooksGmailModel: hoisted.resolveHooksGmailModel,
}));

import { resolveCronModelSelection } from "./model-selection.js";

describe("resolveCronModelSelection", () => {
  beforeEach(() => {
    hoisted.loadModelCatalog.mockClear();
    hoisted.resolveConfiguredModelRef.mockClear();
    hoisted.resolveAllowedModelRef.mockClear();
    hoisted.getModelRefStatus.mockClear();
    hoisted.normalizeModelSelection.mockClear();
    hoisted.resolveHooksGmailModel.mockClear();
  });

  it("uses cache-only catalog intent for cron selection validation", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
      },
    } as OpenClawConfig;

    await resolveCronModelSelection({
      cfg,
      cfgWithAgentDefaults: cfg,
      agentConfigOverride: {
        model: "openai/gpt-5.4",
      },
      sessionEntry: {},
      payload: {
        kind: "agentTurn",
        message: "hi",
      } as never,
      isGmailHook: false,
    });

    expect(hoisted.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      intent: "cacheOnly",
      source: "cron.model-selection",
    });
  });

  it("falls back to runtime discovery when cache-only validation rejects an explicit model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
      },
    } as OpenClawConfig;
    hoisted.loadModelCatalog
      .mockResolvedValueOnce([{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }])
      .mockResolvedValueOnce([{ provider: "ollama", id: "qwen3:0.6b", name: "qwen3:0.6b" }]);
    hoisted.resolveAllowedModelRef
      .mockReturnValueOnce({ error: "model not allowed: ollama/qwen3:0.6b" })
      .mockReturnValueOnce({
        ref: { provider: "ollama", model: "qwen3:0.6b" },
        key: "ollama/qwen3:0.6b",
      });

    const result = await resolveCronModelSelection({
      cfg,
      cfgWithAgentDefaults: cfg,
      agentConfigOverride: undefined,
      sessionEntry: {},
      payload: {
        kind: "agentTurn",
        message: "hi",
        model: "ollama/qwen3:0.6b",
      } as never,
      isGmailHook: false,
    });

    expect(result).toEqual({ ok: true, provider: "ollama", model: "qwen3:0.6b" });
    expect(hoisted.loadModelCatalog).toHaveBeenNthCalledWith(1, {
      config: cfg,
      intent: "cacheOnly",
      source: "cron.model-selection",
    });
    expect(hoisted.loadModelCatalog).toHaveBeenNthCalledWith(2, {
      config: cfg,
      intent: "runtimeDiscovery",
      source: "cron.model-selection.discovery",
    });
  });
});
