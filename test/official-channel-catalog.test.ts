import fs from "node:fs";
import path from "node:path";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialChannelCatalog,
  OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH,
  writeOfficialChannelCatalog,
} from "../scripts/write-official-channel-catalog.mjs";
import { describePluginInstallSource } from "../src/plugins/install-source-info.js";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("buildOfficialChannelCatalog", () => {
  it("includes publishable official channel plugins and skips non-publishable entries", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-");
    writeJson(path.join(repoRoot, "extensions", "whatsapp", "package.json"), {
      name: "@openclaw/whatsapp",
      version: "2026.3.23",
      description: "OpenClaw WhatsApp channel plugin",
      openclaw: {
        channel: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp (QR link)",
          detailLabel: "WhatsApp Web",
          docsPath: "/channels/whatsapp",
          blurb: "works with your own number; recommend a separate phone + eSIM.",
        },
        install: {
          npmSpec: "@openclaw/whatsapp",
          localPath: bundledPluginRoot("whatsapp"),
          defaultChoice: "npm",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    writeJson(path.join(repoRoot, "extensions", "local-only", "package.json"), {
      name: "@openclaw/local-only",
      openclaw: {
        channel: {
          id: "local-only",
          label: "Local Only",
          selectionLabel: "Local Only",
          docsPath: "/channels/local-only",
          blurb: "dev only",
        },
        install: {
          localPath: bundledPluginRoot("local-only"),
        },
        release: {
          publishToNpm: false,
        },
      },
    });

    expect(buildOfficialChannelCatalog({ repoRoot }).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@dingtalk-real-ai/dingtalk-connector",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "dingtalk-connector",
              label: "DingTalk",
            }),
            install: {
              npmSpec: "@dingtalk-real-ai/dingtalk-connector@0.8.7",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-Anv+cTITBLMcl0hMk9pn7Z5/bKJjK8zPh1jufVUm5doODp9/MiWe99igb/EDtRfFcAtnSIdH7XrNSq7+ip6h3w==",
            },
          }),
        }),
        expect.objectContaining({
          name: "@larksuite/openclaw-lark",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "openclaw-lark",
              label: "Lark",
            }),
            install: {
              npmSpec: "@larksuite/openclaw-lark@2026.4.7",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-oiS7hHwJpoOQCHjgAT2xPTO9zmmUKEje2kgsYC+Q8ZMu0gn/sI+FE2NYnQ3dVcgqw7z+2rdajgcTP6kkisFxNw==",
            },
          }),
        }),
        expect.objectContaining({
          name: "@tencent-connect/openclaw-qqbot",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "qqbot",
              label: "QQ Bot",
            }),
            install: {
              npmSpec: "@tencent-connect/openclaw-qqbot@1.7.1",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-h7rQFxsDpfBIQG8eGkQixSdSQB05eqF9waCWo8bKI/5K+v53dh+jiJr8va1pqVIpCTYPXFw0VaVNfOtlnjE/DQ==",
            },
          }),
        }),
        expect.objectContaining({
          name: "@tencent-weixin/openclaw-weixin",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "openclaw-weixin",
              label: "Weixin",
            }),
            install: {
              npmSpec: "@tencent-weixin/openclaw-weixin@2.1.7",
              defaultChoice: "npm",
              minHostVersion: ">=2026.3.22",
              expectedIntegrity:
                "sha512-2x5/mbO2IVAsN4aUA41g6i8O84WIJCeFj8kwmB2pGjuxIBVy5FnEI5n52Pc5xroOLbxzW5FXN4cDtc/PvvKghg==",
            },
          }),
        }),
        expect.objectContaining({
          name: "@wecom/wecom-openclaw-plugin",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "wecom",
              label: "WeCom",
            }),
            install: {
              npmSpec: "@wecom/wecom-openclaw-plugin@2026.4.8",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-bGbS8493sHT34FAYaugep2OLjb4dvYfLXMSfZguK/4s8i5PM//2iy4XPUsniacl8LNSUxiF/FuQGM/LJxNwrFg==",
            },
          }),
        }),
        expect.objectContaining({
          name: "@wecode-ai/weibo-openclaw-plugin",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "weibo",
              label: "Weibo",
            }),
            install: {
              npmSpec: "@wecode-ai/weibo-openclaw-plugin@2.2.0",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-nNBk+QVNm41z6p1WjhJ6LKJ6+bmMtXxLeKjTpb5uHkvCLNS1WpoXf3wO+58accBy/ByvuVBt9XGI1/HsHH4UZA==",
            },
          }),
        }),
        expect.objectContaining({
          name: "openclaw-xiaodu",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "xiaodu",
              label: "Xiaodu",
            }),
            install: {
              npmSpec: "openclaw-xiaodu@0.0.18",
              defaultChoice: "npm",
              minHostVersion: ">=2026.4.5",
              expectedIntegrity:
                "sha512-Usbh/kiRKOFXe2kaCMuJPZRnupmSVZJZGGvvcUP5fPJUhGTylAO17coyef7yIcfcT59XJWObWk9XJgn8T8dwUA==",
            },
          }),
        }),
        expect.objectContaining({
          name: "openclaw-plugin-yuanbao",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "openclaw-plugin-yuanbao",
              label: "Yuanbao",
            }),
            install: {
              npmSpec: "openclaw-plugin-yuanbao@2.11.0",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-lYmBrU71ox3v7dzRqaltvzTXPcMjjgYrNqpBj5HIBkXgEFkXRRG8wplXg9Fub41/FjsSPn3WAbYpdTc+k+jsHg==",
            },
          }),
        }),
        {
          name: "@openclaw/whatsapp",
          version: "2026.3.23",
          description: "OpenClaw WhatsApp channel plugin",
          openclaw: {
            channel: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp (QR link)",
              detailLabel: "WhatsApp Web",
              docsPath: "/channels/whatsapp",
              blurb: "works with your own number; recommend a separate phone + eSIM.",
            },
            install: {
              npmSpec: "@openclaw/whatsapp",
              defaultChoice: "npm",
            },
          },
        },
      ]),
    );
  });

  it("keeps official external catalog npm sources exactly pinned", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-policy-");
    const entries = buildOfficialChannelCatalog({ repoRoot }).entries.filter(
      (entry) => entry.source === "external",
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const installSource = describePluginInstallSource(entry.openclaw?.install ?? {});
      expect(installSource.warnings).toEqual([]);
      expect(installSource.npm?.pinState).toBe("exact-with-integrity");
    }
  });

  it("writes the official catalog under dist", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-write-");
    writeJson(path.join(repoRoot, "extensions", "whatsapp", "package.json"), {
      name: "@openclaw/whatsapp",
      openclaw: {
        channel: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "wa",
        },
        install: {
          npmSpec: "@openclaw/whatsapp",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    writeOfficialChannelCatalog({ repoRoot });

    const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8")).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@dingtalk-real-ai/dingtalk-connector",
        }),
        expect.objectContaining({
          name: "@larksuite/openclaw-lark",
        }),
        expect.objectContaining({
          name: "@tencent-connect/openclaw-qqbot",
        }),
        expect.objectContaining({
          name: "@tencent-weixin/openclaw-weixin",
        }),
        expect.objectContaining({
          name: "@wecom/wecom-openclaw-plugin",
        }),
        expect.objectContaining({
          name: "@wecode-ai/weibo-openclaw-plugin",
        }),
        expect.objectContaining({
          name: "openclaw-xiaodu",
        }),
        expect.objectContaining({
          name: "openclaw-plugin-yuanbao",
        }),
        {
          name: "@openclaw/whatsapp",
          openclaw: {
            channel: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp",
              docsPath: "/channels/whatsapp",
              blurb: "wa",
            },
            install: {
              npmSpec: "@openclaw/whatsapp",
            },
          },
        },
      ]),
    );
  });
});
