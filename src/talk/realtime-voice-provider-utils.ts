import type { RealtimeVoiceToolCallEvent } from "./provider-types.js";

export type RealtimeVoiceProviderEventLike = {
  type: string;
  delta?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  response?: {
    status?: string;
    status_details?: unknown;
  };
  error?: unknown;
};

type RealtimeVoiceToolCallEventLike = RealtimeVoiceProviderEventLike & {
  arguments?: unknown;
};

export function decodeRealtimeVoiceBase64Audio(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readRealtimeVoiceErrorDetail(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  const message = typeof record?.message === "string" ? record.message.trim() : undefined;
  const code = typeof record?.code === "string" ? record.code.trim() : undefined;
  return message || code || fallback;
}

export function describeRealtimeVoiceServerEvent(
  event: RealtimeVoiceProviderEventLike,
  readErrorDetail: (error: unknown) => string,
): string | undefined {
  if (event.type === "error") {
    return readErrorDetail(event.error);
  }
  if (event.type !== "response.done") {
    return undefined;
  }
  const status = event.response?.status;
  const details =
    event.response?.status_details === undefined
      ? undefined
      : JSON.stringify(event.response.status_details);
  return [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined;
}

export class RealtimeVoiceToolCallAccumulator {
  private readonly buffers = new Map<string, { name: string; callId: string; args: string }>();

  appendDelta(event: RealtimeVoiceToolCallEventLike): void {
    const key = event.item_id ?? "unknown";
    const existing = this.buffers.get(key);
    if (existing && event.delta) {
      existing.args += event.delta;
      return;
    }
    if (event.item_id) {
      this.buffers.set(event.item_id, {
        name: event.name ?? "",
        callId: event.call_id ?? "",
        args: event.delta ?? "",
      });
    }
  }

  consumeDone(event: RealtimeVoiceToolCallEventLike): RealtimeVoiceToolCallEvent {
    const key = event.item_id ?? "unknown";
    const buffered = this.buffers.get(key);
    const rawArgs =
      buffered?.args || (typeof event.arguments === "string" ? event.arguments : undefined) || "{}";
    let args: unknown = {};
    try {
      args = JSON.parse(rawArgs);
    } catch {}
    this.buffers.delete(key);
    return {
      itemId: key,
      callId: buffered?.callId || event.call_id || "",
      name: buffered?.name || event.name || "",
      args,
    };
  }
}
