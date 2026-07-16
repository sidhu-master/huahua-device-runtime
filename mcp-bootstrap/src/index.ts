import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeviceSession, HuahuaLanClient } from "./client.js";

export async function startMcp(session: DeviceSession, client = new HuahuaLanClient()): Promise<void> {
  const server = new McpServer({ name: "huahua-device-agent", version: "0.1.0" });
  server.tool("device_status", "Read the local HuAHua phone agent connection state.", {}, async () => {
    const health = await client.health(session.card);
    return { content: [{ type: "text", text: JSON.stringify({ device: session.card.displayName, host_id: session.hostId, session_expires_at_ms: session.expiresAtMs, health }) }] };
  });
  server.tool("device_session", "Read the approved local device session metadata. This never reveals the access token.", { detail: z.boolean().optional() }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ device: session.card.displayName, endpoint: session.card.endpoint, expires_at_ms: session.expiresAtMs }) }]
  }));
  server.tool("device_tap", "Tap a coordinate on the approved HuAHua phone.", { x: z.number().int(), y: z.number().int() }, async ({ x, y }) => ({ content: [{ type: "text", text: JSON.stringify(await client.command(session, { action: "tap", x, y })) }] }));
  server.tool("device_swipe", "Swipe on the approved HuAHua phone.", { x: z.number().int(), y: z.number().int(), endX: z.number().int(), endY: z.number().int() }, async args => ({ content: [{ type: "text", text: JSON.stringify(await client.command(session, { action: "swipe", ...args })) }] }));
  server.tool("device_back", "Press Back on the approved HuAHua phone.", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await client.command(session, { action: "back" })) }] }));
  server.tool("device_home", "Go Home on the approved HuAHua phone.", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await client.command(session, { action: "home" })) }] }));
  server.tool("device_launch_app", "Launch an installed Android package on the approved HuAHua phone.", { packageName: z.string().min(1) }, async ({ packageName }) => ({ content: [{ type: "text", text: JSON.stringify(await client.command(session, { action: "launch", packageName })) }] }));
  await server.connect(new StdioServerTransport());
}

export { HuahuaLanClient } from "./client.js";
export { parseConnectionCard } from "./connection-card.js";
