import { describe, expect, it, vi } from "vitest";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "./inbound-debounce-policy.js";

describe("shouldDebounceTextInbound", () => {
  it("rejects blank text, media, and control commands", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];

    expect(shouldDebounceTextInbound({ text: "   ", cfg })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "hello", cfg, hasMedia: true })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "/status", cfg })).toBe(false);
  });

  it("accepts normal text when debounce is allowed", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];
    expect(shouldDebounceTextInbound({ text: "hello there", cfg })).toBe(true);
    expect(shouldDebounceTextInbound({ text: "hello there", cfg, allowDebounce: false })).toBe(
      false,
    );
  });
});

describe("createChannelInboundDebouncer", () => {
  it("resolves per-channel debounce and forwards callbacks", async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const cfg = {
        messages: {
          inbound: {
            debounceMs: 10,
            byChannel: {
              slack: 25,
            },
          },
        },
      } as Parameters<typeof createChannelInboundDebouncer<{ id: string }>>[0]["cfg"];

      const { debounceMs, debouncer } = createChannelInboundDebouncer<{ id: string }>({
        cfg,
        channel: "slack",
        buildKey: (item) => item.id,
        onFlush: async (items) => {
          flushed.push(items.map((entry) => entry.id));
        },
      });

      expect(debounceMs).toBe(25);

      const first = debouncer.enqueue({ id: "a" });
      const second = debouncer.enqueue({ id: "a" });
      await vi.advanceTimersByTimeAsync(30);
      await Promise.all([first, second]);

      expect(flushed).toEqual([["a", "a"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps enqueue pending until the debounced flush finishes", async () => {
    vi.useFakeTimers();
    try {
      const flushed = vi.fn();
      let releaseFlush!: () => void;
      const flushGate = new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
      const cfg = {
        messages: {
          inbound: {
            debounceMs: 25,
          },
        },
      } as Parameters<typeof createChannelInboundDebouncer<{ id: string }>>[0]["cfg"];

      const { debouncer } = createChannelInboundDebouncer<{ id: string }>({
        cfg,
        channel: "telegram",
        buildKey: (item) => item.id,
        onFlush: async (items) => {
          flushed(items.map((entry) => entry.id));
          await flushGate;
        },
      });

      let settled = false;
      const pending = debouncer.enqueue({ id: "a" }).then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      expect(flushed).toHaveBeenCalledWith(["a"]);
      expect(settled).toBe(false);

      releaseFlush();
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
