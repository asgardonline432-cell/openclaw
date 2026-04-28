import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

vi.mock("../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) => {
    if (provider === "mistral") {
      return {
        buildReplayPolicy: () => ({
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict9",
        }),
      };
    }
    if (provider === "openrouter") {
      return {
        buildReplayPolicy: ({ modelId }: { modelId?: string }) =>
          modelId?.startsWith("mistralai/")
            ? {
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict9",
              }
            : undefined,
      };
    }
    return undefined;
  }),
}));

let resolveTranscriptPolicy: typeof import("./transcript-policy.js").resolveTranscriptPolicy;
const MISTRAL_PLUGIN_CONFIG = {
  plugins: {
    entries: {
      mistral: { enabled: true },
    },
  },
} as OpenClawConfig;

function createProviderRuntimeSmokeContext(): {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
} {
  const env = { ...process.env };
  delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete env.OPENCLAW_SKIP_PROVIDERS;
  delete env.OPENCLAW_SKIP_CHANNELS;
  delete env.OPENCLAW_SKIP_CRON;
  delete env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return {
    config: {},
    env,
    workspaceDir: process.cwd(),
  };
}

beforeAll(async () => {
  ({ resolveTranscriptPolicy } = await import("./transcript-policy.js"));
});

describe("resolveTranscriptPolicy provider replay policy", () => {
  it("uses images-only sanitization without tool-call id rewriting for OpenAI models", () => {
    const policy = resolveTranscriptPolicy({
      ...createProviderRuntimeSmokeContext(),
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });

  it("uses strict9 tool-call sanitization for Mistral-family models", () => {
    const policy = resolveTranscriptPolicy({
      ...createProviderRuntimeSmokeContext(),
      provider: "mistral",
      modelId: "mistral-large-latest",
      config: MISTRAL_PLUGIN_CONFIG,
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("uses strict9 tool-call sanitization for Mistral-family models routed through OpenRouter", () => {
    const policy = resolveTranscriptPolicy({
      ...createProviderRuntimeSmokeContext(),
      provider: "openrouter",
      modelId: "mistralai/mistral-large-latest",
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("keeps non-Mistral OpenRouter models on default tool-call id handling", () => {
    const policy = resolveTranscriptPolicy({
      ...createProviderRuntimeSmokeContext(),
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });
});
