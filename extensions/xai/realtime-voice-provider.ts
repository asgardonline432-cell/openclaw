import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  decodeRealtimeVoiceBase64Audio,
  describeRealtimeVoiceServerEvent,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  readRealtimeVoiceErrorDetail,
  RealtimeVoiceToolCallAccumulator,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import WebSocket from "ws";
import { XAI_BASE_URL } from "./model-definitions.js";

type XaiRealtimeVoiceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
};

type XaiRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
};

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  is_final?: boolean;
  speech_final?: boolean;
  item_id?: string;
  call_id?: string;
  name?: string;
  response?: {
    status?: string;
    status_details?: unknown;
  };
  error?: unknown;
};

const XAI_REALTIME_VOICE_DEFAULT_MODEL = "grok-voice-think-fast-1.0";
const XAI_REALTIME_VOICE_DEFAULT_VOICE = "ara";
const XAI_REALTIME_VOICE_CONNECT_TIMEOUT_MS = 10_000;
const XAI_REALTIME_VOICE_MAX_RECONNECT_ATTEMPTS = 5;
const XAI_REALTIME_VOICE_BASE_RECONNECT_DELAY_MS = 1000;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedXaiConfig(rawConfig: RealtimeVoiceProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.xai ?? raw?.xai ?? raw) ?? {};
}

function readFiniteNumber(value: unknown): number | undefined {
  const next =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : undefined;
  return Number.isFinite(next) ? next : undefined;
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): XaiRealtimeVoiceProviderConfig {
  const raw = readNestedXaiConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model),
    voice: normalizeOptionalString(raw.voice),
    vadThreshold: readFiniteNumber(raw.vadThreshold ?? raw.threshold),
    silenceDurationMs: readFiniteNumber(raw.silenceDurationMs ?? raw.silence_duration_ms),
    prefixPaddingMs: readFiniteNumber(raw.prefixPaddingMs ?? raw.prefix_padding_ms),
  };
}

function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function resolveXaiApiKey(configuredApiKey: string | undefined): string | undefined {
  return (
    normalizeOptionalString(configuredApiKey) ?? normalizeOptionalString(process.env.XAI_API_KEY)
  );
}

function requireXaiApiKey(configuredApiKey: string | undefined): string {
  const apiKey = resolveXaiApiKey(configuredApiKey);
  if (!apiKey) {
    throw new Error("xAI API key missing");
  }
  return apiKey;
}

function toXaiRealtimeWsUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath.endsWith("/realtime")
    ? normalizedPath
    : `${normalizedPath || "/v1"}/realtime`;
  url.searchParams.set("model", model);
  return url.toString();
}

function toXaiAudioFormat(format: RealtimeVoiceAudioFormat): { type: string; rate?: number } {
  if (format.encoding === "pcm16") {
    return { type: "audio/pcm", rate: format.sampleRateHz };
  }
  return { type: "audio/pcmu" };
}

function readXaiRealtimeErrorDetail(value: unknown): string {
  return readRealtimeVoiceErrorDetail(value, "xAI realtime voice error");
}

class XaiRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private userTranscriptText = "";
  private readonly toolCallAccumulator = new RealtimeVoiceToolCallAccumulator();
  private readonly pendingToolResultCallIds = new Set<string>();
  private readonly submittedToolResultCallIds = new Set<string>();
  private toolCallResponseDone = false;
  private sessionReadyFired = false;
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: XaiRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < 320) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.ws) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the caller.");
  }

  submitToolResult(callId: string, result: unknown): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    if (this.pendingToolResultCallIds.size === 0) {
      this.sendEvent({ type: "response.create" });
      return;
    }
    this.submittedToolResultCallIds.add(callId);
    this.sendResponseCreateWhenToolResultsComplete();
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) {
      return;
    }
    this.markQueue.shift();
    this.sendResponseCreateWhenToolResultsComplete();
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let connectTimeout: ReturnType<typeof setTimeout>;
      let settled = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };
      const { url, headers } = this.resolveConnectionParams();
      this.ws = new WebSocket(url, { headers });

      connectTimeout = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          this.ws?.terminate();
          settleReject(new Error("xAI realtime voice connection timeout"));
        }
      }, XAI_REALTIME_VOICE_CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        this.connected = true;
        this.sessionConfigured = false;
        this.sendSessionUpdate();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
          if (event.type === "error" && !this.sessionConfigured) {
            settleReject(new Error(readXaiRealtimeErrorDetail(event.error)));
          }
        } catch (error) {
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.ws.on("error", (error) => {
        if (!this.sessionConfigured) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on("close", () => {
        const wasSessionConfigured = this.sessionConfigured;
        this.connected = false;
        this.sessionConfigured = false;
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        if (!wasSessionConfigured && !settled) {
          settleReject(new Error("xAI realtime voice connection closed before ready"));
          return;
        }
        if (!wasSessionConfigured) {
          return;
        }
        void this.attemptReconnect();
      });
    });
  }

  private resolveConnectionParams(): { url: string; headers: Record<string, string> } {
    const url = toXaiRealtimeWsUrl(this.config.baseUrl, this.config.model);
    return {
      url,
      headers: resolveProviderRequestHeaders({
        provider: "xai",
        baseUrl: url,
        capability: "audio",
        transport: "websocket",
        defaultHeaders: { Authorization: `Bearer ${this.config.apiKey}` },
      }) ?? { Authorization: `Bearer ${this.config.apiKey}` },
    };
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= XAI_REALTIME_VOICE_MAX_RECONNECT_ATTEMPTS) {
      this.config.onError?.(new Error("xAI realtime voice reconnect limit reached"));
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    await new Promise((resolve) =>
      setTimeout(resolve, XAI_REALTIME_VOICE_BASE_RECONNECT_DELAY_MS * this.reconnectAttempts),
    );
    if (!this.intentionallyClosed) {
      await this.doConnect().catch((error) => {
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        void this.attemptReconnect();
      });
    }
  }

  private sendSessionUpdate(): void {
    const format = toXaiAudioFormat(this.audioFormat);
    const session: Record<string, unknown> = {
      type: "realtime",
      model: this.config.model,
      instructions: this.config.instructions,
      voice: this.config.voice,
      turn_detection: {
        type: "server_vad",
        threshold: this.config.vadThreshold ?? 0.85,
        prefix_padding_ms: this.config.prefixPaddingMs ?? 333,
        silence_duration_ms: this.config.silenceDurationMs ?? 500,
        create_response: this.config.autoRespondToAudio ?? true,
      },
      audio: {
        input: {
          format,
        },
        output: {
          format,
          voice: this.config.voice,
        },
      },
    };
    if (this.config.tools && this.config.tools.length > 0) {
      session.tools = this.config.tools;
      session.tool_choice = "auto";
    }
    this.sendEvent({ type: "session.update", session });
  }

  private handleEvent(event: RealtimeEvent): void {
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
    });
    switch (event.type) {
      case "session.created":
        return;
      case "session.updated":
        this.sessionConfigured = true;
        this.reconnectAttempts = 0;
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          this.config.onReady?.();
        }
        return;
      case "response.created":
        this.resetToolResultState();
        this.responseActive = true;
        return;
      case "response.audio.delta":
      case "response.output_audio.delta":
        if (!event.delta) {
          return;
        }
        this.config.onAudio(decodeRealtimeVoiceBase64Audio(event.delta));
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.responseActive = true;
        this.sendMark();
        return;
      case "input_audio_buffer.speech_started":
        this.userTranscriptText = "";
        if (this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        if (event.transcript) {
          this.config.onTranscript?.("assistant", event.transcript, true);
        }
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.handleUserTranscriptCompleted(event);
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;
      case "response.done":
        this.responseActive = false;
        this.toolCallResponseDone = true;
        this.sendResponseCreateWhenToolResultsComplete();
        return;
      case "response.function_call_arguments.delta":
        this.handleToolCallDelta(event);
        return;
      case "response.function_call_arguments.done":
        this.handleToolCallDone(event);
        return;
      case "error":
        this.config.onError?.(new Error(readXaiRealtimeErrorDetail(event.error)));
        return;
      default:
        return;
    }
  }

  private handleToolCallDelta(event: RealtimeEvent): void {
    this.toolCallAccumulator.appendDelta(event);
  }

  private handleToolCallDone(event: RealtimeEvent): void {
    if (this.config.onToolCall) {
      const toolCall = this.toolCallAccumulator.consumeDone(event);
      if (toolCall.callId) {
        this.pendingToolResultCallIds.add(toolCall.callId);
      }
      this.config.onToolCall(toolCall);
    }
  }

  private handleUserTranscriptCompleted(event: RealtimeEvent): void {
    if (typeof event.transcript !== "string") {
      return;
    }
    const isFinal = event.speech_final !== false && event.is_final !== false;
    const delta = event.transcript.startsWith(this.userTranscriptText)
      ? event.transcript.slice(this.userTranscriptText.length)
      : event.transcript;
    this.userTranscriptText = isFinal ? "" : event.transcript;
    if (delta || isFinal) {
      this.config.onTranscript?.("user", delta, isFinal);
    }
  }

  private resetToolResultState(): void {
    this.pendingToolResultCallIds.clear();
    this.submittedToolResultCallIds.clear();
    this.toolCallResponseDone = false;
  }

  private sendResponseCreateWhenToolResultsComplete(): void {
    if (
      !this.toolCallResponseDone ||
      this.pendingToolResultCallIds.size === 0 ||
      this.markQueue.length > 0
    ) {
      return;
    }
    for (const callId of this.pendingToolResultCallIds) {
      if (!this.submittedToolResultCallIds.has(callId)) {
        return;
      }
    }
    this.sendEvent({ type: "response.create" });
    this.resetToolResultState();
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    if (this.responseActive || options?.audioPlaybackActive === true) {
      this.sendEvent({ type: "response.cancel" });
    }
    this.config.onClearAudio();
    this.markQueue = [];
    this.lastAssistantItemId = null;
    this.responseStartTimestamp = null;
    this.responseActive = false;
  }

  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const type =
      event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
        ? (event as { type: string }).type
        : "unknown";
    this.config.onEvent?.({ direction: "client", type });
    this.ws.send(JSON.stringify(event));
  }

  private describeServerEvent(event: RealtimeEvent): string | undefined {
    return describeRealtimeVoiceServerEvent(event, readXaiRealtimeErrorDetail);
  }
}

export function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "xai",
    label: "xAI Grok Voice",
    aliases: ["xai-voice", "grok-voice"],
    defaultModel: XAI_REALTIME_VOICE_DEFAULT_MODEL,
    autoSelectOrder: 25,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveXaiApiKey(normalizeProviderConfig(providerConfig).apiKey)),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: requireXaiApiKey(config.apiKey),
        baseUrl: normalizeXaiRealtimeBaseUrl(config.baseUrl),
        model: config.model ?? XAI_REALTIME_VOICE_DEFAULT_MODEL,
        voice: config.voice ?? XAI_REALTIME_VOICE_DEFAULT_VOICE,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
      });
    },
  };
}

export type { XaiRealtimeVoiceProviderConfig };
