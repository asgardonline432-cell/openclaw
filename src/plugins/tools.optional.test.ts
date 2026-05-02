import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  source: string;
  names: string[];
  declaredNames?: string[];
  factory: (ctx: unknown) => unknown;
};

const loadOpenClawPluginsMock = vi.fn();
const resolveRuntimePluginRegistryMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: (params: unknown) => resolveRuntimePluginRegistryMock(params),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: unknown) => applyPluginAutoEnableMock(params),
}));

let resolvePluginTools: typeof import("./tools.js").resolvePluginTools;
let buildPluginToolMetadataKey: typeof import("./tools.js").buildPluginToolMetadataKey;
let pinActivePluginChannelRegistry: typeof import("./runtime.js").pinActivePluginChannelRegistry;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;
let clearCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata-snapshot.js").clearCurrentPluginMetadataSnapshot;
let setCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata-snapshot.js").setCurrentPluginMetadataSnapshot;

function makeTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function createContext() {
  return {
    config: {
      plugins: {
        enabled: true,
        allow: ["optional-demo", "message", "multi"],
        load: { paths: ["/tmp/plugin.js"] },
        slots: { memory: "none" },
      },
    },
    workspaceDir: "/tmp",
  };
}

function createResolveToolsParams(params?: {
  context?: ReturnType<typeof createContext> & Record<string, unknown>;
  toolAllowlist?: readonly string[];
  existingToolNames?: Set<string>;
  env?: NodeJS.ProcessEnv;
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
}) {
  return {
    context: (params?.context ?? createContext()) as never,
    ...(params?.toolAllowlist ? { toolAllowlist: [...params.toolAllowlist] } : {}),
    ...(params?.existingToolNames ? { existingToolNames: params.existingToolNames } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    ...(params?.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
}

function setRegistry(entries: MockRegistryToolEntry[], options?: { env?: NodeJS.ProcessEnv }) {
  const registry = {
    tools: entries,
    diagnostics: [] as Array<{
      level: string;
      pluginId: string;
      source: string;
      message: string;
    }>,
  };
  loadOpenClawPluginsMock.mockReturnValue(registry);
  installToolManifestSnapshots({
    config: createContext().config,
    env: options?.env,
    plugins: entries
      .map((entry) => ({
        id: entry.pluginId,
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: entry.declaredNames ?? entry.names,
        },
      }))
      .filter((plugin) => plugin.contracts.tools.length > 0),
  });
  return registry;
}

function setMultiToolRegistry() {
  return setRegistry([
    {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      names: ["message", "other_tool"],
      factory: () => [makeTool("message"), makeTool("other_tool")],
    },
  ]);
}

function createOptionalDemoEntry(): MockRegistryToolEntry {
  return {
    pluginId: "optional-demo",
    names: ["optional_tool"],
    optional: true,
    source: "/tmp/optional-demo.js",
    factory: () => makeTool("optional_tool"),
  };
}

function createMalformedTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "bad" }] };
    },
  };
}

function installConsoleMethodSpy(method: "log" | "warn") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: vi.fn(),
  };
  return spy;
}

function resolveWithConflictingCoreName(options?: { suppressNameConflicts?: boolean }) {
  return resolvePluginTools(
    createResolveToolsParams({
      existingToolNames: new Set(["message"]),
      ...(options?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    }),
  );
}

function setOptionalDemoRegistry(options?: { env?: NodeJS.ProcessEnv }) {
  setRegistry([createOptionalDemoEntry()], options);
}

function resolveOptionalDemoTools(toolAllowlist?: readonly string[]) {
  return resolvePluginTools(createResolveToolsParams({ toolAllowlist }));
}

function createAutoEnabledOptionalContext() {
  const rawContext = createContext();
  const autoEnabledConfig = {
    ...rawContext.config,
    plugins: {
      ...rawContext.config.plugins,
      entries: {
        "optional-demo": { enabled: true },
      },
    },
  };
  return { rawContext, autoEnabledConfig };
}

function expectAutoEnabledOptionalLoad(autoEnabledConfig: unknown) {
  expectLoaderCall({ config: autoEnabledConfig });
}

function resolveAutoEnabledOptionalDemoTools() {
  setOptionalDemoRegistry();
  const { rawContext, autoEnabledConfig } = createAutoEnabledOptionalContext();
  installToolManifestSnapshot({
    config: autoEnabledConfig,
    plugin: {
      id: "optional-demo",
      origin: "bundled",
      enabledByDefault: true,
      channels: [],
      providers: [],
      contracts: {
        tools: ["optional_tool"],
      },
    },
  });
  applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });

  const tools = resolvePluginTools({
    context: {
      ...rawContext,
      config: rawContext.config as never,
    } as never,
    toolAllowlist: ["optional_tool"],
  });

  return { rawContext, autoEnabledConfig, tools };
}

function createOptionalDemoActiveRegistry() {
  installToolManifestSnapshot({
    config: createContext().config,
    plugin: {
      id: "optional-demo",
      origin: "bundled",
      enabledByDefault: true,
      channels: [],
      providers: [],
      contracts: {
        tools: ["optional_tool"],
      },
    },
  });
  return {
    plugins: [{ id: "optional-demo", status: "loaded" }],
    tools: [createOptionalDemoEntry()],
    diagnostics: [],
  };
}

function installToolManifestSnapshot(params: {
  config: ReturnType<typeof createContext>["config"];
  env?: NodeJS.ProcessEnv;
  plugin: Record<string, unknown>;
}) {
  installToolManifestSnapshots({
    config: params.config,
    env: params.env,
    plugins: [params.plugin],
  });
}

function installToolManifestSnapshots(params: {
  config: ReturnType<typeof createContext>["config"];
  env?: NodeJS.ProcessEnv;
  plugins: Record<string, unknown>[];
}) {
  const plugins = params.plugins;
  setCurrentPluginMetadataSnapshot(
    {
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      workspaceDir: "/tmp",
      index: {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs: 0,
        installRecords: {},
        plugins: [],
        diagnostics: [],
      },
      registryDiagnostics: [],
      manifestRegistry: { plugins, diagnostics: [] },
      plugins,
      diagnostics: [],
      byPluginId: new Map(plugins.map((plugin) => [String(plugin.id), plugin])),
      normalizePluginId: (id: string) => id,
      owners: {
        channels: new Map(),
        channelConfigs: new Map(),
        providers: new Map(),
        modelCatalogProviders: new Map(),
        cliBackends: new Map(),
        setupProviders: new Map(),
        commandAliases: new Map(),
        contracts: new Map(),
      },
      metrics: {
        registrySnapshotMs: 0,
        manifestRegistryMs: 0,
        ownerMapsMs: 0,
        totalMs: 0,
        indexPluginCount: 0,
        manifestPluginCount: plugins.length,
      },
    } as never,
    { config: params.config, env: params.env ?? process.env, workspaceDir: "/tmp" },
  );
}

function createXaiToolManifest(
  params: { descriptor?: boolean; includeCodeExecution?: boolean } = {},
) {
  return {
    id: "xai",
    origin: "bundled",
    enabledByDefault: true,
    channels: [],
    providers: ["xai"],
    providerAuthEnvVars: {
      xai: ["XAI_API_KEY"],
    },
    contracts: {
      tools: params.includeCodeExecution ? ["code_execution", "x_search"] : ["x_search"],
    },
    toolMetadata: {
      ...(params.includeCodeExecution
        ? {
            code_execution: {
              ...(params.descriptor
                ? {
                    descriptor: {
                      title: "Code Execution",
                      description: "Run code with xAI.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          task: {
                            type: "string",
                          },
                        },
                        required: ["task"],
                      },
                      availability: {
                        kind: "config",
                        path: ["plugins", "entries", "xai", "config", "codeExecution", "enabled"],
                        default: true,
                        notEquals: false,
                      },
                    },
                  }
                : {}),
              authSignals: [{ provider: "xai" }],
              configSignals: [
                {
                  rootPath: "plugins.entries.xai.config",
                  overlayPath: "webSearch",
                  required: ["apiKey"],
                },
              ],
            },
          }
        : {}),
      x_search: {
        ...(params.descriptor
          ? {
              descriptor: {
                title: "X Search",
                description: "Search X with xAI.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                    },
                  },
                  required: ["query"],
                },
                availability: {
                  kind: "config",
                  paths: [
                    ["plugins", "entries", "xai", "config", "xSearch", "enabled"],
                    ["tools", "web", "x_search", "enabled"],
                  ],
                  default: true,
                  notEquals: false,
                },
              },
            }
          : {}),
        authSignals: [{ provider: "xai" }],
        configSignals: [
          {
            rootPath: "plugins.entries.xai.config",
            overlayPath: "webSearch",
            required: ["apiKey"],
          },
        ],
      },
    },
  };
}

function createDescriptorOnlyToolManifest() {
  return {
    id: "descriptor-only",
    origin: "bundled",
    enabledByDefault: true,
    channels: [],
    providers: [],
    contracts: {
      tools: ["descriptor_tool"],
    },
    toolMetadata: {
      descriptor_tool: {
        descriptor: {
          title: "Descriptor Tool",
          description: "Run a descriptor-backed tool.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
            },
            required: ["query"],
          },
        },
      },
    },
  };
}

function createMemoryCoreToolManifest() {
  const availability = {
    allOf: [
      { kind: "plugin-enabled", pluginId: "memory-core" },
      { kind: "context", key: "agent.memorySearch.enabled", equals: true },
    ],
  };
  return {
    id: "memory-core",
    origin: "bundled",
    enabledByDefault: true,
    kind: "memory",
    channels: [],
    providers: [],
    contracts: {
      tools: ["memory_search", "memory_get"],
    },
    toolMetadata: {
      memory_search: {
        descriptor: {
          title: "Memory Search",
          description: "Search memory.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
          availability,
          sortKey: "memory:01:search",
        },
      },
      memory_get: {
        descriptor: {
          title: "Memory Get",
          description: "Read memory.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
          availability,
          sortKey: "memory:02:get",
        },
      },
    },
  };
}

function expectResolvedToolNames(
  tools: ReturnType<typeof resolvePluginTools>,
  expectedToolNames: readonly string[],
) {
  expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
}

function expectLoaderCall(overrides: Record<string, unknown>) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(expect.objectContaining(overrides));
}

function expectSingleDiagnosticMessage(
  diagnostics: Array<{ message: string }>,
  messageFragment: string,
) {
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.message).toContain(messageFragment);
}

function expectConflictingCoreNameResolution(params: {
  suppressNameConflicts?: boolean;
  expectedDiagnosticFragment?: string;
}) {
  const registry = setMultiToolRegistry();
  const tools = resolveWithConflictingCoreName({
    suppressNameConflicts: params.suppressNameConflicts,
  });

  expectResolvedToolNames(tools, ["other_tool"]);
  if (params.expectedDiagnosticFragment) {
    expectSingleDiagnosticMessage(registry.diagnostics, params.expectedDiagnosticFragment);
    return;
  }
  expect(registry.diagnostics).toHaveLength(0);
}

describe("resolvePluginTools optional tools", () => {
  beforeAll(async () => {
    ({ buildPluginToolMetadataKey, resolvePluginTools } = await import("./tools.js"));
    ({ pinActivePluginChannelRegistry, resetPluginRuntimeStateForTest, setActivePluginRegistry } =
      await import("./runtime.js"));
    ({ clearCurrentPluginMetadataSnapshot, setCurrentPluginMetadataSnapshot } =
      await import("./current-plugin-metadata-snapshot.js"));
  });

  beforeEach(() => {
    loadOpenClawPluginsMock.mockClear();
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockImplementation((params) =>
      loadOpenClawPluginsMock(params),
    );
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation(({ config }: { config: unknown }) => ({
      config,
      changes: [],
    }));
    resetPluginRuntimeStateForTest?.();
    clearCurrentPluginMetadataSnapshot?.();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest?.();
    clearCurrentPluginMetadataSnapshot?.();
    setLoggerOverride(null);
    loggingState.rawConsole = null;
    resetLogger();
    vi.useRealTimers();
  });

  it("does not load plugin-owned tools whose manifest metadata has no available signal", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    loadOpenClawPluginsMock.mockImplementation((params) =>
      Array.isArray((params as { onlyPluginIds?: string[] }).onlyPluginIds) &&
      (params as { onlyPluginIds?: string[] }).onlyPluginIds?.length === 0
        ? { tools: [], diagnostics: [] }
        : {
            tools: [
              {
                pluginId: "xai",
                optional: false,
                source: "/tmp/xai.js",
                names: ["x_search"],
                factory,
              },
            ],
            diagnostics: [],
          },
    );

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {},
    });

    expect(tools).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not reuse a pinned gateway registry for manifest-unavailable tools", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    pinActivePluginChannelRegistry({
      plugins: [{ id: "xai", status: "loaded" }],
      tools: [
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["x_search"],
          factory,
        },
      ],
      diagnostics: [],
    } as never);
    loadOpenClawPluginsMock.mockReturnValue({ tools: [], diagnostics: [] });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {},
      allowGatewaySubagentBinding: true,
    });

    expect(tools).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("plans descriptor-backed plugin tools without runtime loading and loads execution on demand", async () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: { XAI_API_KEY: "test-key" },
      plugin: createXaiToolManifest({ descriptor: true }),
    });
    const factory = vi.fn(() => ({
      ...makeTool("x_search"),
      async execute() {
        return { content: [{ type: "text", text: "runtime-ok" }] };
      },
    }));
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["x_search"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {
        XAI_API_KEY: "test-key",
      },
    });

    expectResolvedToolNames(tools, ["x_search"]);
    expect(tools[0]?.description).toBe("Search X with xAI.");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();

    const result = await tools[0]?.execute("tool-call", { query: "openclaw" });

    expect(result?.content).toEqual([{ type: "text", text: "runtime-ok" }]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["xai"],
      }),
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not expose descriptor-backed xAI tools when their config disables them", () => {
    const context = createContext();
    const config = {
      ...context.config,
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: { apiKey: "test-key" },
              codeExecution: { enabled: false },
              xSearch: { enabled: false },
            },
          },
        },
      },
    };
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest({ descriptor: true, includeCodeExecution: true }),
    });
    const factory = vi.fn(() => [makeTool("code_execution"), makeTool("x_search")]);
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["code_execution", "x_search"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...context,
        config,
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, []);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses plugin-owned xAI search enablement before legacy config", () => {
    const context = createContext();
    const config = {
      ...context.config,
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: { apiKey: "test-key" },
              xSearch: { enabled: true },
            },
          },
        },
      },
      tools: {
        web: {
          x_search: {
            enabled: false,
          },
        },
      },
    };
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest({ descriptor: true }),
    });

    const tools = resolvePluginTools({
      context: {
        ...context,
        config,
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, ["x_search"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("plans descriptor-only plugin tools without runtime loading", async () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createDescriptorOnlyToolManifest(),
    });
    const factory = vi.fn(() => ({
      ...makeTool("descriptor_tool"),
      async execute() {
        return { content: [{ type: "text", text: "descriptor-runtime-ok" }] };
      },
    }));
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "descriptor-only",
          optional: false,
          source: "/tmp/descriptor-only.js",
          names: ["descriptor_tool"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      toolAllowlist: ["descriptor_tool"],
      env: {},
    });

    expectResolvedToolNames(tools, ["descriptor_tool"]);
    expect(tools[0]?.description).toBe("Run a descriptor-backed tool.");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();

    const result = await tools[0]?.execute("tool-call", { query: "openclaw" });

    expect(result?.content).toEqual([{ type: "text", text: "descriptor-runtime-ok" }]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["descriptor-only"],
      }),
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("evaluates descriptor auth and available config signals during plugin planning", () => {
    const context = createContext();
    const config = {
      ...context.config,
      plugins: {
        entries: {
          "descriptor-only": {
            config: {
              apiKey: { source: "env", provider: "default", id: "DESCRIPTOR_API_KEY" },
            },
          },
        },
      },
    };
    installToolManifestSnapshot({
      config,
      env: { DESCRIPTOR_API_KEY: "test-key" },
      plugin: {
        ...createDescriptorOnlyToolManifest(),
        toolMetadata: {
          descriptor_tool: {
            descriptor: {
              title: "Descriptor Tool",
              description: "Run a descriptor-backed tool.",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                  },
                },
                required: ["query"],
              },
              availability: {
                allOf: [
                  { kind: "auth", providerId: "descriptor" },
                  {
                    kind: "config",
                    path: ["plugins", "entries", "descriptor-only", "config", "apiKey"],
                    check: "available",
                  },
                ],
              },
            },
          },
        },
      },
    });

    const tools = resolvePluginTools({
      context: {
        ...context,
        config,
      } as never,
      env: { DESCRIPTOR_API_KEY: "test-key" },
      hasAuthForProvider: (providerId) => providerId === "descriptor",
    });

    expectResolvedToolNames(tools, ["descriptor_tool"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("plans memory tools from request facts without runtime loading", async () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createMemoryCoreToolManifest(),
    });
    const factory = vi.fn(() => [
      {
        ...makeTool("memory_search"),
        async execute() {
          return { content: [{ type: "text", text: "memory-search-ok" }] };
        },
      },
      makeTool("memory_get"),
    ]);
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "memory-core",
          optional: false,
          source: "/tmp/memory-core.js",
          names: ["memory_search", "memory_get"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
        agentId: "main",
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, ["memory_search", "memory_get"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();

    const result = await tools[0]?.execute("tool-call", { query: "openclaw" });

    expect(result?.content).toEqual([{ type: "text", text: "memory-search-ok" }]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["memory-core"],
      }),
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not leak descriptor-backed memory tools when the active agent disables memory", () => {
    const base = createContext();
    const config = {
      ...base.config,
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
        list: [
          {
            id: "main",
            memorySearch: {
              enabled: false,
            },
          },
        ],
      },
    } as const;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createMemoryCoreToolManifest(),
    });
    const factory = vi.fn(() => [makeTool("memory_search"), makeTool("memory_get")]);
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "memory-core",
          optional: false,
          source: "/tmp/memory-core.js",
          names: ["memory_search", "memory_get"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...base,
        config,
        agentId: "main",
      } as never,
      env: {},
    });

    expect(tools).toEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not expose descriptor-hidden tools through a partial runtime fallback", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: {
        id: "partial-owner",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: ["hidden_descriptor_tool", "runtime_tool"],
        },
        toolMetadata: {
          hidden_descriptor_tool: {
            descriptor: {
              description: "Hidden by request facts.",
              inputSchema: {
                type: "object",
                properties: {},
              },
              availability: {
                allOf: [
                  {
                    kind: "context",
                    key: "agent.partial.enabled",
                    equals: true,
                  },
                ],
              },
            },
          },
        },
      },
    });
    const factory = vi.fn(() => [makeTool("hidden_descriptor_tool"), makeTool("runtime_tool")]);
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "partial-owner",
          optional: false,
          source: "/tmp/partial-owner.js",
          names: ["hidden_descriptor_tool", "runtime_tool"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, ["runtime_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("honors agent memory overrides when planning descriptor-backed memory tools", () => {
    const base = createContext();
    const config = {
      ...base.config,
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
          },
        },
        list: [
          {
            id: "research",
            memorySearch: {
              enabled: true,
            },
          },
        ],
      },
    } as const;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createMemoryCoreToolManifest(),
    });
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "memory-core",
          optional: false,
          source: "/tmp/memory-core.js",
          names: ["memory_search", "memory_get"],
          factory: () => [makeTool("memory_search"), makeTool("memory_get")],
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...base,
        config,
        agentId: "research",
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, ["memory_search", "memory_get"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin-owned tools when manifest tool metadata has env auth evidence", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: { XAI_API_KEY: "test-key" },
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["x_search"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {
        XAI_API_KEY: "test-key",
      },
    });

    expectResolvedToolNames(tools, ["x_search"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["xai"],
      }),
    );
  });

  it("loads plugin-owned tools when manifest config signals point at configured non-env SecretRefs", () => {
    const base = createContext();
    const config = {
      ...base.config,
      plugins: {
        ...base.config.plugins,
        entries: {
          xai: {
            config: {
              webSearch: {
                apiKey: {
                  source: "file",
                  provider: "vault",
                  id: "/xai/tool-key",
                },
              },
            },
          },
        },
      },
      secrets: {
        providers: {
          vault: {
            source: "file",
            path: "/tmp/openclaw-secrets.json",
            mode: "json",
          },
        },
      },
    } as const;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    loadOpenClawPluginsMock.mockReturnValue({
      tools: [
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["x_search"],
          factory,
        },
      ],
      diagnostics: [],
    });

    const tools = resolvePluginTools({
      context: {
        ...base,
        config,
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, ["x_search"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["xai"],
      }),
    );
  });

  it("skips optional tools without explicit allowlist", () => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools();

    expect(tools).toHaveLength(0);
  });

  it("does not invoke named optional tool factories without a matching allowlist", () => {
    const factory = vi.fn(() => makeTool("optional_tool"));
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        names: ["optional_tool"],
        factory,
      },
    ]);

    expect(resolveOptionalDemoTools()).toHaveLength(0);
    expect(resolveOptionalDemoTools(["other_tool"])).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("invokes unnamed optional tool factories when a tool allowlist may match the result", () => {
    const factory = vi.fn(() => makeTool("optional_tool"));
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        names: [],
        declaredNames: ["optional_tool"],
        factory,
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "allows optional tools by tool name",
      toolAllowlist: ["optional_tool"],
    },
    {
      name: "allows optional tools via plugin id",
      toolAllowlist: ["optional-demo"],
    },
    {
      name: "allows optional tools via plugin-scoped allowlist entries",
      toolAllowlist: ["optional_tool", "tavily"],
    },
  ] as const)("$name", ({ toolAllowlist }) => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools(toolAllowlist);

    expectResolvedToolNames(tools, ["optional_tool"]);
  });

  it("rejects plugin id collisions with core tool names", () => {
    const registry = setRegistry([
      {
        pluginId: "message",
        optional: false,
        source: "/tmp/message.js",
        names: ["optional_tool"],
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        existingToolNames: new Set(["message"]),
      }),
    );

    expect(tools).toHaveLength(0);
    expectSingleDiagnosticMessage(registry.diagnostics, "plugin id conflicts with core tool name");
  });

  it.each([
    {
      name: "skips conflicting tool names but keeps other tools",
      expectedDiagnosticFragment: "plugin tool name conflict",
    },
    {
      name: "suppresses conflict diagnostics when requested",
      suppressNameConflicts: true,
    },
  ] as const)("$name", ({ suppressNameConflicts, expectedDiagnosticFragment }) => {
    expectConflictingCoreNameResolution({
      suppressNameConflicts,
      expectedDiagnosticFragment,
    });
  });

  it.each([
    {
      name: "forwards an explicit env to plugin loading",
      params: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
        toolAllowlist: ["optional_tool"],
      },
      expectedLoaderCall: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" },
      },
    },
    {
      name: "forwards gateway subagent binding to plugin runtime options",
      params: {
        allowGatewaySubagentBinding: true,
        toolAllowlist: ["optional_tool"],
      },
      expectedLoaderCall: {
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    },
  ])("$name", ({ params, expectedLoaderCall }) => {
    setOptionalDemoRegistry({ env: params.env });

    resolvePluginTools(createResolveToolsParams(params));

    expectLoaderCall(expectedLoaderCall);
  });

  it("skips malformed plugin tools while keeping valid sibling tools", () => {
    const registry = setRegistry([
      {
        pluginId: "schema-bug",
        optional: false,
        source: "/tmp/schema-bug.js",
        names: ["broken_tool", "valid_tool"],
        factory: () => [createMalformedTool("broken_tool"), makeTool("valid_tool")],
      },
    ]);

    const tools = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(tools, ["valid_tool"]);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool is malformed (schema-bug): broken_tool missing parameters object",
    );
  });

  it("warns with plugin factory timing details when a factory is slow", () => {
    vi.useFakeTimers({ now: 0 });
    const warnSpy = installConsoleMethodSpy("warn");
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    setRegistry([
      {
        pluginId: "optional-demo",
        names: ["optional_tool"],
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => {
          vi.advanceTimersByTime(1200);
          return makeTool("optional_tool");
        },
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("[trace:plugin-tools] factory timings");
    expect(message).toContain("totalMs=1200");
    expect(message).toContain("optional-demo:1200ms@1200ms");
    expect(message).toContain("names=[optional_tool]");
    expect(message).toContain("result=single");
    expect(message).toContain("count=1");
  });

  it("emits trace factory timings below the warn threshold when trace logging is enabled", () => {
    vi.useFakeTimers({ now: 0 });
    const logSpy = installConsoleMethodSpy("log");
    setLoggerOverride({ level: "silent", consoleLevel: "trace" });
    setRegistry([
      {
        pluginId: "optional-demo",
        names: ["optional_tool"],
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => {
          vi.advanceTimersByTime(5);
          return makeTool("optional_tool");
        },
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("[trace:plugin-tools] factory timings");
    expect(message).toContain("totalMs=5");
    expect(message).toContain("optional-demo:5ms@5ms");
  });

  it("does not log plugin factory timings for fast factories without trace logging", () => {
    vi.useFakeTimers({ now: 0 });
    const warnSpy = installConsoleMethodSpy("warn");
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    setRegistry([
      {
        pluginId: "optional-demo",
        names: ["optional_tool"],
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => {
          vi.advanceTimersByTime(5);
          return makeTool("optional_tool");
        },
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips factory-returned tools outside the manifest tool contract", () => {
    const registry = setRegistry([
      {
        pluginId: "dynamic-owner",
        optional: false,
        source: "/tmp/dynamic-owner.js",
        names: ["declared_tool"],
        declaredNames: ["declared_tool"],
        factory: () => [makeTool("declared_tool"), makeTool("rogue_tool")],
      },
    ]);

    const tools = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(tools, ["declared_tool"]);
    expectSingleDiagnosticMessage(registry.diagnostics, "plugin tool is undeclared");
  });

  it("skips allowlisted optional malformed plugin tools", () => {
    const registry = setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        names: ["optional_tool"],
        factory: () => createMalformedTool("optional_tool"),
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expect(tools).toHaveLength(0);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool is malformed (optional-demo): optional_tool missing parameters object",
    );
  });

  it.each([
    {
      name: "loads plugin tools from the auto-enabled config snapshot",
      expectedToolNames: undefined,
    },
    {
      name: "does not reuse a cached active registry when auto-enable changes the config snapshot",
      expectedToolNames: ["optional_tool"],
    },
  ] as const)("$name", ({ expectedToolNames }) => {
    const { rawContext, autoEnabledConfig, tools } = resolveAutoEnabledOptionalDemoTools();

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: rawContext.config.plugins?.allow,
            load: rawContext.config.plugins?.load,
          }),
        }),
        env: process.env,
      }),
    );
    if (expectedToolNames) {
      expectResolvedToolNames(tools, expectedToolNames);
    }
    expectAutoEnabledOptionalLoad(autoEnabledConfig);
  });

  it("reuses a compatible active registry instead of loading again", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses the gateway-bindable registry when it covers the tool runtime scope", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable");
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not widen active registry reuse to non-matching plugin tool owners", () => {
    installToolManifestSnapshot({
      config: createContext().config,
      plugin: {
        id: "optional-demo",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: ["optional_tool"],
        },
      },
    });
    const heavyFactory = vi.fn(() => makeTool("heavy_tool"));
    const activeRegistry = {
      plugins: [
        { id: "optional-demo", status: "loaded" },
        { id: "heavy-startup", status: "loaded" },
      ],
      tools: [
        createOptionalDemoEntry(),
        {
          pluginId: "heavy-startup",
          optional: false,
          source: "/tmp/heavy-startup.js",
          names: ["heavy_tool"],
          factory: heavyFactory,
        },
      ],
      diagnostics: [],
    };
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable");
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(heavyFactory).not.toHaveBeenCalled();
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("adds enabled non-startup tool plugins to the active tool runtime scope", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable");
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);

    resolvePluginTools({
      context: {
        ...createContext(),
        config: {
          plugins: {
            enabled: true,
            allow: ["tavily"],
            entries: {
              tavily: { enabled: true },
            },
          },
        },
      } as never,
      toolAllowlist: ["optional_tool", "tavily"],
      allowGatewaySubagentBinding: true,
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["tavily"],
      }),
    );
  });

  it("reuses the pinned gateway channel registry after provider runtime loads replace active registry", () => {
    const gatewayRegistry = createOptionalDemoActiveRegistry();
    pinActivePluginChannelRegistry(gatewayRegistry as never);
    setActivePluginRegistry(
      {
        tools: [],
        diagnostics: [],
      } as never,
      "provider-runtime",
      "default",
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses the pinned gateway channel registry even when the caller omits gateway binding", () => {
    const gatewayRegistry = createOptionalDemoActiveRegistry();
    pinActivePluginChannelRegistry(gatewayRegistry as never);
    setActivePluginRegistry(
      {
        tools: [],
        diagnostics: [],
      } as never,
      "provider-runtime",
      "default",
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin tools when gateway-bindable tool loads have no active registry", () => {
    setOptionalDemoRegistry();

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expectLoaderCall({
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("reloads when gateway binding would otherwise reuse a default-mode active registry", () => {
    setActivePluginRegistry(
      {
        tools: [],
        diagnostics: [],
      } as never,
      "default-registry",
      "default",
    );
    setOptionalDemoRegistry();

    resolvePluginTools({
      context: createContext() as never,
      allowGatewaySubagentBinding: true,
      toolAllowlist: ["optional_tool"],
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    );
  });
});

describe("buildPluginToolMetadataKey", () => {
  beforeAll(async () => {
    ({ buildPluginToolMetadataKey } = await import("./tools.js"));
  });

  it("does not collide when ids or names contain separator-like characters", () => {
    expect(buildPluginToolMetadataKey("plugin", "a\uE000b")).not.toBe(
      buildPluginToolMetadataKey("plugin\uE000a", "b"),
    );
    expect(buildPluginToolMetadataKey("plugin", "a\u0000b")).not.toBe(
      buildPluginToolMetadataKey("plugin\u0000a", "b"),
    );
  });
});
