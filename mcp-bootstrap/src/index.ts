import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeviceCommandResponse, DeviceObservation, DeviceSession, HuahuaLanClient } from "./client.js";
import { ActionRequiresFreshObservationError, ResilientDeviceSession } from "./resilient-device-session.js";
import { TrustedSessionHeartbeat } from "./trusted-session-heartbeat.js";

type SessionResumer = { resume(deviceId: string): Promise<DeviceSession> };

export async function startMcp(session: DeviceSession, client = new HuahuaLanClient(), sessions?: SessionResumer): Promise<void> {
  const device = new ResilientDeviceSession(session, sessions, client);
  const heartbeat = new TrustedSessionHeartbeat(device);
  const server = new McpServer({ name: "huahua-device-agent", version: "0.1.0" });
  server.tool("device_status", "Read the local HuAHua phone agent connection state.", {}, async () => {
    const current = device.current;
    const health = await client.health(current.card);
    return { content: [{ type: "text", text: JSON.stringify({ device: current.card.displayName, host_id: current.hostId, session_expires_at_ms: current.expiresAtMs, health }) }] };
  });
  server.tool("device_session", "Read the approved local device session metadata. This never reveals the access token.", { detail: z.boolean().optional() }, async () => {
    const current = device.current;
    return { content: [{ type: "text", text: JSON.stringify({ device: current.card.displayName, endpoint: current.card.endpoint, expires_at_ms: current.expiresAtMs }) }] };
  });
  server.tool("device_observe", "Read the current approved HuAHua phone screen before choosing the next action.", {}, async () => ({ content: observationContent(await device.observe()) }));
  server.tool("device_tap", "Tap a coordinate only after observing the current approved HuAHua phone screen.", actionSchema({ x: z.number().int(), y: z.number().int() }), async ({ x, y, step_summary, observation_id }) => commandResult(device, { action: "tap", x, y, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_swipe", "Swipe only after observing the current approved HuAHua phone screen.", actionSchema({ x: z.number().int(), y: z.number().int(), endX: z.number().int(), endY: z.number().int() }), async ({ x, y, endX, endY, step_summary, observation_id }) => commandResult(device, { action: "swipe", x, y, endX, endY, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_back", "Press Back only after observing the current approved HuAHua phone screen.", actionSchema({}), async ({ step_summary, observation_id }) => commandResult(device, { action: "back", stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_home", "Go Home only after observing the current approved HuAHua phone screen.", actionSchema({}), async ({ step_summary, observation_id }) => commandResult(device, { action: "home", stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_launch_app", "Launch an installed Android package only after observing the current approved HuAHua phone screen.", actionSchema({ packageName: z.string().min(1) }), async ({ packageName, step_summary, observation_id }) => commandResult(device, { action: "launch", packageName, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_input_text", "Input ordinary non-sensitive text into the currently focused field. Passwords, verification codes, payments, and confirmations stay on the phone.", actionSchema({ text: z.string().min(1).max(4096) }), async ({ text, step_summary, observation_id }) => commandResult(device, { action: "input_text", text, stepSummary: step_summary, expectedObservationId: observation_id }));
  heartbeat.start();
  try {
    await server.connect(new StdioServerTransport());
  } finally {
    heartbeat.stop();
  }
}

function actionSchema<T extends z.ZodRawShape>(shape: T): T & { step_summary: z.ZodString; observation_id: z.ZodString } {
  return {
    ...shape,
    step_summary: z.string().min(1).max(120),
    observation_id: z.string().min(1),
  } as T & { step_summary: z.ZodString; observation_id: z.ZodString };
}

function observationContent(observation: DeviceObservation) {
  return [
    { type: "image" as const, data: observation.imageBase64, mimeType: observation.imageMimeType },
    { type: "text" as const, text: JSON.stringify({ observation_id: observation.id, foreground_app: observation.foregroundApp, screen_width: observation.screenWidth, screen_height: observation.screenHeight, captured_at_ms: observation.capturedAtMs }) },
  ];
}

function commandContent(response: DeviceCommandResponse) {
  const content = [{ type: "text" as const, text: JSON.stringify({ outcome: response.outcome, detail: response.detail }) }];
  return response.observation ? [...content, ...observationContent(response.observation)] : content;
}

async function commandResult(device: ResilientDeviceSession, input: Parameters<ResilientDeviceSession["command"]>[0]) {
  try {
    return { content: commandContent(await device.command(input)) };
  } catch (error) {
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
