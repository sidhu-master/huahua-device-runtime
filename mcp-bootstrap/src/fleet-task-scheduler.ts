import { randomUUID } from 'node:crypto';
import { PhoneDelegation, type PhoneChildState } from './phone-delegation.js';
import { CodexInferenceProvider } from './codex-inference-provider.js';
import { SampleInvalidated, type PhoneInferenceProvider } from './phone-inference-provider.js';
import type { ResilientDeviceSession } from './resilient-device-session.js';
import type { FleetJournal } from './fleet-task-journal.js';
import { FleetInferenceLimit } from './fleet-inference-limit.js';

export type FleetTask = { task_id: string; device_id: string; request_id: string; goal: string; state: string;
  phone_agent_id?: string; summary?: string; worker?: PhoneChildState; created_at_ms: number; updated_at_ms: number };
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const suspended = new Set(['PAUSED', 'WAITING_HUMAN', 'RECOVERY_REQUIRED']);
type Devices = { get(id: string): Promise<ResilientDeviceSession> };

/** FIFO per phone; bounded active phones, never a GUI decision loop. */
export class FleetTaskScheduler {
  private tasks = new Map<string, FleetTask>();
  private bridges = new Map<string, PhoneDelegation>();
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closed = false;
  private closing?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private executions = new Set<Promise<void>>();
  private inferenceLimit: FleetInferenceLimit;
  constructor(private devices: Devices, private journal: FleetJournal, private concurrency = 2,
    private providerFactory: () => PhoneInferenceProvider = () => new CodexInferenceProvider()) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be 1..8');
    this.inferenceLimit = new FleetInferenceLimit(concurrency);
  }
  async initialize() {
    await this.journal.acquire?.();
    try {
    for (const saved of await this.journal.load()) {
      const task = { ...saved, worker: undefined };
      if (!terminal.has(task.state)) task.state = 'RECOVERY_REQUIRED';
      this.tasks.set(task.task_id, task);
    }
    await this.persist();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        for (const task of this.tasks.values()) if (!terminal.has(task.state)) task.summary = 'Fleet persistence failed; stopped for safe recovery';
        void this.close().catch(() => {});
      });
    }, 250);
    } catch (error) { await this.journal.release?.(); throw error; }
  }
  list(ids?: string[]) { return [...this.tasks.values()].filter(t => !ids || ids.includes(t.task_id)).map(t => structuredClone(t)); }
  status(id: string) { const t = this.tasks.get(id); if (!t) throw new Error('Unknown task_id'); return structuredClone(t); }
  async delegate(deviceId: string, goal: string, requestId: string) {
    return this.serial(async () => {
      if (this.closed) throw new Error('MCP connection closed');
      await this.devices.get(deviceId); // validates authorization before any task side effect
      const existing = [...this.tasks.values()].find(t => t.device_id === deviceId && t.request_id === requestId);
      if (existing) { if (existing.goal !== goal) throw new Error('request_id conflict'); return this.status(existing.task_id); }
      const now = Date.now();
      const task: FleetTask = { task_id: randomUUID(), device_id: deviceId, goal, request_id: requestId, state: 'QUEUED', created_at_ms: now, updated_at_ms: now };
      this.tasks.set(task.task_id, task);
      try { await this.persist(); } catch (error) { this.tasks.delete(task.task_id); throw error; }
      return this.status(task.task_id);
    });
  }
  async control(id: string, op: 'send'|'pause'|'resume'|'interrupt', text?: string) {
    return this.serial(async () => {
      const task = this.tasks.get(id); if (!task) throw new Error('Unknown task_id');
      if (this.closed) throw new Error('MCP connection closed');
      if (terminal.has(task.state)) throw new Error('Task already terminal');
      if (this.executions.size && task.state === 'STARTING') throw new Error('Task starting; read status before controlling');
      if (!task.phone_agent_id) {
        if (op === 'interrupt') task.state = 'CANCELLED';
        else if (op === 'pause') task.state = 'PAUSED';
        else if (op === 'resume') { task.state = 'QUEUED'; task.summary = undefined; task.worker = undefined; }
        else throw new Error('Queued task cannot accept steering; cancel and submit a new goal');
      } else {
        if (op === 'resume' && suspended.has(task.state) && [...this.tasks.values()].filter(t => t.task_id !== id && ['STARTING','RUNNING'].includes(t.state)).length >= this.concurrency) {
          throw new Error('All active phone slots are occupied; resume after another task finishes or pauses');
        }
        const device = await this.devices.get(task.device_id);
        // Recovery never invents another request ID or replays device actions.
        const read = await device.agentRequest('read', { agent_id: task.phone_agent_id });
        if (terminal.has(read.agent.status)) { task.state = read.agent.status; task.summary = read.agent.outcome?.summary; }
        else {
          const response = op === 'resume' && ['RUNNING','QUEUED'].includes(read.agent.status) ? read : await device.agentRequest(op, { agent_id: task.phone_agent_id, ...(text ? { text } : {}),
            ...(op === 'resume' ? { request_id: 'fleet-resume:' + task.task_id } : {}) });
          task.phone_agent_id = response.agent.id;
          task.state = response.agent.status;
          if (op === 'resume') task.summary = undefined;
          if (op === 'resume' && !this.bridges.has(id)) await this.attach(task, device);
        }
      }
      task.updated_at_ms = Date.now(); await this.persist(); return this.status(id);
    });
  }
  private async attach(task: FleetTask, device: ResilientDeviceSession) {
    if (this.bridges.has(task.task_id)) return;
    const bridge = new PhoneDelegation(device, this.inferenceLimit.wrap(this.providerFactory()));
    this.bridges.set(task.task_id, bridge);
    try { await bridge.start(task.phone_agent_id!); }
    catch (e) { this.bridges.delete(task.task_id); await bridge.close(); throw e; }
  }
  private async tick() {
    if (this.closed || this.ticking) return; this.ticking = true;
    try {
      let changed = false;
      for (const [id, bridge] of this.bridges) {
        const task = this.tasks.get(id)!;
        const worker = bridge.status(task.phone_agent_id!);
        if (worker) {
          const previous = JSON.stringify(task.worker);
          task.worker = structuredClone(worker);
          if (task.state !== 'CANCELLED') task.state = ['FAILED','NEEDS_REOBSERVATION'].includes(worker.state) ? 'RECOVERY_REQUIRED' : worker.state;
          task.summary = worker.summary; task.updated_at_ms = worker.updated_at_ms;
          changed ||= previous !== JSON.stringify(task.worker);
        }
        if (!bridge.isAttached(task.phone_agent_id!)) { this.bridges.delete(id); await bridge.close(); changed = true; }
      }
      if (changed) await this.persist();
      let active = [...this.tasks.values()].filter(t => !terminal.has(t.state) && !suspended.has(t.state) && t.state !== 'QUEUED').length;
      for (const task of this.tasks.values()) {
        if (active >= this.concurrency) break;
        if (task.state !== 'QUEUED' || this.busy.has(task.device_id)) continue;
        // Paused/handoff/recovery tasks retain phone exclusivity.
        if ([...this.tasks.values()].some(t => t.task_id !== task.task_id && t.device_id === task.device_id && !terminal.has(t.state) && t.state !== 'QUEUED')) continue;
        this.busy.add(task.device_id); task.state = 'STARTING'; task.summary = undefined; task.updated_at_ms = Date.now(); active++;
        try { await this.persist(); }
        catch (error) { task.state = 'RECOVERY_REQUIRED'; this.busy.delete(task.device_id); throw error; }
        const execution = this.launch(task).catch(error => { task.state = 'RECOVERY_REQUIRED'; task.summary = 'Task journal write failed; inspect phone before recovery'; })
          .finally(() => { this.busy.delete(task.device_id); this.executions.delete(execution); });
        this.executions.add(execution);
      }
    } finally { this.ticking = false; }
  }
  private async launch(task: FleetTask) {
    try {
      const device = await this.devices.get(task.device_id);
      // A previous process may have started this exact request before losing its reply.
      const list = await device.agentRequest('list', {});
      const matching = list.agents?.find((a: any) => a.requestId === task.request_id);
      if (matching && matching.goal !== task.goal) throw new Error('Phone request_id conflict');
      const other = list.agents?.find((a: any) => ['RUNNING','QUEUED','PAUSED','WAITING_HUMAN'].includes(a.status) && a.id !== matching?.id);
      if (other) { task.state = 'RECOVERY_REQUIRED'; task.summary = 'Phone has another active task; inspect or finish it before retrying'; return; }
      const agent = matching ?? (await device.agentRequest('start', { goal: task.goal, request_id: task.request_id, inference_source: 'controller' })).agent;
      task.phone_agent_id = agent.id; task.state = agent.status;
      await this.persist();
      if (!terminal.has(task.state) && (agent.status === 'RUNNING' || agent.status === 'QUEUED')) await this.attach(task, device);
      else task.summary = agent.outcome?.summary;
    } catch (e) {
      if (!terminal.has(task.state)) { task.state = 'RECOVERY_REQUIRED'; task.summary = e instanceof Error ? e.message : 'Phone unavailable'; }
    } finally { task.updated_at_ms = Date.now(); await this.persist(); }
  }
  private persist() { return this.journal.save([...this.tasks.values()].map(t => structuredClone(t))); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(fn); this.mutations = next.catch(() => {}); return next;
  }
  close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }
  private async closeOnce() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    while (this.ticking) await new Promise(r => setTimeout(r, 10));
    await this.mutations; await Promise.allSettled([...this.executions]);
    await Promise.allSettled([...this.bridges.values()].map(b => b.close()));
    for (const task of this.tasks.values()) if (!terminal.has(task.state)) task.state = 'RECOVERY_REQUIRED';
    try { await this.persist(); } finally { await this.journal.release?.(); }
  }
}
