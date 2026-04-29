import { vi } from "vitest";

export function createFeishuClientMockModule(): {
  createFeishuWSClient: () => { start: () => void; close: () => void };
  createEventDispatcher: () => { register: () => void };
  isFeishuWebSocketClientClosedError: () => boolean;
  isFeishuWebSocketReconnectRequiredError: () => boolean;
} {
  return {
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
    createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
    isFeishuWebSocketClientClosedError: vi.fn(() => false),
    isFeishuWebSocketReconnectRequiredError: vi.fn(() => false),
  };
}

export function createFeishuRuntimeMockModule(): {
  getFeishuRuntime: () => {
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => number;
        createInboundDebouncer: () => {
          enqueue: () => Promise<void>;
          flushKey: () => Promise<void>;
        };
      };
      text: {
        hasControlCommand: () => boolean;
      };
    };
  };
} {
  return {
    getFeishuRuntime: () => ({
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: () => ({
            enqueue: async () => {},
            flushKey: async () => {},
          }),
        },
        text: {
          hasControlCommand: () => false,
        },
      },
    }),
  };
}
