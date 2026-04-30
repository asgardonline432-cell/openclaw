import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
  startCodexConversationThread,
} from "./conversation-binding.js";

const { getSharedCodexAppServerClientMock, requestMock, resolveDefaultAuthProfileIdMock } =
  vi.hoisted(() => ({
    getSharedCodexAppServerClientMock: vi.fn(),
    requestMock: vi.fn(),
    resolveDefaultAuthProfileIdMock: vi.fn(),
  }));

vi.mock("./app-server/shared-client.js", () => ({
  getSharedCodexAppServerClient: getSharedCodexAppServerClientMock,
}));

vi.mock("./app-server/auth-bridge.js", () => ({
  resolveDefaultCodexAppServerAuthProfileId: resolveDefaultAuthProfileIdMock,
}));

let tempDir: string;

describe("codex conversation binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: { id: "thread-new", cwd: tempDir },
          model: "gpt-5.4-codex",
          modelProvider: "openai",
        };
      }
      if (method === "thread/resume") {
        return {
          thread: { id: "thread-existing", cwd: tempDir },
          model: "gpt-5.4-codex",
          modelProvider: "openai",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue({
      request: requestMock,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clears the Codex app-server sidecar when a pending bind is denied", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sidecar = `${sessionFile}.codex-app-server.json`;
    await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 1, threadId: "thread-1" }));

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    await expect(fs.stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("consumes inbound bound messages when command authorization is absent", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile: path.join(tempDir, "session.jsonl"),
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(result).toEqual({ handled: true });
  });

  it("starts new bound threads with the default OpenAI Codex auth profile", async () => {
    resolveDefaultAuthProfileIdMock.mockReturnValue("openai-codex:default");
    const sessionFile = path.join(tempDir, "session.jsonl");

    await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
    });

    expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai-codex:default" }),
    );
    const sidecar = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    ) as Record<string, unknown>;
    expect(sidecar.authProfileId).toBe("openai-codex:default");
  });

  it("resumes existing bound threads with the default OpenAI Codex auth profile", async () => {
    resolveDefaultAuthProfileIdMock.mockReturnValue("openai-codex:default");
    const sessionFile = path.join(tempDir, "session.jsonl");

    await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      threadId: "thread-existing",
    });

    expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai-codex:default" }),
    );
    const sidecar = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    ) as Record<string, unknown>;
    expect(sidecar.authProfileId).toBe("openai-codex:default");
  });
});
