import { writeFile } from "node:fs/promises";
import { DeviceCommandInput, DeviceCommandResponse, DeviceObservation, DeviceSession, HuahuaLanClient } from "./client.js";
import { DeviceSessionManager } from "./device-session-manager.js";
import { resolveHostDisplayName } from "./host-display-name.js";
import { ActionRequiresFreshObservationError, ResilientDeviceSession } from "./resilient-device-session.js";

type SessionProvider = Pick<DeviceSessionManager, "pair" | "resume">;
type DeviceClient = Pick<HuahuaLanClient, "observe" | "command">;

export type DirectCliDependencies = {
  sessions?: SessionProvider;
  client?: DeviceClient;
  writeImage?: (path: string, bytes: Uint8Array) => Promise<void>;
  write?: (value: string) => void;
  hostName?: string;
};

/** Executes one safe direct-CLI operation without starting an MCP transport. */
export async function runDirectCliCommand(argumentsList: string[], dependencies: DirectCliDependencies = {}): Promise<void> {
  const [command, ...rawArgs] = argumentsList;
  const sessions = dependencies.sessions ?? new DeviceSessionManager();
  const client = dependencies.client ?? new HuahuaLanClient();
  const write = dependencies.write ?? (value => process.stdout.write(`${value}\n`));
  const writeImage = dependencies.writeImage ?? (async (path, bytes) => writeFile(path, bytes, { mode: 0o600 }));

  if (command === "pair") {
    const card = required(rawArgs[0], "连接卡");
    const session = await sessions.pair(card, resolveHostDisplayName({
      configuredName: dependencies.hostName ?? process.env.HUAHUA_HOST_NAME,
    }));
    write(JSON.stringify({ device_id: session.card.deviceId ?? null, device_name: session.card.displayName }));
    return;
  }

  const options = parseOptions(rawArgs);
  const deviceId = required(options.get("--device"), "设备 ID");
  const session = await sessions.resume(deviceId);
  const device = new ResilientDeviceSession(session, sessions, client);
  if (command === "observe") {
    const observation = await device.observe();
    write(JSON.stringify({
      device_id: session.card.deviceId ?? deviceId,
      device_name: session.card.displayName,
      observation: await observationJson(observation, options.get("--image-file"), writeImage),
    }));
    return;
  }

  if (command === "command") {
    let result;
    try {
      result = await device.command(commandInput(options));
    } catch (error) {
      if (error instanceof ActionRequiresFreshObservationError) {
        write(JSON.stringify({ outcome: "reobserve_required", detail: error.message }));
        return;
      }
      throw error;
    }
    write(JSON.stringify({
      outcome: result.outcome,
      detail: result.detail,
      ...(result.observation ? { observation: await observationJson(result.observation, options.get("--image-file"), writeImage) } : {}),
    }));
    return;
  }

  throw new Error("用法：huahua pair <连接卡>；huahua observe --device <设备 ID> [--image-file <路径>]；或 huahua command --device <设备 ID> --action <动作> --observation-id <ID> --summary <说明>。");
}

async function observationJson(
  observation: DeviceObservation,
  imageFile: string | undefined,
  writeImage: (path: string, bytes: Uint8Array) => Promise<void>,
) {
  const image = imageFile
    ? (await writeImage(imageFile, Buffer.from(observation.imageBase64, "base64")), { image_file: imageFile })
    : { image_base64: observation.imageBase64 };
  return {
    observation_id: observation.id,
    captured_at_ms: observation.capturedAtMs,
    image_mime_type: observation.imageMimeType,
    ...image,
    foreground_app: observation.foregroundApp,
    screen_width: observation.screenWidth,
    screen_height: observation.screenHeight,
  };
}

function commandInput(options: Map<string, string>): DeviceCommandInput {
  const action = required(options.get("--action"), "动作");
  const base = {
    action,
    stepSummary: required(options.get("--summary"), "操作说明"),
    expectedObservationId: required(options.get("--observation-id"), "观察 ID"),
  };
  if (action === "tap") return { ...base, x: integer(options.get("--x"), "x"), y: integer(options.get("--y"), "y") };
  if (action === "swipe") return {
    ...base,
    x: integer(options.get("--x"), "x"), y: integer(options.get("--y"), "y"),
    endX: integer(options.get("--end-x"), "end-x"), endY: integer(options.get("--end-y"), "end-y"),
  };
  if (action === "input_text") return { ...base, text: required(options.get("--text"), "输入文本") };
  if (action === "launch") return { ...base, packageName: required(options.get("--package"), "应用包名") };
  if (action === "back" || action === "home") return base;
  throw new Error("不支持的动作。允许 tap、swipe、input_text、launch、back 或 home。");
}

function parseOptions(argumentsList: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) throw new Error("CLI 参数无效。");
    options.set(key, value);
  }
  return options;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  return normalized;
}

function integer(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label}必须是整数。`);
  return parsed;
}
