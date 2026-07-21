#!/usr/bin/env node
import { runDirectCliCommand } from "./cli-command-runner.js";
import { DeviceSessionManager } from "./device-session-manager.js";
import { resolveHostDisplayName } from "./host-display-name.js";
import { startMcp } from "./index.js";

const [, , command, ...argumentsList] = process.argv;
const sessions = new DeviceSessionManager();

try {
  if (command === "connect" && argumentsList[0]) {
    await startMcp(await sessions.pair(argumentsList[0], resolveHostDisplayName({ configuredName: process.env.HUAHUA_HOST_NAME })), undefined, sessions);
  } else if (command === "serve" && argumentsList[0] === "--device" && argumentsList[1]) {
    await startMcp(await sessions.resume(argumentsList[1]), undefined, sessions);
  } else if (command === "pair" || command === "observe" || command === "command") {
    await runDirectCliCommand([command, ...argumentsList], { sessions });
  } else {
    throw new Error("用法：huahua-mcp connect <连接卡>；huahua-mcp serve --device <设备 ID>；或 huahua pair / observe / command。");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "HuAHua 命令执行失败。");
  process.exitCode = 2;
}
