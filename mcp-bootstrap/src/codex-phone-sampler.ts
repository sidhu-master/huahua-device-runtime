import { newSampleAudit, quotaSnapshot } from './phone-sample-audit.js';
import { inferenceFailure } from './phone-inference-error.js';
import { PhoneInferenceError } from './phone-inference-error.js';
import { CodexAppServer } from './codex-app-server.js';
import { phoneSampleContext } from './phone-sample-context.js';
import type { PhoneChildState } from './phone-delegation.js';
import { SampleInvalidated } from './phone-inference-provider.js';
export { SampleInvalidated } from './phone-inference-provider.js';

export type NativePhoneSession = { initialized: boolean; thread?: any; turnId?: string; lastQuota?: ReturnType<typeof quotaSnapshot>; serviceTier?: string; };

/** Native app-server supplies one sample; it never executes phone actions or owns task history.
 * Upstream contracts: thread/start.dynamicTools, turn/start, item/tool/call.
 */
export async function samplePhoneRequest(codex: CodexAppServer, request: any, cwd: string,
  state: PhoneChildState, isCurrent?: () => Promise<boolean>, session?: NativePhoneSession): Promise<any> {
  const audit = state.sample_audit = newSampleAudit(request.requestId, state.agent_id);
  audit.quota_before = session?.lastQuota;
  let responseUsageSeen!: () => void;
  const responseUsageArrived = new Promise<void>(resolve => { responseUsageSeen = resolve; });
  const rawUsages = new Map<string, Record<string, number>>();
  let usageSeen!: () => void;
  const usageArrived = new Promise<void>(resolve => { usageSeen = resolve; });
  let sampling = false;
  const countedUsage = new Set<string>();
  let settled = false;
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  let text = '';
  let providerInfo: unknown;
  let capturingDecision = false;
  let nativeTurnId: string | undefined;
  const bootstrapStarted = Date.now();
  let modelStarted: number | undefined;
  state.last_bootstrap_ms = undefined; state.last_model_ms = undefined; state.token_usage = undefined;
  const result = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
  void result.catch(() => {});
  const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
  const finish = (value: any) => { if (!settled) { settled = true; resolve(value); } };
  codex.onFailure = fail;
  codex.onNotification = (method, params) => {
    if (params?.threadId && params.threadId !== state.thread_id) return;
    state.last_event = method; state.updated_at_ms = Date.now();
    if (method === 'account/rateLimits/updated') { const q = quotaSnapshot(params); if (q) { if (audit.quota_events.length < 16) audit.quota_events.push(q); audit.quota_after = q; if (session) session.lastQuota = q; } }
    if (!sampling) return;
    if (method === 'turn/started') { nativeTurnId = params?.turn?.id; if (session) session.turnId = nativeTurnId; audit.turns_started++; }
    if (method === 'error') { audit.errors++; if (params?.willRetry === true) audit.retry_notifications++; }
    if (method === 'rawResponse/completed' && params?.usage && typeof params.responseId === 'string') {
      const usage = params.usage;
      rawUsages.set(params.responseId, Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].map(k => [k, Number(usage[k] ?? 0)])));
      state.token_usage = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
        .map(k => [k, [...rawUsages.values()].reduce((sum, v) => sum + v[k], 0)]));
      audit.raw_usage_updates++; audit.usage_status = 'available'; audit.usage_source = 'raw_response';
      usageSeen(); responseUsageSeen();
    }
    if (method === 'thread/tokenUsage/updated' && params?.tokenUsage?.total) {
      audit.usage_updates++; audit.usage_status = 'available'; if (!rawUsages.size) audit.usage_source = 'thread_usage'; usageSeen();
      const total = params.tokenUsage.last ?? params.tokenUsage.total;
      const key = JSON.stringify(params.tokenUsage.total);
      if (!rawUsages.size && !countedUsage.has(key)) {
        countedUsage.add(key);
        state.token_usage = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
          .map(k => [k, (state.token_usage?.[k] ?? 0) + Number(total[k] ?? 0)]));
      }
    }
    if (method === 'item/completed' && params?.item?.type === 'agentMessage') text += params.item.text ?? '';
    if (method === 'error') providerInfo = params?.error?.codexErrorInfo ?? providerInfo;
    if (method === 'turn/completed' && !capturingDecision) {
      if (modelStarted !== undefined) audit.phase_ms.model_to_decision = Date.now() - modelStarted;
      if (params.turn.status !== 'completed') fail(new PhoneInferenceError(params.turn.error?.message ?? `Codex sample ${params.turn.status}`, params.turn.error?.codexErrorInfo ?? providerInfo));
      else if (text.trim()) finish({ content: text });
      else fail(new Error('Codex returned no phone decision'));
    }
  };
  const tools = request.purpose === 'compaction' ? [] : request.tools ?? [];
  codex.onToolCall = async params => {
    if (settled || params.threadId !== state.thread_id || !tools.some((t: any) => t.function.name === params.tool)) throw new Error('Phone sample tool scope rejected');
    if (capturingDecision) throw new Error('Phone sample already captured a decision');
    capturingDecision = true; audit.tool_calls++;
    if (modelStarted !== undefined) audit.phase_ms.model_to_decision = Date.now() - modelStarted;
    // Core emits exact upstream usage at response completion, but emits TokenCount
    // only after pending tools resolve. Let the stream finish before interrupting;
    // a pending phone tool still blocks any follow-up model generation.
    const usageWaitStarted = Date.now();
    if (!rawUsages.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([responseUsageArrived, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
      if (timer) clearTimeout(timer);
    }
    audit.phase_ms.usage_wait = Date.now() - usageWaitStarted;
    const turnId = params.turnId ?? nativeTurnId;
    if (turnId) {
      // Upstream emits TokenCount after pending tools resolve, including turn interruption.
      // Interrupting supplies no invented execution output and prevents further sampling.
      const interruptStarted = Date.now();
      try { await codex.request('turn/interrupt', { threadId: state.thread_id, turnId }, 5000); } catch {}
      audit.phase_ms.interrupt = Date.now() - interruptStarted;
    }
    finish({ tool_calls: [{ id: params.callId, type: 'function', function: { name: params.tool, arguments: JSON.stringify(params.arguments) } }] });
    // Do not acknowledge a fake execution result: that would invite another model turn.
    // The provider reverts this turn before reuse; no fabricated tool result enters history.
    return new Promise<never>(() => {});
  };
  const budget = Math.max(1, Math.min(120_000, (request.deadlineAtMs ?? Date.now() + 120_000) - Date.now() - 1000));
  const timeout = setTimeout(() => fail(new Error('Codex phone sample timed out')), budget);
  let checking = false;
  const monitor = isCurrent ? setInterval(() => {
    if (checking || settled) return; checking = true;
    void isCurrent().then(current => { if (!current) fail(new SampleInvalidated('Phone sample invalidated')); })
      .catch(fail).finally(() => { checking = false; });
  }, 500) : undefined;
  try {
    // Cancellation/deadline also bound bootstrap RPCs, not only model generation.
    // Cancellation closes or deletes only the internally owned sampling session.
    if (!session?.initialized) {
      const initStarted = Date.now();
      await Promise.race([codex.initialize(), result]);
      audit.phase_ms.initialize = Date.now() - initStarted;
      if (session) session.initialized = true;
    }
    if (settled) return await result;
    // Quota RPC performs network IO. Never enqueue it on the sampling process:
    // a local timeout does not cancel the underlying network request.
    audit.service_tier = session?.serviceTier;
    if (!audit.service_tier) {
      const configStarted = Date.now();
      try { const config = await codex.request('config/read', { includeLayers: false }, 2000);
        const tier = config?.config?.service_tier;
        if (typeof tier === 'string' && /^[a-z_]{1,40}$/.test(tier)) {
          audit.service_tier = tier; if (session) session.serviceTier = tier;
        }
      } catch {}
      audit.phase_ms.config = Date.now() - configStarted;
    }
    if (settled) return await result;
    const threadStarted = Date.now();
    let thread = session?.thread;
    audit.thread_reused = !!thread;
    if (thread) {
      if (!session?.turnId) throw new Error('Missing native turn boundary; refusing to append duplicated phone history');
      // Official thread/revert drains/reloads Core with the same thread ID. Phone context
      // replaces the previous sample instead of being appended to a second agent history.
      const reverted = await Promise.race([codex.request('thread/revert', { threadId: thread.thread.id, beforeTurnId: session.turnId }), result]);
      if (settled) return await result;
      if (reverted.thread.id !== thread.thread.id) throw new Error('Codex thread identity changed during history replacement');
    } else thread = await Promise.race([codex.request('thread/start', { ...(state.model_selection ? { model: state.model_selection.model, config: { model_reasoning_effort: state.model_selection.reasoning_effort } } : {}), cwd, experimentalRawEvents: true, ephemeral: !session, ...(session ? { historyMode: 'paginated' } : {}), approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: 'You provide exactly one model decision for an Android-owned agent loop. The supplied phone messages are the complete authoritative task context and policy. Do not manage a task loop, execute actions, inspect host files, use other tools, or inherit any other conversation. Choose one registered phone tool call for the next step (exec_gui can contain a bounded short program), or a final assistant response when the phone policy permits. After choosing a tool, your sampling session ends; the phone executes it and requests the next sample. Images are real phone evidence in the order referenced in the messages. For compaction, summarize the supplied history without tools.',
      dynamicTools: tools.map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters })) }), result]);
    if (settled) return await result;
    audit.phase_ms.thread_prepare = Date.now() - threadStarted;
    if (session) session.thread = thread;
    audit.native_thread_id = thread.thread.id;
    state.thread_id = thread.thread.id; state.model = thread.model;
    state.reasoning_effort = thread.reasoningEffort;
    if (state.model_selection && thread.model !== state.model_selection.model) throw new Error('Codex 返回的模型与所选模型不一致，已停止采样。');
    if (state.model_selection && thread.reasoningEffort !== state.model_selection.reasoning_effort) throw new Error('Codex 返回的推理强度与所选强度不一致，已停止采样。');
    if (settled) return await result;
    const { input, stats } = phoneSampleContext(request);
    state.context_stats = stats;
    state.last_bootstrap_ms = Date.now() - bootstrapStarted;
    modelStarted = Date.now(); sampling = true;
    const started = await Promise.race([codex.request('turn/start', { threadId: state.thread_id, input, ...(state.model_selection ? { model: state.model_selection.model, effort: state.model_selection.reasoning_effort } : {}) }), result]);
    nativeTurnId ??= started?.turn?.id;
    return await result;
  } catch (error) {
    audit.failure_code = error instanceof SampleInvalidated ? 'invalidated' : inferenceFailure(error).code;
    throw error;
  } finally {
    clearTimeout(timeout); if (monitor) clearInterval(monitor);
    // Usage can arrive after interrupt acknowledgement. Never send a fake tool receipt.
    if (modelStarted !== undefined) {
      if (!state.token_usage) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([usageArrived, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
        if (timer) clearTimeout(timer);
      }

    }
    audit.phase_ms.sample_total = Date.now() - bootstrapStarted;
    if (session && modelStarted !== undefined) session.turnId = nativeTurnId;
    if (modelStarted !== undefined) state.last_model_ms = Date.now() - modelStarted;
    clearTimeout(timeout); if (monitor) clearInterval(monitor);
  }
}
