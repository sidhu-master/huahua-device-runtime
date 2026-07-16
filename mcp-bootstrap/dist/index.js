import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HuahuaLanClient } from "./client.js";
export async function startMcp(session, client = new HuahuaLanClient()) {
    const server = new McpServer({ name: "huahua-device-agent", version: "0.1.0" });
    server.tool("device_status", "Read the local HuAHua phone agent connection state.", {}, async () => {
        const health = await client.health(session.card);
        return { content: [{ type: "text", text: JSON.stringify({ device: session.card.displayName, host_id: session.hostId, session_expires_at_ms: session.expiresAtMs, health }) }] };
    });
    server.tool("device_session", "Read the approved local device session metadata. This never reveals the access token.", { detail: z.boolean().optional() }, async () => ({
        content: [{ type: "text", text: JSON.stringify({ device: session.card.displayName, endpoint: session.card.endpoint, expires_at_ms: session.expiresAtMs }) }]
    }));
    await server.connect(new StdioServerTransport());
}
export { HuahuaLanClient } from "./client.js";
export { parseConnectionCard } from "./connection-card.js";
