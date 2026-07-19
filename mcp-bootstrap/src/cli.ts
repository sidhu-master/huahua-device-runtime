#!/usr/bin/env node
import { HuahuaLanClient } from "./client.js";
import { parseConnectionCard } from "./connection-card.js";
import { DeviceProfileStore } from "./device-profile-store.js";
import { HostIdentityStore } from "./host-identity-store.js";
import { startMcp } from "./index.js";

const [, , command, ...argumentsList] = process.argv;

if (command === "connect" && argumentsList[0]) {
  const identity = await new HostIdentityStore().loadOrCreate();
  const client = new HuahuaLanClient();
  const card = parseConnectionCard(argumentsList[0]);
  const session = await client.connect(card, identity.hostId, process.env.HUAHUA_HOST_NAME || "AI Host", identity.publicKeySpki);
  if (card.deviceId && card.discoveryServiceType) {
    await new DeviceProfileStore().save({ deviceId: card.deviceId, displayName: card.displayName, discoveryServiceType: card.discoveryServiceType, hostId: identity.hostId });
  }
  await startMcp(session);
} else if (command === "serve" && argumentsList[0] === "--device" && argumentsList[1]) {
  const profile = await new DeviceProfileStore().load(argumentsList[1]);
  if (!profile) {
    console.error("没有找到这台手机的配置。请先在手机 HuAHua 中复制连接卡，并运行 huahua-mcp connect <连接卡>。");
    process.exit(2);
  }
  const identity = await new HostIdentityStore().loadOrCreate();
  const client = new HuahuaLanClient();
  await startMcp(await client.resume(profile, identity));
} else {
  console.error("用法：huahua-mcp connect <HuAHua 连接卡>；或 huahua-mcp serve --device <设备 ID>");
  process.exit(2);
}
