import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeStickerImage } from "./sticker-cache.js";

const mocks = vi.hoisted(() => ({
  describeImageFileWithModel: vi.fn(async () => ({ text: "sticker description" })),
  findModelInCatalog: vi.fn(),
  loadModelCatalog: vi.fn(),
  modelSupportsVision: vi.fn(),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "redacted",
    mode: "api-key",
    source: "test",
  })),
  resolveAutoImageModel: vi.fn(),
  resolveAutoMediaKeyProviders: vi.fn(() => ["google"]),
  resolveDefaultMediaModel: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveModelCatalogScope: vi.fn(() => ({
    providerRefs: ["openai"],
    modelRefs: ["openai/gpt-5.5", "gpt-5.5"],
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  findModelInCatalog: mocks.findModelInCatalog,
  loadModelCatalog: mocks.loadModelCatalog,
  modelSupportsVision: mocks.modelSupportsVision,
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
  resolveModelCatalogScope: mocks.resolveModelCatalogScope,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  resolveAutoImageModel: mocks.resolveAutoImageModel,
  resolveAutoMediaKeyProviders: mocks.resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel: mocks.resolveDefaultMediaModel,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    mediaUnderstanding: {
      describeImageFileWithModel: mocks.describeImageFileWithModel,
    },
  }),
}));

describe("telegram sticker vision runtime", () => {
  beforeEach(() => {
    mocks.describeImageFileWithModel.mockClear();
    mocks.findModelInCatalog.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.modelSupportsVision.mockReset();
    mocks.resolveApiKeyForProvider.mockClear();
    mocks.resolveAutoImageModel.mockClear();
    mocks.resolveAutoMediaKeyProviders.mockClear();
    mocks.resolveDefaultMediaModel.mockClear();
    mocks.resolveDefaultModelForAgent.mockClear();
    mocks.resolveModelCatalogScope.mockClear();

    const catalogEntry = { provider: "openai", id: "gpt-5.5", input: ["text", "image"] };
    mocks.loadModelCatalog.mockResolvedValue([catalogEntry]);
    mocks.findModelInCatalog.mockReturnValue(catalogEntry);
    mocks.modelSupportsVision.mockReturnValue(true);
  });

  it("checks the configured default model with scoped catalog refs before fallback providers", async () => {
    const cfg = {
      tools: {
        media: {
          image: {
            models: [{ provider: "google", model: "gemini-2.5-flash" }],
          },
        },
      },
    };

    await expect(
      describeStickerImage({
        imagePath: "/tmp/sticker.webp",
        cfg,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe("sticker description");

    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      providerRefs: ["openai"],
      modelRefs: ["openai/gpt-5.5", "gpt-5.5"],
    });
    expect(mocks.resolveAutoMediaKeyProviders).not.toHaveBeenCalled();
    expect(mocks.resolveAutoImageModel).not.toHaveBeenCalled();
    expect(mocks.describeImageFileWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
      }),
    );
  });
});
