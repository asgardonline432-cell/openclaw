import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn<() => "default" | "explicit" | "gateway-bindable">(
    () => "default",
  ),
  isReplyCapableChannelsLive: vi.fn(() => false),
  isReplyRuntimePluginRegistryPrepared: vi.fn(() => false),
  logReplyRuntimeColdPathViolation: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: hoisted.resolveRuntimePluginRegistry,
  resolveCompatibleRuntimePluginRegistry: hoisted.resolveCompatibleRuntimePluginRegistry,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

vi.mock("../gateway/reply-runtime-readiness-monitor.js", () => ({
  isReplyCapableChannelsLive: hoisted.isReplyCapableChannelsLive,
  isReplyRuntimePluginRegistryPrepared: hoisted.isReplyRuntimePluginRegistryPrepared,
  logReplyRuntimeColdPathViolation: hoisted.logReplyRuntimeColdPathViolation,
}));

describe("ensureRuntimePluginsLoaded", () => {
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;

  beforeEach(async () => {
    hoisted.resolveRuntimePluginRegistry.mockReset();
    hoisted.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    hoisted.resolveCompatibleRuntimePluginRegistry.mockReset();
    hoisted.resolveCompatibleRuntimePluginRegistry.mockReturnValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset();
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    hoisted.isReplyCapableChannelsLive.mockReset();
    hoisted.isReplyCapableChannelsLive.mockReturnValue(false);
    hoisted.isReplyRuntimePluginRegistryPrepared.mockReset();
    hoisted.isReplyRuntimePluginRegistryPrepared.mockReturnValue(false);
    hoisted.logReplyRuntimeColdPathViolation.mockReset();
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js"));
  });

  it("does not reactivate plugins when a process already has an active registry", async () => {
    hoisted.resolveRuntimePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("returns early when readiness already prepared a compatible registry", async () => {
    hoisted.isReplyRuntimePluginRegistryPrepared.mockReturnValue(true);
    hoisted.resolveCompatibleRuntimePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveCompatibleRuntimePluginRegistry).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("returns early when a compatible registry is already active even before readiness marks it", async () => {
    hoisted.resolveCompatibleRuntimePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      source: "runtime-plugins.test",
    });

    expect(hoisted.resolveCompatibleRuntimePluginRegistry).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
    expect(hoisted.logReplyRuntimeColdPathViolation).not.toHaveBeenCalled();
  });

  it("resolves runtime plugins through the shared runtime helper", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("does not enable gateway subagent binding for normal runtime loads", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: undefined,
    });
  });

  it("inherits gateway-bindable mode from an active gateway registry", async () => {
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("logs a readiness violation when runtime plugins cold-load after channels are live", async () => {
    hoisted.isReplyCapableChannelsLive.mockReturnValue(true);

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      source: "runtime-plugins.test",
    });

    expect(hoisted.logReplyRuntimeColdPathViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "runtime-plugin-registry",
        source: "runtime-plugins.test",
      }),
    );
  });
});
