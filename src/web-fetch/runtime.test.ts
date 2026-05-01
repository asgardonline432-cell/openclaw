import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  createWebFetchTestProvider,
  type WebFetchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebFetchConfig = {
  webFetch?: {
    apiKey?: unknown;
  };
};

const { resolvePluginWebFetchProvidersMock, resolveRuntimeWebFetchProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
    resolveRuntimeWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  }),
);

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProviders: resolveRuntimeWebFetchProvidersMock,
}));

function getFirecrawlApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
    | TestPluginWebFetchConfig
    | undefined;
  return pluginConfig?.webFetch?.apiKey;
}

function createFirecrawlProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "firecrawl",
    id: "firecrawl",
    credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
    autoDetectOrder: 1,
    ...overrides,
  });
}

function createThirdPartyFetchProvider(): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "third-party-fetch",
    id: "thirdparty",
    credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
    autoDetectOrder: 0,
    getConfiguredCredentialValue: () => "runtime-key",
  });
}

function createFirecrawlPluginConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: {
          enabled: true,
          config: {
            webFetch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;
  let prepareWebFetchDefinition: typeof import("./runtime.js").prepareWebFetchDefinition;
  let runtimeTesting: typeof import("./runtime.js").__testing;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({
      resolveWebFetchDefinition,
      prepareWebFetchDefinition,
      __testing: runtimeTesting,
    } = await import("./runtime.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    runtimeTesting.clearPreparedWebFetchDefinitionCache();
    vi.unstubAllEnvs();
    resolvePluginWebFetchProvidersMock.mockReset();
    resolveRuntimeWebFetchProvidersMock.mockReset();
    resolvePluginWebFetchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("does not auto-detect providers from plugin-owned env SecretRefs without runtime metadata", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config = createFirecrawlPluginConfig({
      source: "env",
      provider: "default",
      id: "AWS_SECRET_ACCESS_KEY",
    });

    vi.stubEnv("FIRECRAWL_API_KEY", "");

    expect(resolveWebFetchDefinition({ config })).toBeNull();
  });

  it("prefers the runtime-selected provider when metadata is available", async () => {
    const provider = createFirecrawlProvider({
      createTool: ({ runtimeMetadata }) => ({
        description: "firecrawl",
        parameters: {},
        execute: async (args) => ({
          ...args,
          provider: runtimeMetadata?.selectedProvider ?? "firecrawl",
        }),
      }),
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([provider]);

    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };

    const resolved = resolveWebFetchDefinition({
      config: {},
      runtimeWebFetch,
      preferRuntimeProviders: true,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
    await expect(
      resolved?.definition.execute({
        url: "https://example.com",
        extractMode: "markdown",
        maxChars: 1000,
      }),
    ).resolves.toEqual({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 1000,
      provider: "firecrawl",
    });
  });

  it("reuses a prepared resolved definition when the resolution inputs match", () => {
    const createTool = vi.fn(
      ({ runtimeMetadata }: { runtimeMetadata?: RuntimeWebFetchMetadata }) => ({
        description: "firecrawl",
        parameters: {},
        execute: async (args: Record<string, unknown>) => ({
          ...args,
          provider: runtimeMetadata?.selectedProvider ?? "firecrawl",
        }),
      }),
    );
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
      createTool,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config = createFirecrawlPluginConfig("firecrawl-key");
    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      providerSource: "auto-detect",
      providerConfigured: "firecrawl",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "config",
      diagnostics: [],
    };

    const prepared = prepareWebFetchDefinition({
      config,
      runtimeWebFetch,
    });

    expect(prepared?.provider.id).toBe("firecrawl");
    expect(createTool).toHaveBeenCalledTimes(1);

    resolvePluginWebFetchProvidersMock.mockImplementation(() => {
      throw new Error("plugin providers should not re-resolve on cache hit");
    });

    const resolved = resolveWebFetchDefinition({
      config,
      runtimeWebFetch,
    });

    expect(resolved).toBe(prepared);
    expect(createTool).toHaveBeenCalledTimes(1);
  });

  it("falls back to uncached resolution when the runtime-selected provider changes", () => {
    const firecrawlTool = vi.fn(() => ({
      description: "firecrawl",
      parameters: {},
      execute: async () => ({ provider: "firecrawl" }),
    }));
    const thirdPartyTool = vi.fn(() => ({
      description: "thirdparty",
      parameters: {},
      execute: async () => ({ provider: "thirdparty" }),
    }));
    const firecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
      createTool: firecrawlTool,
    });
    const thirdParty = createWebFetchTestProvider({
      pluginId: "alt-fetch",
      id: "alt",
      credentialPath: "plugins.entries.alt-fetch.config.webFetch.apiKey",
      autoDetectOrder: 0,
      getConfiguredCredentialValue: () => "alt-key",
      createTool: thirdPartyTool,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([firecrawl, thirdParty]);

    const config = {
      plugins: {
        entries: {
          firecrawl: {
            enabled: true,
            config: { webFetch: { apiKey: "firecrawl-key" } },
          },
          "alt-fetch": {
            enabled: true,
            config: { webFetch: { apiKey: "alt-key" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    const prepared = prepareWebFetchDefinition({
      config,
      runtimeWebFetch: {
        providerSource: "auto-detect",
        providerConfigured: "firecrawl",
        selectedProvider: "firecrawl",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    expect(prepared?.provider.id).toBe("firecrawl");

    const resolved = resolveWebFetchDefinition({
      config,
      runtimeWebFetch: {
        providerSource: "configured",
        providerConfigured: "alt",
        selectedProvider: "alt",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    expect(resolved?.provider.id).toBe("alt");
    expect(firecrawlTool).toHaveBeenCalledTimes(1);
    expect(thirdPartyTool).toHaveBeenCalledTimes(1);
  });

  it("auto-detects providers from provider-declared env vars", () => {
    const provider = createFirecrawlProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-env-key");

    const resolved = resolveWebFetchDefinition({
      config: {},
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "does-not-exist",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("keeps sandboxed web fetch on bundled providers even when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: true,
      preferRuntimeProviders: true,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("honors preferRuntimeProviders for non-sandboxed web fetch definitions", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(resolved?.provider.id).toBe("thirdparty");
  });

  it("does not reuse bundled prepared fetch definitions for runtime-preferred lookups", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const prepared = prepareWebFetchDefinition({
      config: {},
      preferRuntimeProviders: false,
    });
    const resolved = resolveWebFetchDefinition({
      config: {},
      preferRuntimeProviders: true,
    });

    expect(prepared?.provider.id).toBe("firecrawl");
    expect(resolved?.provider.id).toBe("thirdparty");
  });
});
