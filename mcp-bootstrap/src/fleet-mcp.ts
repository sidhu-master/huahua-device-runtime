import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { modelSelectionSchema, PhoneModelSelector } from './phone-model-selection.js';
import { z } from 'zod';
import { DeviceFleet } from './device-fleet.js';
import { FleetTaskJournal } from './fleet-task-journal.js';
import { FleetTaskScheduler } from './fleet-task-scheduler.js';
import { selectInferenceProvider } from './phone-inference-provider.js';
import { MCP_PACKAGE_VERSION } from './package-version.js';

export async function startFleetMcp(fleet = new DeviceFleet(), transport: Transport = new StdioServerTransport(), scheduler = new FleetTaskScheduler(fleet, new FleetTaskJournal())) {
  const server = new McpServer({ name: 'huahua-device-fleet', version: MCP_PACKAGE_VERSION }, {
    instructions: 'Codex 多手机入口。先 device_list，明确 device_id 后用 device_agent_delegate 派发小目标。手机持有 GUI loop 和唯一上下文，MCP 自动用独立 Codex 会话推理；主会话只规划、派发和汇总，不逐步点击、不另开桌面子代理。所有后续操作用 task_id，不能把 phone_agent_id 当作 task_id。可快速派发多台，再 device_agent_tasks 批量查询。QUEUED 不代表已经执行；RECOVERY_REQUIRED 需读取状态，再明确 resume 或 interrupt。未知/同名设备不能猜。敏感确认仍由手机用户处理。第一版仅支持 Codex。',
  });
  const modelSelector = new PhoneModelSelector();
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.tool('device_list', 'List paired phones by stable device_id. Check connectivity explicitly; cached metadata is not proof of online status.', { check_online: z.boolean().default(false) }, async ({ check_online }) => {
    const devices = await fleet.list();
    return reply({ devices: await Promise.all(devices.map(async p => ({ display_name: p.displayName,
      ...(check_online ? await fleet.status(p.deviceId) : { device_id: p.deviceId, state: 'unchecked' }),
      tasks: scheduler.list().filter(t => t.device_id === p.deviceId && !['COMPLETED','FAILED','CANCELLED'].includes(t.state)).map(t => ({ task_id: t.task_id, state: t.state })) }))) });
  });
  server.tool('device_agent_delegate', 'Queue a phone-owned GUI goal on an explicitly selected paired phone. Returns immediately; no parent conversation is sampled. Reuse request_id only for the identical goal/device.', {
    ...modelSelectionSchema,
    device_id: z.string().min(1).optional(), goal: z.string().min(1).max(8000), request_id: z.string().min(1).max(128),
  }, async (args) => {
    const { device_id, goal, request_id } = args;
    selectInferenceProvider(server.server.getClientVersion()?.name, 'auto');
    const resolved = await modelSelector.resolve(server, args);
    if (!('selection' in resolved)) return reply(resolved);
    const device = await fleet.get(device_id);
    return reply(await scheduler.delegate(device.connectionStatus.deviceId!, goal, request_id, resolved.selection));
  });
  server.tool('device_agent_worker_status', 'Read one task status/outcome; never returns phone screenshots or full model history.', { task_id: z.string().min(1) }, async ({ task_id }) => reply(scheduler.status(task_id)));
  server.tool('device_agent_tasks', 'Batch read fleet task status/results. Pass task_ids to limit output.', { task_ids: z.array(z.string().min(1)).max(100).optional() }, async ({ task_ids }) => reply({ tasks: scheduler.list(task_ids) }));
  server.tool('device_agent_control', 'Steer, pause, resume or interrupt the exact task on its bound phone. Queued cancellation does not start a phone task. Recovery checks existing task identity before attachment.', {
    ...modelSelectionSchema,
    task_id: z.string().min(1), operation: z.enum(['send','pause','resume','interrupt']), text: z.string().min(1).max(8000).optional(),
  }, async (args) => {
    const { task_id, operation, text } = args;
    if (operation === 'send' && !text) throw new Error('send requires text');
    let selection = scheduler.status(task_id).model_selection;
    if (operation === 'resume' && !selection) {
      const resolved = await modelSelector.resolve(server, args);
      if (!('selection' in resolved)) return reply(resolved);
      selection = resolved.selection;
    }
    return reply(await scheduler.control(task_id, operation, text, selection));
  });
  await scheduler.initialize();
  try { await server.connect(transport); await fleet.start?.(); }
  catch (error) { await scheduler.close(); fleet.close(); throw error; }
  const previous = transport.onclose;
  transport.onclose = () => { previous?.(); void scheduler.close().finally(() => fleet.close()).catch(() => {}); };
  return { server, scheduler, fleet };
}
