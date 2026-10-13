import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SampleInvalidated, selectInferenceProvider, type PhoneInferenceProvider } from './phone-inference-provider.js';
import { ResilientDeviceSession } from './resilient-device-session.js';
import { CodexInferenceProvider } from './codex-inference-provider.js';

export type PhoneChildState = { agent_id: string; state: string; inference_provider?: string; thread_id?: string; model?: string; summary?: string; tools: number; samples?: number; last_sample_ms?: number; last_bootstrap_ms?: number; last_model_ms?: number; last_event?: string; updated_at_ms: number };

/** Phone owns the only task loop/history. A disposable native Codex session supplies one decision. */
export class PhoneDelegation {
  private workers = new Map<string, PhoneChildState>();
  private running = new Set<string>();
  private tasks = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private device: ResilientDeviceSession, private provider: PhoneInferenceProvider = new CodexInferenceProvider()) {}
  status(agentId: string) { return this.workers.get(agentId); }
  isAttached(agentId: string) { return this.running.has(agentId); }
  async start(agentId: string): Promise<PhoneChildState> {
    if (this.disposed) throw new Error('MCP connection closed');
    if (this.running.has(agentId)) return this.workers.get(agentId)!;
    const payload = await this.device.agentRequest('read', { agent_id: agentId });
    if (payload.agent.inferenceSource !== 'controller') throw new Error('Phone task does not use controller inference');
    if (payload.agent.status !== 'RUNNING' && payload.agent.status !== 'QUEUED') throw new Error('Resume the phone task before attaching its Codex worker');
    const state: PhoneChildState = { agent_id: agentId, state: 'STARTING', inference_provider: this.provider.id, tools: 0, updated_at_ms: Date.now() };
    this.workers.set(agentId, state); this.running.add(agentId);
    const task = this.run(state, payload.agent.goal).catch(async error => {
      if (this.disposed) { state.state = 'PAUSED'; return; }
      state.state = 'FAILED'; state.summary = error instanceof Error ? error.message : 'Codex child failed';
      // Connection/model failure must not silently switch model or keep an unserved phone task running.
      try { await this.device.agentRequest('pause', { agent_id: agentId }); } catch {}
    }).finally(() => { this.running.delete(agentId); this.tasks.delete(agentId); state.updated_at_ms = Date.now(); });
    this.tasks.set(agentId, task);
    return state;
  }
  async close() {
    this.disposed = true;
    for (const id of this.running) this.provider.cancel(id);
    await Promise.allSettled([...this.running].map(agent_id => this.device.agentRequest('pause', { agent_id })));
    await Promise.allSettled([...this.tasks.values()]);
  }
  private async run(state: PhoneChildState, _goal: string) {
    const cwd = await mkdtemp(join(tmpdir(), 'huahua-codex-sample-'));
    try {
      let consumed: string | undefined;
      while (!this.disposed) {
        const payload = await this.device.agentRequest('inference_read', { agent_id: state.agent_id });
        const agent = payload.agent;
        state.updated_at_ms = Date.now();
        if (agent.status === 'PAUSED' || agent.status === 'WAITING_HUMAN') {
          // Keep the transport attached, but perform no inference until the user resumes on phone.
          state.state = agent.status; state.summary = agent.outcome?.summary;
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        if (agent.status !== 'RUNNING' && agent.status !== 'QUEUED') {
          state.state = agent.status; state.summary = agent.outcome?.summary;
          return;
        }
        const request = payload.requests?.find((r: any) => r.requestId !== consumed);
        if (!request) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
        state.state = 'RUNNING';
        const sampleStarted = Date.now();
        try {
          const decision = await this.provider.sample(request, cwd, state, async () => {
            const current = await this.device.agentRequest('inference_read', { agent_id: state.agent_id });
            return !this.disposed && current.agent.status === 'RUNNING' && current.requests?.some((r: any) => r.requestId === request.requestId);
          });
          // Read and submit remain scoped to the original authenticated host/session.
          // Steering invalidates requestId on the phone; never replay a stale decision.
          try {
            await this.device.agentRequest('inference_submit', { agent_id: state.agent_id, request_id: request.requestId, response: decision });
          } catch (error) {
            const current = await this.device.agentRequest('inference_read', { agent_id: state.agent_id });
            if (current.agent.status !== 'RUNNING' || !current.requests?.some((r: any) => r.requestId === request.requestId)) throw new SampleInvalidated('Phone rejected an invalidated decision');
            throw error;
          }
          consumed = request.requestId; state.tools += decision.tool_calls?.length ?? 0;
          state.samples = (state.samples ?? 0) + 1; state.last_sample_ms = Date.now() - sampleStarted;
        } catch (error) {
          if (!(error instanceof SampleInvalidated)) throw error;
        }
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
}

export function registerPhoneDelegationTools(server: McpServer, device: ResilientDeviceSession) {
  const delegation = new PhoneDelegation(device);
  server.tool('device_agent_inference_capabilities', 'Read actual host handshake and supported automatic inference backends. Connecting MCP tools does not imply host sampling support. No model credentials are returned.', {}, async () => {
    const host = server.server.getClientVersion();
    const capabilities = server.server.getClientCapabilities();
    let automatic: string | null = null;
    try { automatic = selectInferenceProvider(host?.name, 'auto'); } catch {}
    return { content: [{ type: 'text' as const, text: JSON.stringify({ host, supported_backends: ['codex'], automatic_backend: automatic,
      client_sampling_declared: capabilities?.sampling ?? null, generic_manual_protocol: true }) }] };
  });
  server.tool('device_agent_delegate', 'Delegate a small goal to a phone-owned child using the verified matching host inference adapter. Currently Codex is supported; other hosts must not silently borrow Codex. No main conversation is shared. Root receives only status/result. Use goal+request_id for a new task, or agent_id to attach to an already resumed controller task. Do not manually send per-step decisions while the worker is active.', {
    goal: z.string().min(1).max(8000).optional(), request_id: z.string().min(1).max(128).optional(), agent_id: z.string().min(1).optional(),
    inference_provider: z.enum(['auto', 'codex']).default('auto').describe('auto uses a verified matching host adapter; codex explicitly selects Codex, only when the user requests that backend. Never select Codex on behalf of a Claude/WorkBuddy user.'),
  }, async ({ goal, request_id, agent_id, inference_provider }) => {
    selectInferenceProvider(server.server.getClientVersion()?.name, inference_provider);
    if (agent_id && (goal || request_id) || !agent_id && (!goal || !request_id)) throw new Error('Supply agent_id or goal+request_id');
    const id = agent_id ?? (await device.agentRequest('start', { goal, request_id, inference_source: 'controller' })).agent.id;
    return { content: [{ type: 'text' as const, text: JSON.stringify(await delegation.start(id)) }] };
  });
  server.tool('device_agent_worker_status', 'Read compact phone inference bridge status/outcome; never returns its screen, tool history or model sampling context.', { agent_id: z.string().min(1) }, async ({ agent_id }) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(delegation.status(agent_id) ?? { agent_id, state: 'NOT_ATTACHED' }) }],
  }));
  return delegation;
}
