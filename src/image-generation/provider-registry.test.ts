import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";
import type * as ProviderRegistry from "./provider-registry.js";

const { resolvePluginCapabilityProviderMock, resolvePluginCapabilityProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginCapabilityProviderMock: vi.fn<() => ImageGenerationProviderPlugin | undefined>(),
    resolvePluginCapabilityProvidersMock: vi.fn<() => ImageGenerationProviderPlugin[]>(() => []),
  }),
);

let getImageGenerationProvider: typeof ProviderRegistry.getImageGenerationProvider;
let listImageGenerationProviders: typeof ProviderRegistry.listImageGenerationProviders;

function createProvider(
  params: Pick<ImageGenerationProviderPlugin, "id"> & Partial<ImageGenerationProviderPlugin>,
): ImageGenerationProviderPlugin {
  return {
    label: params.id,
    capabilities: {
      generate: {},
      edit: { enabled: false },
    },
    generateImage: async () => ({
      images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
    }),
    ...params,
  };
}

async function loadProviderRegistry() {
  vi.resetModules();
  vi.doMock("../plugins/capability-provider-runtime.js", () => ({
    resolvePluginCapabilityProvider: resolvePluginCapabilityProviderMock,
    resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
  }));
  return await import("./provider-registry.js");
}

function requireImageProvider(id: string): ImageGenerationProviderPlugin {
  const provider = getImageGenerationProvider(id);
  if (!provider) {
    throw new Error(`expected image generation provider ${id}`);
  }
  return provider;
}

describe("image-generation provider registry", () => {
  beforeEach(async () => {
    resolvePluginCapabilityProviderMock.mockReset();
    resolvePluginCapabilityProviderMock.mockReturnValue(undefined);
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
    ({ getImageGenerationProvider, listImageGenerationProviders } = await loadProviderRegistry());
  });

  it("delegates provider resolution to the capability provider boundary", () => {
    const cfg = {} as OpenClawConfig;

    expect(listImageGenerationProviders(cfg)).toStrictEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg,
    });
  });

  it("uses active plugin providers without loading from disk", () => {
    resolvePluginCapabilityProviderMock.mockReturnValue(createProvider({ id: "custom-image" }));

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolvePluginCapabilityProviderMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      providerId: "custom-image",
      cfg: undefined,
    });
    expect(resolvePluginCapabilityProvidersMock).not.toHaveBeenCalled();
  });

  it("falls back to alias maps when direct provider resolution misses", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "safe-image", aliases: ["safe-alias"] }),
    ]);

    const provider = getImageGenerationProvider("safe-alias");

    expect(provider?.id).toBe("safe-image");
    expect(resolvePluginCapabilityProviderMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      providerId: "safe-alias",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(requireImageProvider("safe-alias").id).toBe("safe-image");
  });
});
