import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "./test-helpers/channel-catalog-contract.js";

describeChannelCatalogEntryContract({
  channelId: "msteams",
  npmSpec: "@openclaw/msteams",
  alias: "teams",
});

const whatsappMeta = {
  id: "whatsapp",
  label: "WhatsApp",
  selectionLabel: "WhatsApp (QR link)",
  detailLabel: "WhatsApp Web",
  docsPath: "/channels/whatsapp",
  blurb: "works with your own number; recommend a separate phone + eSIM.",
};

describeBundledMetadataOnlyChannelCatalogContract({
  pluginId: "whatsapp",
  packageName: "@openclaw/whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: whatsappMeta,
  defaultChoice: "npm",
});

describeOfficialFallbackChannelCatalogContract({
  channelId: "whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: whatsappMeta,
  packageName: "@openclaw/whatsapp",
  pluginId: "whatsapp",
  externalNpmSpec: "@vendor/whatsapp-fork",
  externalLabel: "WhatsApp Fork",
});

describeChannelCatalogEntryContract({
  channelId: "dingtalk-connector",
  npmSpec: "@dingtalk-real-ai/dingtalk-connector@0.8.7",
  alias: "dingtalk",
});

describeChannelCatalogEntryContract({
  channelId: "openclaw-lark",
  npmSpec: "@larksuite/openclaw-lark@2026.4.7",
  alias: "lark",
});

describeChannelCatalogEntryContract({
  channelId: "openclaw-weixin",
  npmSpec: "@tencent-weixin/openclaw-weixin@2.1.7",
  alias: "wechat",
});

describeChannelCatalogEntryContract({
  channelId: "wecom",
  npmSpec: "@wecom/wecom-openclaw-plugin@2026.4.8",
  alias: "wework",
});

describeChannelCatalogEntryContract({
  channelId: "weibo",
  npmSpec: "@wecode-ai/weibo-openclaw-plugin@2.2.0",
  alias: "微博",
});

describeChannelCatalogEntryContract({
  channelId: "xiaodu",
  npmSpec: "openclaw-xiaodu@0.0.18",
  alias: "小度",
});

describeChannelCatalogEntryContract({
  channelId: "openclaw-plugin-yuanbao",
  npmSpec: "openclaw-plugin-yuanbao@2.11.0",
  alias: "yb",
});
