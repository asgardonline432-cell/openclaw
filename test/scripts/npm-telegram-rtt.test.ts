import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-rtt-docker.sh");

describe("package Telegram RTT Docker E2E", () => {
  it("wires Convex credential leases through the RTT Docker harness", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("resolve_credential_source()");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE");
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")');
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_CI");
    expect(script).toContain('if [ "$credential_source" != "convex" ]; then');
    expect(script).toContain("tsx /app/scripts/e2e/npm-telegram-rtt-credentials.ts run -- bash -s");
  });
});
