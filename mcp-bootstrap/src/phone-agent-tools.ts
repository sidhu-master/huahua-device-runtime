import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResilientDeviceSession } from "./resilient-device-session.js";

/** Extensions on the existing MCP/session transport, not a new desktop client. */
export function registerPhoneAgentTools(server: McpServer, device: ResilientDeviceSession, isAttached: (id: string) => boolean = () => false) {
  server.tool("device_agent_start", "Low-level manual/diagnostic sampling entry. For ordinary phone goals use device_agent_delegate, which encapsulates native Codex inference automatically. This manual entry returns sampling context and requires per-step decisions. Do not mix it with an active automatic bridge. Keep the same request_id when retrying start.",
    { goal: z.string().min(1).max(8000), request_id: z.string().min(1).max(128) }, async args => {
      const started = await device.agentRequest("start", { ...args, inference_source: "controller" });
      return waitForRequest(device, started.agent.id);
    });
  server.tool("device_agent_next", "Read pending model sampling or final state for this phone child. Call after a transport interruption or when a prior call returned waiting. Do not replay old tool decisions.",
    { agent_id: z.string().min(1) }, async ({ agent_id }) => waitForRequest(device, agent_id));
  server.tool("device_agent_reply", "Submit one model decision for the exact pending request_id. tool_calls use the phone-provided registered schema (including exec_gui), not raw MCP device commands. Returns the next request or final state, avoiding a separate observation roundtrip. For compaction return content only. Never claim completion without current observation and task_result.", {
    agent_id: z.string().min(1), request_id: z.string().min(1),
    response: z.object({ content: z.string().max(65536).optional(),
      tool_calls: z.array(z.object({ id: z.string().min(1), type: z.literal("function"),
        function: z.object({ name: z.string().min(1), arguments: z.string().max(65536) }) })).max(16).optional(),
      needsFollowUp: z.boolean().optional() }),
  }, async ({ agent_id, request_id, response }) => {
    if (isAttached(agent_id)) throw new Error('Automatic inference bridge owns this task; use device_agent_control to steer/pause instead of submitting a manual decision.');
    await device.agentRequest("inference_submit", { agent_id, request_id, response });
    return waitForRequest(device, agent_id, request_id);
  });
  server.tool("device_agent_control", "Read, steer, pause, resume or interrupt the current phone child without raw device commands. resume request_id is required for process-restart recovery.", {
    agent_id: z.string().min(1), operation: z.enum(["read", "send", "pause", "resume", "interrupt"]),
    text: z.string().min(1).max(8000).optional(), request_id: z.string().min(1).max(128).optional(),
  }, async ({ operation, ...args }) => ({ content: [{ type: "text" as const,
    text: JSON.stringify(await device.agentRequest(operation, args)) }] }));
}

async function waitForRequest(device: ResilientDeviceSession, agentId: string, consumedRequestId?: string) {
  const deadline = Date.now() + 20_000;
  while (true) {
    const payload = await device.agentRequest("inference_read", { agent_id: agentId });
    // The phone coroutine may not have cleared its completed mailbox entry yet.
    // Never return an accepted decision as a new sampling request.
    if (consumedRequestId && payload.requests) payload.requests = payload.requests.filter((r: any) => r.requestId !== consumedRequestId);
    if (payload.requests?.length || payload.agent?.status !== "RUNNING" && payload.agent?.status !== "QUEUED" || Date.now() >= deadline) {
      return inferenceContent(payload);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Emit real MCP image blocks and omit base64 transport data from model text. */
export function inferenceContent(payload: Record<string, any>) {
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  const text = JSON.stringify(payload, (key, value) => {
    if (key === "image_url" && typeof value?.url === "string") {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value.url);
      if (!match) throw new Error("Invalid phone image evidence");
      images.push({ type: "image", mimeType: match[1], data: match[2] });
      return { evidence: `MCP image ${images.length}` };
    }
    return value;
  });
  return { content: [{ type: "text" as const, text }, ...images] };
}
