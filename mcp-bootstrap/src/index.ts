import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_PACKAGE_VERSION } from "./package-version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeviceCommandResponse, DeviceObservation, DeviceSession, DeviceStopError, HuahuaLanClient } from "./client.js";
import { ActionRequiresFreshObservationError, ResilientDeviceSession } from "./resilient-device-session.js";
import { attachTrustedSessionHeartbeatToTransport, TrustedSessionHeartbeat } from "./trusted-session-heartbeat.js";
import { phoneControlState } from "./phone-control-state.js";

type SessionResumer = { resume(deviceId: string): Promise<DeviceSession> };

export async function startMcp(session: DeviceSession, client = new HuahuaLanClient(), sessions?: SessionResumer): Promise<void> {
  const device = new ResilientDeviceSession(session, sessions, client);
  await startMcpWithDevice(device, client);
}

/** Starts stdio immediately, then lets heartbeat-based discovery restore an existing pairing. */
export async function startMcpForTrustedDevice(
  deviceId: string,
  sessions: SessionResumer,
  client = new HuahuaLanClient(),
): Promise<void> {
  const device = ResilientDeviceSession.forTrustedDevice(deviceId, sessions, client);
  await startMcpWithDevice(device, client);
}

async function startMcpWithDevice(device: ResilientDeviceSession, client: HuahuaLanClient): Promise<void> {
  const heartbeat = new TrustedSessionHeartbeat(device);
  const server = new McpServer({ name: "huahua-device-agent", version: MCP_PACKAGE_VERSION });
  server.tool("device_status", "Read the local HuAHua phone agent connection state.", {}, async () => {
    const status = device.connectionStatus;
    if (status.state !== "connected") {
      return { content: [{ type: "text", text: JSON.stringify({ state: "reconnecting", device_id: status.deviceId, detail: "正在通过局域网查找已配对手机；手机端可点击重新连接以刷新发现。" }) }] };
    }
    const current = device.current;
    const health = await client.health(current.card);
    const control = phoneControlState(health);
    const voiceCommand = await heartbeat.fetchVoiceCommandNow();
    const payload: Record<string, unknown> = { ...control, device: current.card.displayName, host_id: current.hostId, session_expires_at_ms: current.expiresAtMs, health };
    if (voiceCommand) payload.pending_voice_command = voiceCommand;
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  });
  server.tool("device_session", "Read the approved local device session metadata. This never reveals the access token.", { detail: z.boolean().optional() }, async () => {
    const current = device.current;
    return { content: [{ type: "text", text: JSON.stringify({ device: current.card.displayName, endpoint: current.card.endpoint, expires_at_ms: current.expiresAtMs }) }] };
  });
  server.tool("device_observe", "Read the current approved HuAHua phone screen before choosing the next action. Coordinates are always normalized from 0 to 1000 over this exact visual input.", {}, async () => {
    try {
      const readiness = phoneControlState(await client.health(device.current.card));
      if (readiness.state !== "connected") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(readiness) }],
          isError: true,
        };
      }
      const observation = await device.observe();
      const voiceCommand = await heartbeat.fetchVoiceCommandNow();
      const content = observationContent(observation);
      if (voiceCommand) {
        content.push({ type: "text" as const, text: JSON.stringify({ pending_voice_command: voiceCommand }) });
      }
      return { content };
    } catch (error) {
      if (error instanceof DeviceStopError) {
        const voiceCommand = await heartbeat.fetchVoiceCommandNow();
        const payload: Record<string, unknown> = { outcome: "stopped", detail: "用户已在手机端停止任务，请立即停止当前操作。" };
        if (voiceCommand) {
          payload.pending_voice_command = voiceCommand;
          payload.instruction = "用户发送了新的语音命令，请将其作为新命令立即执行。";
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
      }
      throw error;
    }
  });
  server.tool("device_tap", "Tap a normalized 0–1000 coordinate only after observing. If visual_layout is before_current, only the right CURRENT half (x >= 500) is actionable.", actionSchema({ x: normalizedCoordinate(), y: normalizedCoordinate() }), async ({ x, y, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "tap", x, y, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_tap_element", "Tap an interactive ui_tree ref returned by the current observation. Prefer this when the intended element has an unambiguous ref.", actionSchema({ ref: z.string().min(1) }), async ({ ref, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "tap_element", targetRef: ref, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_swipe", "Swipe using normalized 0–1000 coordinates only after observing. On a before_current frame, both endpoints must be on CURRENT (x >= 500).", actionSchema({ x: normalizedCoordinate(), y: normalizedCoordinate(), endX: normalizedCoordinate(), endY: normalizedCoordinate() }), async ({ x, y, endX, endY, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "swipe", x, y, endX, endY, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_back", "Press Back only after observing the current approved HuAHua phone screen.", actionSchema({}), async ({ step_summary, observation_id }) => commandResult(device, heartbeat, { action: "back", stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_home", "Go Home only after observing the current approved HuAHua phone screen.", actionSchema({}), async ({ step_summary, observation_id }) => commandResult(device, heartbeat, { action: "home", stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_launch_app", "Launch an installed Android package only after observing the current approved HuAHua phone screen.", actionSchema({ packageName: z.string().min(1) }), async ({ packageName, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "launch", packageName, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_input_text", "Input ordinary non-sensitive text into the currently focused field. Passwords, verification codes, payments, and confirmations stay on the phone.", actionSchema({ text: z.string().min(1).max(4096) }), async ({ text, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "input_text", text, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_task_complete", "After you have verified the user's requested phone task is complete, call this exactly once before giving your final answer. This changes the HuAHua phone overlay to ‘任务已完成’ and removes its stop control.", { summary: z.string().min(1).max(240) }, async ({ summary }) => {
    await device.complete(summary);
    const vc = await heartbeat.fetchVoiceCommandNow();
    const cp: Record<string, unknown> = { outcome: "completed", detail: "手机端已显示任务已完成。" }; if (vc) cp.pending_voice_command = vc; return { content: [{ type: "text", text: JSON.stringify(cp) }] };
  });
  const transport = new StdioServerTransport();
  attachTrustedSessionHeartbeatToTransport(heartbeat, transport);
  await server.connect(transport);
}

function actionSchema<T extends z.ZodRawShape>(shape: T): T & { step_summary: z.ZodString; observation_id: z.ZodString } {
  return {
    ...shape,
    step_summary: z.string().min(1).max(120),
    observation_id: z.string().min(1),
  } as T & { step_summary: z.ZodString; observation_id: z.ZodString };
}

function normalizedCoordinate() {
  return z.number().int().min(0).max(1000);
}

function observationContent(observation: DeviceObservation) {
  return [
    { type: "image" as const, data: observation.imageBase64, mimeType: observation.imageMimeType },
    {
      type: "text" as const,
      text: JSON.stringify({
        observation_id: observation.id,
        foreground_app: observation.foregroundApp,
        captured_at_ms: observation.capturedAtMs,
        coordinate_space: observation.coordinateSpace,
        visual_layout: observation.visualLayout,
        ui_tree_status: observation.uiTreeStatus,
        ui_tree_reason_code: observation.uiTreeReasonCode,
        ui_tree: observation.uiTree,
      }),
    },
  ];
}

function commandContent(response: DeviceCommandResponse) {
  const content = [{ type: "text" as const, text: JSON.stringify({ outcome: response.outcome, detail: response.detail }) }];
  return response.observation ? [...content, ...observationContent(response.observation)] : content;
}

async function commandResult(device: ResilientDeviceSession, heartbeat: TrustedSessionHeartbeat, input: Parameters<ResilientDeviceSession["command"]>[0]) {
  try {
    return { content: commandContent(await device.command(input)) };
  } catch (error) {
    if (error instanceof DeviceStopError) {
      const voiceCommand = await heartbeat.fetchVoiceCommandNow();
      const payload: Record<string, unknown> = { outcome: "stopped", detail: "用户已在手机端停止任务，请立即停止当前操作。" };
      if (voiceCommand) {
        payload.pending_voice_command = voiceCommand;
        payload.instruction = "用户发送了新的语音命令，请将其作为新命令立即执行。";
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
    }
    if (error instanceof ActionRequiresFreshObservationError) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ outcome: "reobserve_required", detail: error.message }) }] };
    }
    throw error;
  }
}

export { HuahuaLanClient } from "./client.js";
export { parseConnectionCard } from "./connection-card.js";
export { resolveHostDisplayName } from "./host-display-name.js";
export { HostIdentityStore } from "./host-identity-store.js";
export { DeviceProfileStore } from "./device-profile-store.js";
export { DeviceSessionManager } from "./device-session-manager.js";
export { ActionRequiresFreshObservationError, ResilientDeviceSession } from "./resilient-device-session.js";
export { TrustedSessionHeartbeat } from "./trusted-session-heartbeat.js";
export { phoneControlState } from "./phone-control-state.js";
