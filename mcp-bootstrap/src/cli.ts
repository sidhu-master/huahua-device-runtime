#!/usr/bin/env node
import { DeviceSessionManager } from "./device-session-manager.js";
import { resolveHostDisplayName } from "./host-display-name.js";
import { startMcp, startMcpForTrustedDevice } from "./index.js";
import { prepareHost } from "./prepare-host.js";
import { startFleetMcp } from "./fleet-mcp.js";

const [, , command, ...argumentsList] = process.argv;
const sessions = new DeviceSessionManager();

try {
  if (command === "serve" && (argumentsList.length === 0 || (argumentsList[0] === "--fleet" && argumentsList.length === 1))) {
    await startFleetMcp();
  } else if (command === "connect" && argumentsList[0]) {
    await startMcp(await sessions.pair(argumentsList[0], resolveHostDisplayName({ configuredName: process.env.HUAHUA_HOST_NAME })), undefined, sessions);
  } else if (command === "serve" && argumentsList[0] === "--device" && argumentsList[1]) {
    await startMcpForTrustedDevice(argumentsList[1], sessions);
  } else if (command === "prepare" && argumentsList.length === 0) {
    await prepareHost({ sessions });
  } else if (["pair", "status", "task-start", "observe", "command", "task-complete"].includes(command ?? "")) {
    throw new Error("手机操作只支持通过常驻 MCP 工具执行；请配置并启动 connect 或 serve，不支持一次性 CLI 操作。");
  } else {
    throw new Error("用法：huahua prepare；huahua connect <连接卡>；huahua serve --device <设备 ID>；或 huahua serve（默认多设备）。手机操作只支持通过常驻 MCP 工具执行。");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "HuAHua 命令执行失败。");
  process.exitCode = 2;
}
