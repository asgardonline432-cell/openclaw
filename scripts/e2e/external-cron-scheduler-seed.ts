/**
 * Seed script for external-cron-scheduler E2E test.
 *
 * Creates an openclaw.json with:
 *   - Mock OpenAI provider (for cron job LLM calls)
 *   - local-external-cron-scheduler extension enabled
 *   - Cron enabled (for the internal scheduler)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";

async function main(): Promise<void> {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() || path.join(process.env.HOME || "/tmp", ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const statePath = path.join(stateDir, "external-cron-scheduler", "jobs.json");

  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // Clean up any state from prior runs
  await fs.rm(path.join(stateDir, "external-cron-scheduler"), { recursive: true, force: true });

  const config = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
          enabled: false,
        },
      },
      // Enable the internal cron scheduler so cron jobs fire
      cron: {
        enabled: true,
      },
      plugins: {
        // Load the extension from the built dist
        load: {
          paths: ["dist/extensions/local-external-cron-scheduler"],
        },
        allow: ["local-external-cron-scheduler"],
        entries: {
          "local-external-cron-scheduler": {
            enabled: true,
            config: {
              enabled: true,
              statePath,
              instanceId: "docker-e2e",
            },
          },
        },
      },
    } satisfies OpenClawConfig,
    "sk-docker-ext-cron-e2e",
  );

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      statePath,
    }) + "\n",
  );
}

await main();
