import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import { initSessionState } from "./session.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeReset: vi.fn(),
  runSessionEnd: vi.fn(),
  runSessionStart: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMocks,
}));

vi.mock("../../agents/harness/registry.js", () => ({
  resetRegisteredAgentHarnessSessions: vi.fn(async () => undefined),
}));

vi.mock("../../agents/pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: vi.fn(async () => undefined),
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

type ResetConfig = NonNullable<NonNullable<OpenClawConfig["session"]>["reset"]>;

describe("initSessionState stale reset hooks", () => {
  let roots: string[] = [];
  let internalEvents: InternalHookEvent[] = [];

  beforeEach(() => {
    roots = [];
    internalEvents = [];
    clearInternalHooks();
    registerInternalHook("command:reset", async (event) => {
      internalEvents.push({
        ...event,
        context: { ...event.context },
        messages: [...event.messages],
      });
    });
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName: string) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearInternalHooks();
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function createStoredSession(params: {
    reset: ResetConfig;
    updatedAt: number;
    sessionStartedAt?: number;
    lastInteractionAt?: number;
  }): Promise<{ cfg: OpenClawConfig; sessionFile: string; storePath: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-hooks-"));
    roots.push(root);
    const storePath = path.join(root, "sessions.json");
    const sessionFile = path.join(root, "old-session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Please remember the rollover context" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Saved before lazy reset" },
        }),
      ].join("\n"),
      "utf8",
    );

    const entry: SessionEntry = {
      sessionId: "old-session",
      sessionFile,
      updatedAt: params.updatedAt,
      systemSent: true,
      ...(params.sessionStartedAt ? { sessionStartedAt: params.sessionStartedAt } : {}),
      ...(params.lastInteractionAt ? { lastInteractionAt: params.lastInteractionAt } : {}),
    };
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "main:user123": entry,
      }),
      "utf8",
    );

    return {
      storePath,
      sessionFile,
      cfg: {
        agents: {
          defaults: { workspace: root },
          list: [{ id: "main", workspace: root }],
        },
        session: {
          store: storePath,
          reset: params.reset,
        },
        channels: {},
        plugins: { entries: {} },
      } as OpenClawConfig,
    };
  }

  async function initUserSession(cfg: OpenClawConfig) {
    return await initSessionState({
      ctx: {
        Body: "hello after idle",
        From: "user123",
        To: "bot123",
        SessionKey: "main:user123",
        Provider: "quietchat",
        Surface: "quietchat",
        ChatType: "direct",
      },
      cfg,
      commandAuthorized: true,
    });
  }

  it("emits command reset and before_reset hooks for daily lazy rollovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const staleAt = new Date(2026, 0, 18, 3, 0, 0).getTime();
    const freshUpdatedAt = new Date(2026, 0, 18, 4, 50, 0).getTime();
    const { cfg, sessionFile } = await createStoredSession({
      updatedAt: freshUpdatedAt,
      sessionStartedAt: staleAt,
      lastInteractionAt: staleAt,
      reset: { mode: "daily", atHour: 4 },
    });

    const result = await initUserSession(cfg);

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(internalEvents).toHaveLength(1);
    expect(internalEvents[0]).toMatchObject({
      type: "command",
      action: "reset",
      sessionKey: "main:user123",
      context: {
        commandSource: "session:daily",
        resetReason: "daily",
        workspaceDir: path.dirname(sessionFile),
      },
    });
    expect(internalEvents[0]?.context.previousSessionEntry).toMatchObject({
      sessionId: "old-session",
      sessionFile: expect.stringContaining(".jsonl.reset."),
    });
    expect(internalEvents[0]?.context.sessionEntry).toMatchObject({
      sessionId: result.sessionId,
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledWith(
      {
        sessionFile: expect.stringContaining(".jsonl.reset."),
        messages: [
          { role: "user", content: "Please remember the rollover context" },
          { role: "assistant", content: "Saved before lazy reset" },
        ],
        reason: "daily",
      },
      expect.objectContaining({
        sessionKey: "main:user123",
        sessionId: "old-session",
        workspaceDir: path.dirname(sessionFile),
      }),
    );
  });

  it("emits command reset and before_reset hooks for idle lazy rollovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const staleAt = new Date(2026, 0, 18, 4, 0, 0).getTime();
    const { cfg } = await createStoredSession({
      updatedAt: staleAt,
      sessionStartedAt: staleAt,
      lastInteractionAt: staleAt,
      reset: { mode: "idle", idleMinutes: 30 },
    });

    await initUserSession(cfg);

    expect(internalEvents).toHaveLength(1);
    expect(internalEvents[0]).toMatchObject({
      type: "command",
      action: "reset",
      context: {
        commandSource: "session:idle",
        resetReason: "idle",
      },
    });
    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(hookRunnerMocks.runBeforeReset.mock.calls[0]?.[0]).toMatchObject({
      reason: "idle",
    });
  });

  it("leaves explicit reset command hook emission to the command pipeline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const staleAt = new Date(2026, 0, 18, 4, 55, 0).getTime();
    const { cfg } = await createStoredSession({
      updatedAt: staleAt,
      sessionStartedAt: staleAt,
      lastInteractionAt: staleAt,
      reset: { mode: "idle", idleMinutes: 30 },
    });

    await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user123",
        To: "bot123",
        SessionKey: "main:user123",
        Provider: "quietchat",
        Surface: "quietchat",
        ChatType: "direct",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(internalEvents).toHaveLength(0);
    expect(hookRunnerMocks.runBeforeReset).not.toHaveBeenCalled();
  });
});
