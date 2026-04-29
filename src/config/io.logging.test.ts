import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.js";

describe("config io warning logging", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-logging-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    clearPluginManifestRegistryCache();
  });

  afterAll(async () => {
    clearPluginManifestRegistryCache();
    await suiteRootTracker.cleanup();
  });

  it("logs write validation warnings with real line breaks", async () => {
    const home = await suiteRootTracker.make("case");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const io = createConfigIO({
      configPath,
      env: {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "0",
        OPENCLAW_TEST_FAST: "1",
        VITEST: "true",
      } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger,
    });

    await io.writeConfigFile({
      plugins: {
        entries: {
          "google-antigravity-auth": {
            enabled: true,
          },
        },
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^Config warnings:\n- /));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Config warnings:\\n"));
  });
});
