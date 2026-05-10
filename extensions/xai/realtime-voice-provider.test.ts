import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];
    closed = false;
    terminated = false;
    args: unknown[];

    constructor(...args: unknown[]) {
      this.args = args;
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.terminated = true;
      this.close(1006, "terminated");
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item_id?: string;
  content_index?: number;
  audio_end_ms?: number;
  item?: unknown;
  session?: {
    model?: string;
    voice?: string;
    tools?: unknown[];
    tool_choice?: string;
    turn_detection?: {
      type?: string;
      create_response?: boolean;
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    };
    audio?: {
      input?: {
        format?: { type?: string; rate?: number };
      };
      output?: {
        format?: { type?: string; rate?: number };
        voice?: string;
      };
    };
  };
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

describe("buildXaiRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("declares gateway realtime voice capabilities", () => {
    const provider = buildXaiRealtimeVoiceProvider();

    expect(provider.capabilities).toEqual({
      transports: ["gateway-relay"],
      inputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      outputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      supportsBargeIn: true,
      supportsToolCalls: true,
    });
  });

  it("normalizes provider-owned voice settings from raw provider config", () => {
    const provider = buildXaiRealtimeVoiceProvider();

    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: {
          providers: {
            xai: {
              apiKey: "xai-test-key",
              baseUrl: "https://api.x.ai/v1",
              model: "grok-voice-think-fast-1.0",
              voice: "eve",
              vadThreshold: "0.7",
              silenceDurationMs: 900,
              prefixPaddingMs: 250,
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "xai-test-key",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-voice-think-fast-1.0",
      voice: "eve",
      vadThreshold: 0.7,
      silenceDurationMs: 900,
      prefixPaddingMs: 250,
    });
  });

  it("connects to xAI realtime with nested audio format settings", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "xai-test-key",
        baseUrl: "https://api.x.ai/v1",
        voice: "eve",
      },
      instructions: "Be concise.",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });

    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    const [url, options] = socket.args as [string, { headers?: Record<string, string> }];
    expect(url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer xai-test-key",
    });
    expect(options.headers).not.toHaveProperty("OpenAI-Beta");
    expect(parseSent(socket)[0]).toMatchObject({
      type: "session.update",
      session: {
        model: "grok-voice-think-fast-1.0",
        voice: "eve",
        turn_detection: {
          type: "server_vad",
          create_response: true,
        },
        audio: {
          input: {
            format: { type: "audio/pcmu" },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "eve",
          },
        },
      },
    });
    expect(parseSent(socket)[0]?.session?.audio?.input).not.toHaveProperty("turn_detection");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(bridge.isConnected()).toBe(true);
  });

  it("can request PCM16 24 kHz realtime audio", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      autoRespondToAudio: false,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expect(parseSent(socket)[0]?.session).toMatchObject({
      turn_detection: { create_response: false },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
        },
      },
    });
  });

  it("cancels xAI playback on barge-in without sending unsupported truncate events", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    let bridge: ReturnType<typeof provider.createBridge>;
    bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      onAudio,
      onClearAudio,
      onMark: () => bridge.acknowledgeMark(),
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.created" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(parseSent(socket)).toContainEqual({ type: "response.cancel" });
    expect(parseSent(socket)).not.toContainEqual(
      expect.objectContaining({ type: "conversation.item.truncate" }),
    );
  });

  it("forwards function calls and submits tool results", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      tools: [
        {
          type: "function",
          name: "send_dtmf",
          description: "Send DTMF digits.",
          parameters: { type: "object", properties: {} },
        },
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          call_id: "call_1",
          name: "send_dtmf",
          delta: '{"digits":"',
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: '123#"}',
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_1",
        }),
      ),
    );
    bridge.submitToolResult("call_1", { success: true });

    expect(parseSent(socket)[0]?.session).toMatchObject({
      tools: [expect.objectContaining({ name: "send_dtmf" })],
      tool_choice: "auto",
    });
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_1",
      callId: "call_1",
      name: "send_dtmf",
      args: { digits: "123#" },
    });
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(0);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"success":true}',
        },
      },
      { type: "response.create" },
    ]);
  });

  it("waits for all parallel xAI tool outputs before creating a response", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      tools: [
        {
          type: "function",
          name: "send_dtmf",
          description: "Send DTMF digits.",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "end_call",
          description: "End the call.",
          parameters: { type: "object", properties: {} },
        },
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          call_id: "call_1",
          name: "send_dtmf",
          delta: '{"digits":"123#"}',
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_1",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "item_2",
          call_id: "call_2",
          name: "end_call",
          delta: "{}",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_2",
        }),
      ),
    );

    bridge.submitToolResult("call_1", { success: true });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(0);

    bridge.submitToolResult("call_2", { success: true });

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
    expect(parseSent(socket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"success":true}',
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_2",
          output: '{"success":true}',
        },
      },
      { type: "response.create" },
    ]);
  });

  it("waits for queued playback marks before creating an xAI tool follow-up response", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      tools: [
        {
          type: "function",
          name: "send_dtmf",
          description: "Send DTMF digits.",
          parameters: { type: "object", properties: {} },
        },
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onMark: vi.fn(),
      onToolCall: vi.fn(),
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.audio.delta",
          item_id: "item_audio",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "item_tool",
          call_id: "call_1",
          name: "send_dtmf",
          delta: '{"digits":"123#"}',
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_tool",
        }),
      ),
    );
    bridge.submitToolResult("call_1", { success: true });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(0);

    bridge.acknowledgeMark();

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
  });

  it("treats documented xAI completed user transcripts as final by default", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "book",
          is_final: false,
          speech_final: false,
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "book a table",
          is_final: true,
          speech_final: false,
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "book a table for two",
        }),
      ),
    );

    expect(onTranscript).toHaveBeenNthCalledWith(1, "user", "book", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "user", " a table", false);
    expect(onTranscript).toHaveBeenNthCalledWith(3, "user", " for two", true);
  });

  it("continues reconnecting when a reconnect socket fails before session update", async () => {
    vi.useFakeTimers();
    const provider = buildXaiRealtimeVoiceProvider();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      onClose,
    });
    const connecting = bridge.connect();
    const initialSocket = FakeWebSocket.instances[0];
    if (!initialSocket) {
      throw new Error("expected bridge to create a websocket");
    }

    initialSocket.readyState = FakeWebSocket.OPEN;
    initialSocket.emit("open");
    initialSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    initialSocket.emit("close");
    await vi.advanceTimersByTimeAsync(1000);
    const failedReconnectSocket = FakeWebSocket.instances[1];
    if (!failedReconnectSocket) {
      throw new Error("expected first reconnect websocket");
    }

    failedReconnectSocket.readyState = FakeWebSocket.OPEN;
    failedReconnectSocket.emit("open");
    failedReconnectSocket.emit("error", new Error("temporary reconnect failure"));
    failedReconnectSocket.emit("close");
    await vi.advanceTimersByTimeAsync(2000);

    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("temporary reconnect failure") }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
