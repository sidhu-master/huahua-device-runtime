import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_PACKAGE_VERSION } from "./package-version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { DeviceCommandResponse, DeviceObservation, DeviceSession, DeviceStopError, HuahuaLanClient } from "./client.js";
import { ActionRequiresFreshObservationError, ResilientDeviceSession } from "./resilient-device-session.js";
import { attachTrustedSessionHeartbeatToTransport, TrustedSessionHeartbeat } from "./trusted-session-heartbeat.js";
import { registerPhoneDelegationTools } from "./phone-delegation.js";
import { registerPhoneAgentTools } from "./phone-agent-tools.js";
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

/** Builds the persistent MCP server on the supplied transport. */
export async function startMcpWithDevice(
  device: ResilientDeviceSession,
  client: HuahuaLanClient,
  transport: Transport = new StdioServerTransport(),
): Promise<void> {
  const heartbeat = new TrustedSessionHeartbeat(device);
  const server = new McpServer(
    { name: "huahua-device-agent", version: MCP_PACKAGE_VERSION },
    {
      instructions: "手机操作只能通过本常驻 MCP 完成。用 device_agent_inference_capabilities 查看宿主握手和已适配推理后端。已适配宿主的普通目标使用 device_agent_delegate，将小目标交给手机子 agent；手机持有唯一 loop/历史，MCP 用匹配的宿主推理适配提供决策。目前已验证后端只有 Codex，不得在 Claude/WorkBuddy 或未知客户端下擅自指定 inference_provider=codex 来绕过未适配错误，除非用户明确选择该后端。主会话用 device_agent_worker_status 查询结果，device_agent_control 用于引导、暂停、恢复或取消；暂停保留挂接，恢复自动继续。不要混用手动决策或旧直接动作工具。device_agent_start/next/reply 是通用手动采样协议，客户端自行用独立子任务模型处理时可用，但不能与自动桥混用。旧 device_task_start/device_* 只用于明确要求的直接控制诊断，复用动作返回的 observation_id，语义不足时用 device_observe_visual。",
    },
  );
  const delegation = registerPhoneDelegationTools(server, device);
  registerPhoneAgentTools(server, device, id => delegation.isAttached(id));
  heartbeat.onControlEvent(event => {
    void server.sendLoggingMessage({
      level: event.type === "control_paused" || event.type === "task_paused" ? "warning" : "info",
      logger: "huahua-device-agent",
      data: event,
    }).catch(() => undefined);
  });
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
    const controlEvents = heartbeat.consumeControlEvents();
    if (controlEvents.length) payload.control_events = controlEvents;
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  });
  server.tool("device_session", "Read the approved local device session metadata. This never reveals the access token.", { detail: z.boolean().optional() }, async () => {
    const current = device.current;
    return { content: [{ type: "text", text: JSON.stringify({ device: current.card.displayName, endpoint: current.card.endpoint, expires_at_ms: current.expiresAtMs }) }] };
  });
  server.tool(
    "device_wait_ready",
    "Wait for HuAHua to finish phone-side control preparation. Call this after pairing; do not request a screenshot while it is waiting.",
    { timeout_seconds: z.number().int().min(5).max(300).optional() },
    async ({ timeout_seconds }) => {
      const initial = phoneControlState(await client.health(device.current.card));
      if (initial.state === "connected") {
        return { content: [{ type: "text", text: JSON.stringify(initial) }] };
      }
      await heartbeat.waitForPhoneControlReady((timeout_seconds ?? 120) * 1_000);
      const current = phoneControlState(await client.health(device.current.card));
      return {
        content: [{ type: "text", text: JSON.stringify(current) }],
        ...(current.state === "connected" ? {} : { isError: true }),
      };
    },
  );
  server.tool(
    "device_task_start",
    "Start one phone-control task and return its first fresh observation. Copy the user's complete original request verbatim. Call exactly once per task; do not call device_observe next when this result already contains an observation.",
    { original_user_command: z.string().min(1).max(500) },
    async ({ original_user_command }) => {
      await device.startTask(original_user_command);
      const content: ReturnType<typeof observationContent> = [{
        type: "text" as const,
        text: JSON.stringify({ outcome: "started", detail: "手机端已记录用户的原始命令。" }),
      }];
      try {
        content.push(...observationContent(await device.observe()));
      } catch {
        content[0] = {
          type: "text",
          text: JSON.stringify({
            outcome: "started",
            detail: "手机端已记录用户的原始命令，但首个观察暂未返回。",
            next_action: "device_observe",
          }),
        };
      }
      return {
        content,
      };
    },
  );
  server.tool("device_observe", "Read a fresh semantic phone observation only when no current observation is available or a previous result requires re-observation. Successful actions already return the next observation. Use current semantic refs for device_tap_element; request visual evidence explicitly only when required.", {}, async () => {
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
      const controlEvents = heartbeat.consumeControlEvents();
      if (controlEvents.length) {
        content.push({ type: "text" as const, text: JSON.stringify({ control_events: controlEvents }) });
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
  server.tool("device_observe_visual", "Request exactly one current visual evidence image. Use only when the semantic tree is unavailable, the UI is self-drawn, layout meaning is ambiguous, or visual verification is necessary; it is not the default control payload.", {}, async () => {
    const readiness = phoneControlState(await client.health(device.current.card));
    if (readiness.state !== "connected") {
      return { content: [{ type: "text" as const, text: JSON.stringify(readiness) }], isError: true };
    }
    const observation = await device.observe(true);
    return { content: observationContent(observation, true) };
  });
  server.tool("device_tap", "Tap a normalized 0–1000 coordinate only after observing. Use visual coordinates only after explicit visual evidence; otherwise prefer an unambiguous current semantic ref.", actionSchema({ x: normalizedCoordinate(), y: normalizedCoordinate() }), async ({ x, y, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "tap", x, y, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_tap_element", "Tap an actionable ref from the current Android semantic snapshot or diff. Prefer this when the intended current ref is unambiguous; stale refs require a fresh observation.", actionSchema({ ref: z.string().min(1) }), async ({ ref, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "tap_element", targetRef: ref, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_swipe", "Swipe using normalized 0–1000 coordinates only after observing explicit visual evidence.", actionSchema({ x: normalizedCoordinate(), y: normalizedCoordinate(), endX: normalizedCoordinate(), endY: normalizedCoordinate() }), async ({ x, y, endX, endY, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "swipe", x, y, endX, endY, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_back", "Press Back only after observing the current approved HuAHua phone screen.", actionSchema({}), async ({ step_summary, observation_id }) => commandResult(device, heartbeat, { action: "back", stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_home", "Go Home only after observing the current approved HuAHua phone screen.", actionSchema({}), async ({ step_summary, observation_id }) => commandResult(device, heartbeat, { action: "home", stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_launch_app", "Launch an installed Android package only after observing the current approved HuAHua phone screen.", actionSchema({ packageName: z.string().min(1) }), async ({ packageName, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "launch", packageName, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_input_text", "Input ordinary non-sensitive text into the currently focused field. Passwords, verification codes, payments, and confirmations stay on the phone.", actionSchema({ text: z.string().min(1).max(4096) }), async ({ text, step_summary, observation_id }) => commandResult(device, heartbeat, { action: "input_text", text, stepSummary: step_summary, expectedObservationId: observation_id }));
  server.tool("device_task_complete", "After you have verified the user's requested phone task is complete, call this exactly once before giving your final answer. This changes the HuAHua phone overlay to ‘任务已完成’ and removes its stop control.", { summary: z.string().min(1).max(240) }, async ({ summary }) => {
    await device.complete(summary);
    const vc = await heartbeat.fetchVoiceCommandNow();
    const cp: Record<string, unknown> = { outcome: "completed", detail: "手机端已显示任务已完成。" }; if (vc) cp.pending_voice_command = vc; return { content: [{ type: "text", text: JSON.stringify(cp) }] };
  });
  attachTrustedSessionHeartbeatToTransport(heartbeat, transport);
  const previousClose = transport.onclose;
  transport.onclose = () => { previousClose?.(); void delegation.close(); };
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

function observationContent(observation: DeviceObservation, includeVisual = false) {
  const visual = includeVisual ? requiredVisualEvidence(observation) : undefined;
  const payload: Record<string, unknown> = {
    observation_id: observation.id,
    foreground_app: observation.foregroundApp,
    captured_at_ms: observation.capturedAtMs,
    ui_tree_status: observation.uiTreeStatus,
    ...(observation.uiTreeReasonCode ? { ui_tree_reason_code: observation.uiTreeReasonCode } : {}),
    ...(observation.semanticSnapshot ? { semantic_snapshot: observation.semanticSnapshot } : {}),
    ...(observation.semanticDiff ? { semantic_diff: observation.semanticDiff } : {}),
    ...(visual ? { coordinate_space: visual.coordinateSpace, visual_layout: visual.visualLayout } : {}),
    ...(observation.visualFallbackRequired ? {
      visual_fallback_required: true,
      ...(observation.visualFallbackReasonCode ? { visual_fallback_reason_code: observation.visualFallbackReasonCode } : {}),
      next_action: "device_observe_visual",
    } : {}),
  };
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: JSON.stringify(payload) },
  ];
  if (!visual) return content;
  content.push({ type: "image" as const, data: visual.imageBase64, mimeType: visual.imageMimeType });
  return content;
}

function requiredVisualEvidence(observation: DeviceObservation) {
  if (!observation.imageBase64 || !observation.imageMimeType || !observation.coordinateSpace || !observation.visualLayout) {
    throw new Error("手机未返回视觉证据；请稍后重新调用 device_observe_visual。");
  }
  return {
    imageBase64: observation.imageBase64,
    imageMimeType: observation.imageMimeType,
    coordinateSpace: observation.coordinateSpace,
    visualLayout: observation.visualLayout,
  };
}

function commandContent(response: DeviceCommandResponse) {
  const content = [{ type: "text" as const, text: JSON.stringify({ outcome: response.outcome, detail: response.detail }) }];
  if (response.observation) return [...content, ...observationContent(response.observation)];
  if (response.outcome === "succeeded") {
    return [...content, { type: "text" as const, text: JSON.stringify({ next_action: "device_observe", detail: "动作回执未附带当前观察；请先读取当前语义页面再继续。" }) }];
  }
  if (response.outcome === "handoff_required") {
    return [...content, { type: "text" as const, text: JSON.stringify({ next_action: "human_handoff", terminal: true, detail: "请让用户在手机上手动完成当前步骤；不要继续读取或操作设备。" }) }];
  }
  return [...content, { type: "text" as const, text: JSON.stringify({ next_action: "stop", terminal: true, detail: "当前操作未完成且未返回观察；请停止自动操作。" }) }];
}

async function commandResult(device: ResilientDeviceSession, heartbeat: TrustedSessionHeartbeat, input: Parameters<ResilientDeviceSession["command"]>[0]) {
  try {
    const content = commandContent(await device.command(input));
    const controlEvents = heartbeat.consumeControlEvents();
    if (controlEvents.length) content.push({ type: "text" as const, text: JSON.stringify({ control_events: controlEvents }) });
    return { content };
  } catch (error) {
    if (error instanceof DeviceStopError) {
      const voiceCommand = await heartbeat.fetchVoiceCommandNow();
      const payload: Record<string, unknown> = { outcome: "stopped", next_action: "stop", terminal: true, detail: "用户已在手机端停止任务，请立即停止当前操作。" };
      if (voiceCommand) {
        payload.pending_voice_command = voiceCommand;
        payload.instruction = "用户发送了新的语音命令，请将其作为新命令立即执行。";
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
    }
    if (error instanceof ActionRequiresFreshObservationError) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ outcome: "reobserve_required", next_action: "device_observe", detail: error.message }) }] };
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
export { startFleetMcp } from "./fleet-mcp.js";
export { DeviceFleet } from "./device-fleet.js";
export { FleetTaskScheduler } from "./fleet-task-scheduler.js";
