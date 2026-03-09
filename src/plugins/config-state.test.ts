import { describe, expect, it } from "vitest";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
} from "./config-state.js";

function normalizedPlugins(config: Parameters<typeof normalizePluginsConfig>[0]) {
  return normalizePluginsConfig(config);
}

function resolveBundledState(id: string, config: Parameters<typeof normalizePluginsConfig>[0]) {
  return resolveEnableState(id, "bundled", normalizedPlugins(config));
}

function resolveBundledEffectiveState(config: Parameters<typeof normalizePluginsConfig>[0]) {
  return resolveEffectiveEnableState({
    id: "telegram",
    origin: "bundled",
    config: normalizedPlugins(config),
    rootConfig: {
      channels: {
        telegram: {
          enabled: true,
        },
      },
    },
  });
}

describe("normalizePluginsConfig", () => {
  it("uses default memory slot when not specified", () => {
    const result = normalizedPlugins({});
    expect(result.slots.memory).toBe("memory-core");
  });

  it("respects explicit memory slot value", () => {
    const result = normalizedPlugins({
      slots: { memory: "custom-memory" },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("disables memory slot when set to 'none' (case insensitive)", () => {
    expect(
      normalizedPlugins({
        slots: { memory: "none" },
      }).slots.memory,
    ).toBeNull();
    expect(
      normalizedPlugins({
        slots: { memory: "None" },
      }).slots.memory,
    ).toBeNull();
  });

  it("trims whitespace from memory slot value", () => {
    const result = normalizedPlugins({
      slots: { memory: "  custom-memory  " },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("uses default when memory slot is empty string", () => {
    const result = normalizedPlugins({
      slots: { memory: "" },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("uses default when memory slot is whitespace only", () => {
    const result = normalizedPlugins({
      slots: { memory: "   " },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("normalizes plugin hook policy flags", () => {
    const result = normalizedPlugins({
      entries: {
        "voice-call": {
          hooks: {
            allowPromptInjection: false,
          },
        },
      },
    });
    expect(result.entries["voice-call"]?.hooks?.allowPromptInjection).toBe(false);
  });

  it("drops invalid plugin hook policy values", () => {
    const result = normalizedPlugins({
      entries: {
        "voice-call": {
          hooks: {
            allowPromptInjection: "nope",
          } as unknown as { allowPromptInjection: boolean },
        },
      },
    });
    expect(result.entries["voice-call"]?.hooks).toBeUndefined();
  });
});

describe("resolveEffectiveEnableState", () => {
  it("enables bundled channels when channels.<id>.enabled=true", () => {
    const state = resolveBundledEffectiveState({
      enabled: true,
    });
    expect(state).toEqual({ enabled: true });
  });

  it("keeps explicit plugin-level disable authoritative", () => {
    const state = resolveBundledEffectiveState({
      enabled: true,
      entries: {
        telegram: {
          enabled: false,
        },
      },
    });
    expect(state).toEqual({ enabled: false, reason: "disabled in config" });
  });

  it("does not let channel enablement bypass allowlist misses", () => {
    const state = resolveBundledEffectiveState({
      enabled: true,
      allow: ["discord"],
    });
    expect(state).toEqual({ enabled: false, reason: "not in allowlist" });
  });
});

describe("resolveEnableState", () => {
  it("keeps the selected memory slot plugin enabled even when omitted from plugins.allow", () => {
    const state = resolveBundledState("memory-core", {
      allow: ["telegram"],
      slots: { memory: "memory-core" },
    });
    expect(state).toEqual({ enabled: true });
  });

  it("keeps explicit disable authoritative for the selected memory slot plugin", () => {
    const state = resolveBundledState("memory-core", {
      allow: ["telegram"],
      slots: { memory: "memory-core" },
      entries: {
        "memory-core": {
          enabled: false,
        },
      },
    });
    expect(state).toEqual({ enabled: false, reason: "disabled in config" });
  });
});
