import { isAuthErrorMessage } from "../agents/pi-embedded-helpers.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type {
  AgentEvent,
  BtwEvent,
  ChatEvent,
  SessionChangedEvent,
  TuiStateAccess,
} from "./tui-types.js";

type EventHandlerChatLog = {
  startTool: (toolCallId: string, toolName: string, args: unknown) => void;
  updateToolResult: (
    toolCallId: string,
    result: unknown,
    options?: { partial?: boolean; isError?: boolean },
  ) => void;
  addSystem: (text: string) => void;
  updateAssistant: (text: string, runId: string) => void;
  finalizeAssistant: (text: string, runId: string) => void;
  dropAssistant: (runId: string) => void;
};

type EventHandlerTui = {
  requestRender: () => void;
};

type EventHandlerBtwPresenter = {
  showResult: (params: { question: string; text: string; isError?: boolean }) => void;
  clear: () => void;
};

type EventHandlerContext = {
  chatLog: EventHandlerChatLog;
  btw: EventHandlerBtwPresenter;
  tui: EventHandlerTui;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
  loadHistory?: () => Promise<void>;
  noteLocalRunId?: (runId: string) => void;
  isLocalRunId?: (runId: string) => boolean;
  forgetLocalRunId?: (runId: string) => void;
  clearLocalRunIds?: () => void;
  isLocalBtwRunId?: (runId: string) => boolean;
  forgetLocalBtwRunId?: (runId: string) => void;
  clearLocalBtwRunIds?: () => void;
  /** Reset `streaming` after this much delta silence. Set to 0 to disable. */
  streamingWatchdogMs?: number;
  localMode?: boolean;
};

const DEFAULT_STREAMING_WATCHDOG_MS = 30_000;

export function createEventHandlers(context: EventHandlerContext) {
  const {
    chatLog,
    btw,
    tui,
    state,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    noteLocalRunId,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
    isLocalBtwRunId,
    forgetLocalBtwRunId,
    clearLocalBtwRunIds,
    localMode,
  } = context;
  const finalizedRuns = new Map<string, number>();
  const sessionRuns = new Map<string, number>();
  let streamAssembler = new TuiStreamAssembler();
  let lastSessionKey = state.currentSessionKey;
  let pendingHistoryRefresh = false;

  const streamingWatchdogMs =
    typeof context.streamingWatchdogMs === "number" &&
    Number.isFinite(context.streamingWatchdogMs) &&
    context.streamingWatchdogMs >= 0
      ? Math.floor(context.streamingWatchdogMs)
      : DEFAULT_STREAMING_WATCHDOG_MS;
  let streamingWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let streamingWatchdogRunId: string | null = null;

  const flushPendingHistoryRefreshIfIdle = () => {
    if (!pendingHistoryRefresh || state.activeChatRunId) {
      return false;
    }
    pendingHistoryRefresh = false;
    if (!loadHistory) {
      return false;
    }
    void loadHistory();
    return true;
  };

  const clearStreamingWatchdog = () => {
    if (streamingWatchdogTimer) {
      clearTimeout(streamingWatchdogTimer);
      streamingWatchdogTimer = null;
    }
    streamingWatchdogRunId = null;
  };

  const clearTrackedRunState = () => {
    finalizedRuns.clear();
    sessionRuns.clear();
    streamAssembler = new TuiStreamAssembler();
    pendingHistoryRefresh = false;
    state.pendingOptimisticUserMessage = false;
    clearLocalRunIds?.();
    clearLocalBtwRunIds?.();
    btw.clear();
    clearStreamingWatchdog();
  };

  const armStreamingWatchdog = (runId: string) => {
    if (streamingWatchdogMs <= 0) {
      return;
    }
    if (streamingWatchdogTimer) {
      clearTimeout(streamingWatchdogTimer);
    }
    streamingWatchdogRunId = runId;
    streamingWatchdogTimer = setTimeout(() => {
      streamingWatchdogTimer = null;
      if (streamingWatchdogRunId !== runId || state.activeChatRunId !== runId) {
        return;
      }
      streamingWatchdogRunId = null;
      state.activeChatRunId = null;
      state.activityStatus = "idle";
      setActivityStatus("idle");
      flushPendingHistoryRefreshIfIdle();
      chatLog.addSystem(
        `streaming watchdog: no stream updates for ${Math.round(
          streamingWatchdogMs / 1000,
        )}s; resetting status. The backend may have dropped this run silently — send a new message to resync.`,
      );
      tui.requestRender();
    }, streamingWatchdogMs);
    const maybeUnref = (streamingWatchdogTimer as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(streamingWatchdogTimer);
    }
  };

  const pruneRunMap = (runs: Map<string, number>) => {
    if (runs.size <= 200) {
      return;
    }
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of runs) {
      if (runs.size <= 150) {
        break;
      }
      if (ts < keepUntil) {
        runs.delete(key);
      }
    }
    if (runs.size > 200) {
      for (const key of runs.keys()) {
        runs.delete(key);
        if (runs.size <= 150) {
          break;
        }
      }
    }
  };

  const syncSessionKey = () => {
    if (state.currentSessionKey === lastSessionKey) {
      return;
    }
    lastSessionKey = state.currentSessionKey;
    clearTrackedRunState();
  };

  const resolveAuthErrorHint = (errorMessage: string): string | undefined => {
    if (!localMode || !isAuthErrorMessage(errorMessage)) {
      return undefined;
    }
    const provider = state.sessionInfo.modelProvider?.trim();
    return provider
      ? `auth or provider access failed for ${provider}. Run /auth ${provider} to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.`
      : "auth or provider access failed for the current provider. Run /auth to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.";
  };

  const noteSessionRun = (runId: string) => {
    sessionRuns.set(runId, Date.now());
    pruneRunMap(sessionRuns);
  };

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    sessionRuns.delete(runId);
    streamAssembler.drop(runId);
    pruneRunMap(finalizedRuns);
  };

  const clearActiveRunIfMatch = (runId: string) => {
    if (state.activeChatRunId === runId) {
      state.activeChatRunId = null;
    }
  };

  const clearStaleStreamingRunIfNoTrackedRunRemains = (): boolean => {
    const activeRunId = state.activeChatRunId;
    if (
      !activeRunId ||
      sessionRuns.has(activeRunId) ||
      sessionRuns.size > 0 ||
      state.activityStatus !== "streaming"
    ) {
      return false;
    }
    state.activeChatRunId = null;
    state.activityStatus = "idle";
    setActivityStatus("idle");
    clearStreamingWatchdog();
    return flushPendingHistoryRefreshIfIdle();
  };

  const finalizeRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "idle" | "error";
  }): boolean => {
    noteFinalizedRun(params.runId);
    clearActiveRunIfMatch(params.runId);
    let historyReloaded = flushPendingHistoryRefreshIfIdle();
    if (params.wasActiveRun) {
      setActivityStatus(params.status);
      clearStreamingWatchdog();
    } else {
      if (streamingWatchdogRunId === params.runId) {
        clearStreamingWatchdog();
      }
      historyReloaded = clearStaleStreamingRunIfNoTrackedRunRemains() || historyReloaded;
    }
    return historyReloaded;
  };

  const terminateRun = (params: {
    runId: string;
    wasActiveRun: boolean;
    status: "aborted" | "error";
  }): boolean => {
    streamAssembler.drop(params.runId);
    sessionRuns.delete(params.runId);
    clearActiveRunIfMatch(params.runId);
    let historyReloaded = flushPendingHistoryRefreshIfIdle();
    if (params.wasActiveRun) {
      setActivityStatus(params.status);
      clearStreamingWatchdog();
    } else {
      if (streamingWatchdogRunId === params.runId) {
        clearStreamingWatchdog();
      }
      historyReloaded = clearStaleStreamingRunIfNoTrackedRunRemains() || historyReloaded;
    }
    return historyReloaded;
  };

  const hasConcurrentActiveRun = (runId: string) => {
    const activeRunId = state.activeChatRunId;
    if (!activeRunId || activeRunId === runId) {
      return false;
    }
    return sessionRuns.has(activeRunId);
  };

  const maybeRefreshHistoryForRun = (
    runId: string,
    opts?: { allowLocalWithoutDisplayableFinal?: boolean },
  ): boolean => {
    const isLocalRun = isLocalRunId?.(runId) ?? false;
    if (isLocalRun) {
      forgetLocalRunId?.(runId);
      // Local runs with displayable output do not need a history reload.
      if (!opts?.allowLocalWithoutDisplayableFinal) {
        return false;
      }
      // Defer the reload if a newer run is active so we preserve the pending
      // user message, then flush once that active run finishes.
      if (state.activeChatRunId && state.activeChatRunId !== runId) {
        pendingHistoryRefresh = true;
        return true;
      }
    }
    if (hasConcurrentActiveRun(runId)) {
      return false;
    }
    pendingHistoryRefresh = false;
    if (!loadHistory) {
      return false;
    }
    void loadHistory();
    return true;
  };

  const refreshSessionInfoIfHistoryDidNotReload = (historyReloadScheduled: boolean) => {
    if (historyReloadScheduled) {
      return;
    }
    void refreshSessionInfo?.();
  };

  const isSameSessionKey = (left: string | undefined, right: string | undefined): boolean => {
    const normalizedLeft = normalizeLowercaseStringOrEmpty(left);
    const normalizedRight = normalizeLowercaseStringOrEmpty(right);
    if (!normalizedLeft || !normalizedRight) {
      return false;
    }
    if (normalizedLeft === normalizedRight) {
      return true;
    }
    const parsedLeft = parseAgentSessionKey(normalizedLeft);
    const parsedRight = parseAgentSessionKey(normalizedRight);
    if (parsedLeft && parsedRight) {
      return parsedLeft.agentId === parsedRight.agentId && parsedLeft.rest === parsedRight.rest;
    }
    if (parsedLeft) {
      return parsedLeft.rest === normalizedRight;
    }
    if (parsedRight) {
      return normalizedLeft === parsedRight.rest;
    }
    return false;
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") {
        return;
      }
      if (evt.state === "final") {
        return;
      }
    }
    noteSessionRun(evt.runId);
    if (!state.activeChatRunId && !isLocalBtwRunId?.(evt.runId)) {
      state.activeChatRunId = evt.runId;
      if (state.pendingOptimisticUserMessage) {
        noteLocalRunId?.(evt.runId);
        state.pendingOptimisticUserMessage = false;
      }
    }
    if (evt.state === "delta") {
      // Arm watchdog and mark streaming on every delta, even when the visible
      // text hasn't changed yet (e.g. first commentary-only or tool-call delta).
      // Without this, the watchdog never fires and the status bar stays stale.
      setActivityStatus("streaming");
      if (state.activeChatRunId === evt.runId) {
        armStreamingWatchdog(evt.runId);
      }
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) {
        return;
      }
      chatLog.updateAssistant(displayText, evt.runId);
    }
    if (evt.state === "final") {
      const isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
      const wasActiveRun = state.activeChatRunId === evt.runId;
      if (!evt.message && isLocalBtwRun) {
        forgetLocalBtwRunId?.(evt.runId);
        noteFinalizedRun(evt.runId);
        tui.requestRender();
        return;
      }
      if (!evt.message) {
        const historyReloadScheduled = maybeRefreshHistoryForRun(evt.runId, {
          allowLocalWithoutDisplayableFinal: true,
        });
        chatLog.dropAssistant(evt.runId);
        const pendingHistoryReloaded = finalizeRun({
          runId: evt.runId,
          wasActiveRun,
          status: "idle",
        });
        refreshSessionInfoIfHistoryDidNotReload(historyReloadScheduled || pendingHistoryReloaded);
        tui.requestRender();
        return;
      }
      if (isCommandMessage(evt.message)) {
        const historyReloadScheduled = maybeRefreshHistoryForRun(evt.runId);
        const text = extractTextFromMessage(evt.message);
        if (text) {
          chatLog.addSystem(text);
        }
        const pendingHistoryReloaded = finalizeRun({
          runId: evt.runId,
          wasActiveRun,
          status: "idle",
        });
        refreshSessionInfoIfHistoryDidNotReload(historyReloadScheduled || pendingHistoryReloaded);
        tui.requestRender();
        return;
      }
      const historyReloadScheduled = maybeRefreshHistoryForRun(evt.runId);
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";

      const finalText = streamAssembler.finalize(
        evt.runId,
        evt.message,
        state.showThinking,
        evt.errorMessage,
      );
      const suppressEmptyExternalPlaceholder =
        finalText === "(no output)" && !isLocalRunId?.(evt.runId);
      if (suppressEmptyExternalPlaceholder) {
        chatLog.dropAssistant(evt.runId);
      } else {
        chatLog.finalizeAssistant(finalText, evt.runId);
      }
      const pendingHistoryReloaded = finalizeRun({
        runId: evt.runId,
        wasActiveRun,
        status: stopReason === "error" ? "error" : "idle",
      });
      refreshSessionInfoIfHistoryDidNotReload(historyReloadScheduled || pendingHistoryReloaded);
    }
    if (evt.state === "aborted") {
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = state.activeChatRunId === evt.runId;
      chatLog.addSystem("run aborted");
      const pendingHistoryReloaded = terminateRun({
        runId: evt.runId,
        wasActiveRun,
        status: "aborted",
      });
      const historyReloadScheduled = pendingHistoryReloaded || maybeRefreshHistoryForRun(evt.runId);
      refreshSessionInfoIfHistoryDidNotReload(historyReloadScheduled);
    }
    if (evt.state === "error") {
      forgetLocalBtwRunId?.(evt.runId);
      const wasActiveRun = state.activeChatRunId === evt.runId;
      const errorMessage = evt.errorMessage ?? "unknown";
      chatLog.addSystem(resolveAuthErrorHint(errorMessage) ?? `run error: ${errorMessage}`);
      const pendingHistoryReloaded = terminateRun({
        runId: evt.runId,
        wasActiveRun,
        status: "error",
      });
      const historyReloadScheduled = pendingHistoryReloaded || maybeRefreshHistoryForRun(evt.runId);
      refreshSessionInfoIfHistoryDidNotReload(historyReloadScheduled);
    }
    tui.requestRender();
  };

  const handleSessionsChangedEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as SessionChangedEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (evt.reason !== "new" && evt.reason !== "reset") {
      return;
    }

    clearTrackedRunState();
    state.activeChatRunId = null;
    state.activityStatus = "idle";
    setActivityStatus("idle");
    if (typeof evt.sessionId === "string") {
      state.currentSessionId = evt.sessionId;
    }
    if (typeof evt.updatedAt === "number" || evt.updatedAt === null) {
      state.sessionInfo.updatedAt = evt.updatedAt;
    }
    if (loadHistory) {
      void loadHistory();
    } else {
      void refreshSessionInfo?.();
    }
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as AgentEvent;
    syncSessionKey();
    // Agent events (tool streaming, lifecycle) are emitted per-run. Filter against the
    // active chat run id, not the session id. Tool results can arrive after the chat
    // final event, so accept finalized runs for tool updates.
    const isActiveRun = evt.runId === state.activeChatRunId;
    const isKnownRun = isActiveRun || sessionRuns.has(evt.runId) || finalizedRuns.has(evt.runId);
    if (!isKnownRun) {
      return;
    }
    if (evt.stream === "tool") {
      const verbose = state.sessionInfo.verboseLevel ?? "off";
      const allowToolEvents = verbose !== "off";
      const allowToolOutput = verbose === "full";
      if (!allowToolEvents) {
        return;
      }
      const data = evt.data ?? {};
      const phase = asString(data.phase, "");
      const toolCallId = asString(data.toolCallId, "");
      const toolName = asString(data.name, "tool");
      if (!toolCallId) {
        return;
      }
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args);
      } else if (phase === "update") {
        if (!allowToolOutput) {
          return;
        }
        chatLog.updateToolResult(toolCallId, data.partialResult, {
          partial: true,
        });
      } else if (phase === "result") {
        if (allowToolOutput) {
          chatLog.updateToolResult(toolCallId, data.result, {
            isError: Boolean(data.isError),
          });
        } else {
          chatLog.updateToolResult(toolCallId, { content: [] }, { isError: Boolean(data.isError) });
        }
      }
      tui.requestRender();
      return;
    }
    if (evt.stream === "lifecycle") {
      if (!isActiveRun) {
        return;
      }
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start") {
        setActivityStatus("running");
      }
      if (phase === "end") {
        setActivityStatus("idle");
      }
      if (phase === "error") {
        setActivityStatus("error");
      }
      tui.requestRender();
    }
  };

  const handleBtwEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const evt = payload as BtwEvent;
    syncSessionKey();
    if (!isSameSessionKey(evt.sessionKey, state.currentSessionKey)) {
      return;
    }
    if (evt.kind !== "btw") {
      return;
    }
    const question = evt.question.trim();
    const text = evt.text.trim();
    if (!question || !text) {
      return;
    }
    btw.showResult({
      question,
      text,
      isError: evt.isError,
    });
    tui.requestRender();
  };

  const dispose = () => {
    clearStreamingWatchdog();
  };

  return { handleChatEvent, handleAgentEvent, handleBtwEvent, handleSessionsChangedEvent, dispose };
}
