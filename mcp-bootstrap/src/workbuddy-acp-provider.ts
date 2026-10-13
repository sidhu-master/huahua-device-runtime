import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { inferenceContent } from './phone-agent-tools.js';
import { SampleInvalidated, type PhoneInferenceProvider } from './phone-inference-provider.js';
import type { PhoneChildState } from './phone-delegation.js';

/** Experimental Tencent ACP adapter. Requires a normally authenticated CodeBuddy CLI;
 * it does not extract WorkBuddy desktop credentials or fall back to Codex.
 * One disposable session captures a decision; Android alone executes the tool.
 */
export class WorkBuddyAcpProvider implements PhoneInferenceProvider {
  readonly id = 'workbuddy-acp';
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(private command = 'codebuddy', private args: string[] = []) {}
  cancel(agentId: string) { this.children.get(agentId)?.kill(); }
  async sample(request: any, cwd: string, state: PhoneChildState, isCurrent: () => Promise<boolean>): Promise<any> {
    const policy = 'Supply exactly one decision for the Android-owned agent loop using only registered delegated phone tools. The supplied phone history is authoritative. Do not execute actions, inspect host files, start agents, or inherit other conversations. After selecting a tool this disposable session ends. For compaction return a text summary without tools.';
    const child = spawn(this.command, [...this.args, '--acp', '--tools', 'DelegateTool', '--effort', 'low', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', policy], { cwd, stdio: 'pipe' });
    this.children.set(state.agent_id, child);
    const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
    let sequence = 0, settled = false, text = '', sessionId: string | undefined;
    let finish!: (x: any) => void, fail!: (e: Error) => void;
    const result = new Promise<any>((resolve, reject) => {
      finish = x => { if (!settled) { settled = true; resolve(x); } };
      fail = e => { if (!settled) { settled = true; reject(e); } };
    });
    void result.catch(() => {});
    const send = (x: any) => child.stdin.write(JSON.stringify(x) + '\n');
    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params });
    });
    const tools = request.purpose === 'compaction' ? [] : request.tools ?? [];
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      // Tencent CLI may prepend terminal title OSC and heartbeat NUL even on pipes.
      const clean = line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x00/g, '');
      let message: any; try { message = JSON.parse(clean); } catch { return; }
      if (!message.method && message.id !== undefined) {
        const waiter = pending.get(message.id); pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message)); else waiter?.resolve(message.result);
        return;
      }
      const p = message.params;
      if (message.method === 'session/update' && p.sessionId === sessionId) {
        state.last_event = p.update.sessionUpdate;
        const meta = p.update._meta ?? {};
        if (meta['codebuddy.ai/responseModelId']) state.model = meta['codebuddy.ai/responseModelId'];
        else if (meta['codebuddy.ai/requestModelName']) state.model = meta['codebuddy.ai/requestModelName'];
        if (p.update.sessionUpdate === 'agent_message_chunk' && p.update.content?.type === 'text') text += p.update.content.text;
      }
      if (message.id === undefined) return;
      if (message.method === '_codebuddy.ai/delegateTool' && !settled && tools.some((t: any) => t.function.name === p.toolId)) {
        finish({ tool_calls: [{ id: p.toolCallId, type: 'function', function: { name: p.toolId, arguments: JSON.stringify(p.input) } }] });
        // Deliberately leave the tool pending until process shutdown: no second desktop turn.
      } else if (message.method === 'session/request_permission') {
        // Delegate calls only choose a decision. Native execution/handoff stay on Android.
        const raw = p.toolCall?.rawInput;
        const id = raw?.toolId;
        const permitted = tools.some((t: any) => t.function.name === id);
        const option = p.options.find((o: any) => o.kind === (permitted ? 'allow_once' : 'reject_once'));
        send({ jsonrpc: '2.0', id: message.id, result: option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } } });
      } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Host actions are not available in phone sampling' } });
    });
    const failed = (e: Error) => { fail(e); for (const p of pending.values()) p.reject(e); pending.clear(); };
    child.on('error', failed); child.stdin.on('error', failed);
    child.on('exit', () => failed(new Error('Tencent ACP inference process exited')));
    child.stderr.resume(); // Never log credentials, full phone context, or model reasoning.
    const timer = setTimeout(() => failed(new Error('Tencent ACP sample timed out')), Math.max(1, Math.min(120000, (request.deadlineAtMs ?? Date.now() + 120000) - Date.now() - 1000)));
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || settled) return; checking = true;
      void isCurrent().then(current => { if (!current) failed(new SampleInvalidated('Phone sample invalidated')); }).catch(failed).finally(() => { checking = false; });
    }, 500);
    try {
      state.last_event = 'acp/initialize';
      const initialized = await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'huahua-phone-inference', version: '1' }, clientCapabilities: {} });
      if (!initialized.agentCapabilities?.delegateToolsSupport || !initialized.agentCapabilities?.promptCapabilities?.image) throw new Error('Tencent ACP lacks image/delegated tool support');
      state.last_event = 'acp/session/new';
      const session = await rpc('session/new', { cwd, mcpServers: [] });
      sessionId = session.sessionId; state.thread_id = sessionId;
      state.last_event = 'acp/register_tools';
      if (tools.length) await rpc('_codebuddy.ai/delegateToolsChanged', { sessionId, changeType: 'added', providerId: sessionId,
        tools: tools.map((t: any) => ({ id: t.function.name, name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters, requiresApproval: false })) });
      const { tools: _schemas, ...context } = request;
      const prompt = inferenceContent({ request: context }).content.map((c: any) => c.type === 'image' ? { type: 'image', data: c.data, mimeType: c.mimeType } : c);
      void rpc('session/prompt', { sessionId, prompt }).then(response => {
        if (settled) return;
        if (response.stopReason === 'end_turn' && text.trim()) finish({ content: text });
        else fail(new Error('Tencent ACP returned no phone decision'));
      }).catch(fail);
      return await result;
    } finally {
      clearTimeout(timer); clearInterval(monitor); lines.close();
      child.kill(); this.children.delete(state.agent_id);
      failed(new Error('Tencent ACP sample closed'));
    }
  }
}
