#!/usr/bin/env node

import path from "node:path";
/**
 * Lint: runtime code must not import config redact/restore helpers.
 *
 * OpenClaw has two separate config flows that must never be mixed:
 *
 * 1. Runtime path: loadConfig() -> consume raw values directly for browser
 *    connections, embedding calls, and other live execution.
 * 2. API/display path: readConfigFileSnapshot() -> redactConfigSnapshot() ->
 *    return a safe snapshot to the UI. Writes use restoreRedactedValues() to
 *    turn the __OPENCLAW_REDACTED__ placeholder back into the original value.
 *
 * If runtime code accidentally consumes redacted values, live behavior can
 * fail. If display code skips redaction, credentials can leak.
 *
 * This guard keeps redact-snapshot redact/restore helpers out of runtime code
 * so those two flows stay isolated.
 *
 * redactSensitiveUrl() / redactSensitiveUrlLikeString() remain allowed in
 * runtime code because they only sanitize log and error output strings.
 */
import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { resolveRepoRoot, runAsScript } from "./lib/ts-guard-utils.mjs";

/**
 * Scan the repo-wide production surface instead of trying to enumerate every
 * runtime directory. Redacted config helpers should only be imported from a
 * small set of display/config surfaces; everything else is treated as runtime.
 */
const SOURCE_ROOTS = ["src", "extensions", "apps"];

/**
 * Only config display/writeback surfaces may import redact-snapshot helpers.
 */
const ALLOWED_REDACT_SNAPSHOT_CALLSITES = new Set([
  "src/cli/config-cli.ts",
  "src/gateway/server-methods/config.ts",
  "src/gateway/server-methods/talk.ts",
]);

/**
 * Only config metadata/redaction internals may import these schema helpers.
 */
const ALLOWED_REDACT_SENSITIVE_URL_CALLSITES = new Set([
  "src/config/redact-snapshot.ts",
  "src/config/schema-base.ts",
  "src/config/schema.hints.ts",
]);
const REPO_ROOT = resolveRepoRoot(import.meta.url);

const BANNED_FROM_REDACT_SNAPSHOT = new Set([
  "redactConfigSnapshot", // Replaces sensitive fields across a full config snapshot.
  "redactConfigObject", // Replaces sensitive fields on a config object.
  "restoreRedactedValues", // Restores the __OPENCLAW_REDACTED__ placeholder.
  "REDACTED_SENTINEL", // Redaction sentinel constant.
]);

/**
 * Symbols from redact-sensitive-url that runtime code must not use.
 *
 * redactSensitiveUrl() / redactSensitiveUrlLikeString() are intentionally not
 * in the banned set because they are valid for runtime log and error
 * sanitization.
 *
 * The following helpers belong to the config-redaction framework itself and
 * should not be imported from runtime code.
 */
const BANNED_FROM_REDACT_SENSITIVE_URL = new Set([
  "isSensitiveUrlConfigPath", // Checks whether a config path is a sensitive URL.
  "hasSensitiveUrlHintTag", // Checks for the url-secret schema tag.
  "SENSITIVE_URL_HINT_TAG", // url-secret tag constant.
]);

function findViolations(content, filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const violations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }

      const importPath = moduleSpecifier.text;

      const isRedactSnapshotImport = importPath.includes("redact-snapshot");
      const isRedactSensitiveUrlImport = importPath.includes("redact-sensitive-url");

      if (!isRedactSnapshotImport && !isRedactSensitiveUrlImport) {
        return;
      }

      const allowedCallsites = isRedactSnapshotImport
        ? ALLOWED_REDACT_SNAPSHOT_CALLSITES
        : ALLOWED_REDACT_SENSITIVE_URL_CALLSITES;
      if (allowedCallsites.has(relativePath)) {
        return;
      }

      const bannedImports = isRedactSnapshotImport
        ? BANNED_FROM_REDACT_SNAPSHOT
        : BANNED_FROM_REDACT_SENSITIVE_URL;

      const importClause = node.importClause;
      if (!importClause) {
        return;
      }

      // Named imports: import { a, b } from "..."
      if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (bannedImports.has(importedName)) {
            const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
            violations.push(line.line + 1);
          }
        }
      }

      // Namespace import: import * as X from "..."
      if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(line.line + 1);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

runAsScript(import.meta.url, async () => {
  await runCallsiteGuard({
    sourceRoots: SOURCE_ROOTS,
    header: [
      "Config redact/restore functions must only be imported in approved display/config code.",
      "",
      "Any code that executes with live config must use loadConfig() directly.",
      "Redact/restore helpers are only for config display/writeback flows.",
      "",
      "Banned from redact-snapshot: redactConfigSnapshot, redactConfigObject,",
      "  restoreRedactedValues, REDACTED_SENTINEL",
      "Banned from redact-sensitive-url: isSensitiveUrlConfigPath,",
      "  hasSensitiveUrlHintTag, SENSITIVE_URL_HINT_TAG",
      "",
      "Allowed in runtime: redactSensitiveUrl, redactSensitiveUrlLikeString",
      "  (for log/error URL redaction — this is legitimate runtime usage)",
      "",
      "Only these files may import redact-snapshot helpers:",
      ...Array.from(ALLOWED_REDACT_SNAPSHOT_CALLSITES).map((path) => `  - ${path}`),
      "Only these files may import config-path/url-hint helpers:",
      ...Array.from(ALLOWED_REDACT_SENSITIVE_URL_CALLSITES).map((path) => `  - ${path}`),
      "",
      "Violations:",
    ].join("\n"),
    findCallLines: findViolations,
    importMetaUrl: import.meta.url,
    sortViolations: true,
    allowCallsite: () => false,
    skipRelativePath: (relPath) => {
      if (relPath.includes(".test.") || relPath.includes(".spec.")) {
        return true;
      }
      if (relPath.includes("/test-helpers/")) {
        return true;
      }
      if (relPath.endsWith(".test-helpers.ts")) {
        return true;
      }
      if (relPath.endsWith(".d.ts")) {
        return true;
      }
      return false;
    },
  });
});
