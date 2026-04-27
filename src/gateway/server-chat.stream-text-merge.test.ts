import { describe, expect, it } from "vitest";
import { resolveMergedAssistantText } from "./live-chat-projector.js";

function mergeDeltas(deltas: string[]): string {
  let previousText = "";
  for (const nextDelta of deltas) {
    previousText = resolveMergedAssistantText({
      previousText,
      nextText: "",
      nextDelta,
    });
  }
  return previousText;
}

describe("resolveMergedAssistantText", () => {
  it("preserves repeated digit boundary deltas", () => {
    expect(mergeDeltas(["1", "1", "1"])).toBe("111");
    expect(mergeDeltas(["2026", "6", "6"])).toBe("202666");
  });

  it("preserves repeated CJK boundary deltas", () => {
    expect(mergeDeltas(["好", "好", "好"])).toBe("好好好");
    expect(mergeDeltas(["测试", "试", "试"])).toBe("测试试试");
  });

  it("preserves repeated markdown table token deltas", () => {
    expect(mergeDeltas(["|", "|", " col ", "|", "\n", "|", "-", "-", "|"])).toBe("|| col |\n|--|");
  });

  it("does not grow the buffer when a full-text replay includes an old delta", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Final answer",
        nextText: "Final answer",
        nextDelta: " answer",
      }),
    ).toBe("Final answer");
  });

  it("keeps appending a real delta when the full-text snapshot is stale", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Final",
        nextText: "Fin",
        nextDelta: "!",
      }),
    ).toBe("Final!");
  });
});
