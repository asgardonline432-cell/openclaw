import { html, nothing } from "lit";
import type {
  CompactionStatus,
  FallbackStatus,
  RuntimeActivityStatus,
} from "../app-tool-stream.ts";
import { icons } from "../icons.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;
const RUNTIME_ACTIVITY_TOAST_DURATION_MS = 8000;

export function renderCompactionIndicator(status: CompactionStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase === "active" || status.phase === "retrying") {
    return html`
      <div
        class="compaction-indicator compaction-indicator--active"
        role="status"
        aria-live="polite"
      >
        ${icons.loader} Compacting context...
      </div>
    `;
  }
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div
          class="compaction-indicator compaction-indicator--complete"
          role="status"
          aria-live="polite"
        >
          ${icons.check} Context compacted
        </div>
      `;
    }
  }
  return nothing;
}

export function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div class=${className} role="status" aria-live="polite" title=${details}>
      ${icon} <span class="compaction-indicator__text">${message}</span>
    </div>
  `;
}

export function renderRuntimeActivityIndicator(
  status: RuntimeActivityStatus | null | undefined,
  opts: { visibleReasoningUnavailable?: boolean } = {},
) {
  if (!status) {
    return nothing;
  }
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed >= RUNTIME_ACTIVITY_TOAST_DURATION_MS) {
      return nothing;
    }
  }
  const latestLine = status.lines.at(-1);
  const message =
    status.phase === "error"
      ? status.error
        ? `Codex run error: ${status.error}`
        : "Codex run error"
      : status.phase === "complete"
        ? "Codex run complete"
        : latestLine
          ? `Codex: ${latestLine}`
          : "Codex running: waiting for safe progress";
  const details = [
    opts.visibleReasoningUnavailable
      ? "Private reasoning text is not shown; safe activity events are shown when available."
      : null,
    ...status.lines,
  ]
    .filter(Boolean)
    .join(" • ");
  const className =
    status.phase === "error"
      ? "compaction-indicator compaction-indicator--runtime-error"
      : status.phase === "complete"
        ? "compaction-indicator compaction-indicator--runtime-complete"
        : "compaction-indicator compaction-indicator--runtime";
  const icon =
    status.phase === "complete"
      ? icons.check
      : status.phase === "error"
        ? icons.brain
        : icons.loader;
  return html`
    <div class=${className} role="status" aria-live="polite" title=${details}>
      ${icon} <span class="compaction-indicator__text">${message}</span>
    </div>
  `;
}
