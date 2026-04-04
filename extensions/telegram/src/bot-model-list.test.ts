import { rm } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
const {
  answerCallbackQuerySpy,
  editMessageTextSpy,
  getLoadConfigMock,
  getOnHandler,
  replySpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = await import("./bot.create-telegram-bot.test-harness.js");

let createTelegramBotBase: typeof import("./bot.js").createTelegramBot;
let setTelegramBotRuntimeForTest: typeof import("./bot.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();

describe("createTelegramBot model list callbacks", () => {
  beforeAll(async () => {
    ({ createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot.js"));
  });

  beforeEach(() => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("keeps provider-scoped current-model markers in model list callbacks", async () => {
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-list-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "github-copilot/gpt-5.4": {},
              "openai-codex/gpt-5.4": {},
              "openai-codex/gpt-5.3-codex-spark": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = getOnHandler("callback_query") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-list-1",
          data: "mdl_sel_github-copilot/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 18,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      editMessageTextSpy.mockClear();
      answerCallbackQuerySpy.mockClear();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-list-2",
          data: "mdl_list_openai-codex_1",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 18,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      const [chatId, messageId, _text, params] = editMessageTextSpy.mock.calls[0] ?? [];
      expect(chatId).toBe(1234);
      expect(messageId).toBe(18);

      const buttonTexts =
        (
          params as
            | {
                reply_markup?: {
                  inline_keyboard?: Array<Array<{ text: string }>>;
                };
              }
            | undefined
        )?.reply_markup?.inline_keyboard
          ?.flat()
          .map((button) => button.text) ?? [];

      expect(buttonTexts).toContain("gpt-5.4");
      expect(buttonTexts).not.toContain("gpt-5.4 ✓");
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-list-2");
    } finally {
      await rm(storePath, { force: true });
    }
  });
});
