import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  listPluginContributionIds: vi.fn(() => ["external-chat"]),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
  listPluginContributionIds: pluginRegistryMocks.listPluginContributionIds,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => {
    throw new Error("channels logs must not load channel plugins");
  }),
}));

import { channelsLogsCommand } from "./channels/logs.js";

const runtime = createTestRuntime();

function logLine(params: { module: string; message: string }) {
  return JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: params.message,
    _meta: {
      logLevelName: "INFO",
      name: JSON.stringify({ module: params.module }),
    },
  });
}

describe("channelsLogsCommand", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channels-logs-"));
    logPath = path.join(tempDir, "openclaw.log");
    setLoggerOverride({ file: logPath });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockClear();
    pluginRegistryMocks.listPluginContributionIds.mockClear();
  });

  afterEach(async () => {
    setLoggerOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters external plugin channel logs from the persisted manifest registry", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ module: "gateway/channels/external-chat/send", message: "external sent" }),
        logLine({ module: "gateway/channels/slack/send", message: "slack sent" }),
      ].join("\n"),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    expect(pluginRegistryMocks.loadPluginRegistrySnapshot).toHaveBeenCalledOnce();
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledWith(
      expect.objectContaining({
        contribution: "channels",
        includeDisabled: true,
      }),
    );
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      channel: string;
      lines: Array<{ message: string }>;
    };
    expect(payload.channel).toBe("external-chat");
    expect(payload.lines.map((line) => line.message)).toEqual(["external sent"]);
  });

  it("falls back to the latest rolling log when the configured rolling log is missing", async () => {
    const older = path.join(tempDir, "openclaw-2026-04-27.log");
    const newer = path.join(tempDir, "openclaw-2026-04-28.log");
    logPath = path.join(tempDir, "openclaw-2026-04-29.log");
    setLoggerOverride({ file: logPath });

    await fs.writeFile(
      older,
      logLine({ module: "gateway/channels/slack/send", message: "older slack sent" }),
    );
    await fs.writeFile(
      newer,
      [
        logLine({ module: "gateway/channels/slack/send", message: "newer slack sent" }),
        logLine({ module: "gateway/channels/telegram/send", message: "telegram sent" }),
      ].join("\n"),
    );
    await fs.utimes(
      older,
      new Date("2026-04-27T00:00:00.000Z"),
      new Date("2026-04-27T00:00:00.000Z"),
    );
    await fs.utimes(
      newer,
      new Date("2026-04-28T00:00:00.000Z"),
      new Date("2026-04-28T00:00:00.000Z"),
    );

    await channelsLogsCommand({ channel: "slack", json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      file: string;
      channel: string;
      lines: Array<{ message: string }>;
    };
    expect(payload.file).toBe(newer);
    expect(payload.channel).toBe("slack");
    expect(payload.lines.map((line) => line.message)).toEqual(["newer slack sent"]);
  });

  it("does not scan rolling files when a custom non-rolling log file is missing", async () => {
    await fs.writeFile(
      path.join(tempDir, "openclaw-2026-04-28.log"),
      logLine({ module: "gateway/channels/slack/send", message: "rolling slack sent" }),
    );

    await channelsLogsCommand({ channel: "slack", json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      file: string;
      channel: string;
      lines: Array<{ message: string }>;
    };
    expect(payload.file).toBe(logPath);
    expect(payload.channel).toBe("slack");
    expect(payload.lines).toEqual([]);
  });
});
