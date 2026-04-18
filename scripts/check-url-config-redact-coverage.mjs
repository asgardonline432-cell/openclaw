#!/usr/bin/env node

/**
 * Lint: detect schema URL config fields that are missing redact coverage.
 *
 * OpenClaw identifies sensitive URL config in two ways:
 *   1. Path suffix matching via isSensitiveUrlConfigPath() in
 *      redact-sensitive-url.ts
 *   2. Schema metadata via the url-secret tag
 *
 * Either signal is enough. This rule inspects schema fields whose names contain
 * Url/url and reports any field that is covered by neither the path matcher nor
 * the url-secret tag.
 *
 * That prevents regressions like the browser.cdpUrl omission from PR #67679.
 *
 * The isSensitiveUrlConfigPath rules are extracted from source instead of being
 * duplicated manually, so this lint always matches the real runtime behavior.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

// These URL-shaped field names do not carry credentials and do not need redaction.
const SAFE_URL_PATTERNS = [
  /allowUrl$/i, // Allowlist booleans or lists do not carry credentials.
  /urlAllowlist$/i, // URL allowlists do not carry credentials.
  /allowExternalEmbed/i, // External embed allowlists do not carry credentials.
  /hookUrl$/i, // Public callback URLs keep credentials in separate token fields.
];

function isSafeUrlField(key) {
  return SAFE_URL_PATTERNS.some((p) => p.test(key));
}

/**
 * Extract path suffix rules for isSensitiveUrlConfigPath() directly from
 * redact-sensitive-url.ts by parsing endsWith(".xxx") calls.
 */
function extractEndsWithRules(source) {
  const rules = [];
  // Match path.endsWith(".xxx") patterns.
  const endsWithPattern = /path\.endsWith\("(\.[^"]+)"\)/g;
  let match;
  while ((match = endsWithPattern.exec(source)) !== null) {
    rules.push(match[1]);
  }
  return rules;
}

/**
 * Extract regex rules directly from redact-sensitive-url.ts by parsing
 * /^...$/ regex literals used against config paths.
 */
function extractRegexRules(source) {
  const rules = [];
  // Match /pattern/.test(path) patterns.
  const regexPattern = /\/(\^[^/]+)\$\/\.test\(path\)/g;
  let match;
  while ((match = regexPattern.exec(source)) !== null) {
    rules.push(new RegExp(match[1] + "$"));
  }
  return rules;
}

/**
 * Build an isSensitiveUrlConfigPath equivalent from rules extracted from source.
 */
function buildIsSensitiveUrlConfigPath(source) {
  const endsWithRules = extractEndsWithRules(source);
  const regexRules = extractRegexRules(source);

  return function isSensitiveUrlConfigPath(configPath) {
    for (const suffix of endsWithRules) {
      if (configPath.endsWith(suffix)) {
        return true;
      }
    }
    for (const regex of regexRules) {
      if (regex.test(configPath)) {
        return true;
      }
    }
    return false;
  };
}

async function run() {
  const repoRoot = path.resolve(import.meta.dirname, "..");

  // Read redact-sensitive-url.ts and extract the sensitive-path rules.
  const redactSourcePath = path.join(repoRoot, "src/shared/net/redact-sensitive-url.ts");
  const redactSource = await fs.readFile(redactSourcePath, "utf8");
  const isSensitiveUrlConfigPath = buildIsSensitiveUrlConfigPath(redactSource);

  // Read schema.base.generated.ts and inspect its URL-shaped config fields.
  const schemaPath = path.join(repoRoot, "src/config/schema.base.generated.ts");
  // Expected format: "some.key": { label: "...", help: "...", tags: [...] }
  // Use a non-greedy match plus indentation boundary to avoid spanning entries.
  const content = await fs.readFile(schemaPath, "utf8");
  const entryPattern = /"([^"]+)":\s*\{([\s\S]*?)\n    \}/g;

  const violations = [];
  let match;

  while ((match = entryPattern.exec(content)) !== null) {
    const key = match[1];
    const body = match[2];

    // Only inspect fields whose keys contain Url / url.
    if (!/[Uu]rl/.test(key)) {
      continue;
    }

    // Skip known-safe URL-shaped fields.
    if (isSafeUrlField(key)) {
      continue;
    }

    // Extract tags from the field body.
    const tagsMatch = body.match(/tags:\s*\[([^\]]*)\]/);
    if (!tagsMatch) {
      continue;
    }
    const tags = tagsMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/"/g, "").replace(/'/g, ""))
      .filter(Boolean);

    const hasUrlSecret = tags.includes("url-secret");

    // Instantiate wildcard keys before checking the path matcher.
    const instanceKey = key.replace(/\*\./g, "testprofile.");
    const pathCovered = isSensitiveUrlConfigPath(instanceKey);

    // Report fields that are covered by neither mechanism.
    if (!hasUrlSecret && !pathCovered) {
      violations.push({ key, tags });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(
    [
      "URL config fields missing redact coverage (no url-secret tag AND no path match in isSensitiveUrlConfigPath).",
      "",
      "Each URL config field that may contain credentials must be covered by either:",
      "  1. A path suffix rule in isSensitiveUrlConfigPath() (src/shared/net/redact-sensitive-url.ts), OR",
      '  2. A "url-secret" tag in schema.base.generated.ts',
      "",
      "If the field cannot contain credentials (e.g. allowlist, boolean flags), add it to",
      "SAFE_URL_PATTERNS in this script.",
      "",
      "Uncovered fields:",
    ].join("\n"),
  );

  for (const v of violations) {
    console.error(`- ${v.key}  tags: [${v.tags.join(", ")}]`);
  }

  process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
