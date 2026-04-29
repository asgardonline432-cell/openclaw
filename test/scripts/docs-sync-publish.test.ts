import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("scripts/docs-sync-publish", () => {
  it("does not emit Thai navigation until Mintlify supports th", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "openclaw-docs-sync-"));

    try {
      execFileSync(
        process.execPath,
        [
          "scripts/docs-sync-publish.mjs",
          "--target",
          targetRoot,
          "--source-repo",
          "openclaw/openclaw",
          "--source-sha",
          "test",
        ],
        {
          cwd: process.cwd(),
          stdio: "pipe",
        },
      );

      const docsConfig = JSON.parse(readFileSync(join(targetRoot, "docs", "docs.json"), "utf8"));
      const languages = docsConfig.navigation.languages.map(
        (entry: { language?: unknown }) => entry.language,
      );

      expect(languages).not.toContain("th");
      expect(languages).toContain("en");
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});
