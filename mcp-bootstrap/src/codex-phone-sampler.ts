import { CodexAppServer } from './codex-app-server.js';
import { inferenceContent } from './phone-agent-tools.js';
import type { PhoneChildState } from './phone-delegation.js';
import { SampleInvalidated } from './phone-inference-provider.js';
export { SampleInvalidated } from './phone-inference-provider.js';

/** Native app-server supplies one sample; it never executes phone actions or owns task history.
 * Upstream contracts: thread/start.dynamicTools, turn/start, item/tool/call.
 */
export async function samplePhoneRequest(codex: CodexAppServer, request: any, cwd: string,
  state: PhoneChildState, isCurrent?: () => Promise<boolean>): Promise<any> {
  let settled = false;
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  let text = '';
  const bootstrapStarted = Date.now();
  let modelStarted: number | undefined;
  state.last_bootstrap_ms = undefined; state.last_model_ms = undefined;
  const result = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
  void result.catch(() => {});
  const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
  const finish = (value: any) => { if (!settled) { settled = true; resolve(value); } };
  codex.onFailure = fail;
  codex.onNotification = (method, params) => {
    if (params?.threadId && params.threadId !== state.thread_id) return;
    state.last_event = method; state.updated_at_ms = Date.now();
    if (method === 'item/completed' && params?.item?.type === 'agentMessage') text += params.item.text ?? '';
    if (method === 'error') state.summary = params?.error?.message;
    if (method === 'turn/completed') {
      if (params.turn.status !== 'completed') fail(new Error(params.turn.error?.message ?? `Codex sample ${params.turn.status}`));
      else if (text.trim()) finish({ content: text });
      else fail(new Error('Codex returned no phone decision'));
    }
  };
  const tools = request.purpose === 'compaction' ? [] : request.tools ?? [];
  codex.onToolCall = async params => {
    if (settled || params.threadId !== state.thread_id || !tools.some((t: any) => t.function.name === params.tool)) throw new Error('Phone sample tool scope rejected');
    finish({ tool_calls: [{ id: params.callId, type: 'function', function: { name: params.tool, arguments: JSON.stringify(params.arguments) } }] });
    return { success: true, contentItems: [{ type: 'inputText', text: 'Decision captured. The phone alone will execute and verify it; this sampling session is finished.' }] };
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
    // The provider closes the disposable process as soon as this sample settles.
    await Promise.race([codex.initialize(), result]);
    if (settled) return await result;
    const thread = await Promise.race([codex.request('thread/start', { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: 'You provide exactly one model decision for an Android-owned agent loop. The supplied phone messages are the complete authoritative task context and policy. Do not manage a task loop, execute actions, inspect host files, use other tools, or inherit any other conversation. Choose one registered phone tool call for the next step (exec_gui can contain a bounded short program), or a final assistant response when the phone policy permits. After choosing a tool, your sampling session ends; the phone executes it and requests the next sample. Images are real phone evidence in the order referenced in the messages. For compaction, summarize the supplied history without tools.',
      dynamicTools: tools.map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters })) }), result]);
    if (settled) return await result;
    state.thread_id = thread.thread.id; state.model = thread.model;
    if (settled) return await result;
    // Tool schemas are native dynamic tools already; avoid duplicating them in the user payload.
    const { tools: _schemas, ...context } = request;
    const evidence = inferenceContent({ request: context });
    const input = evidence.content.map((item: any) => item.type === 'image'
      ? { type: 'image', url: `data:${item.mimeType};base64,${item.data}` }
      : { type: 'text', text: item.text, text_elements: [] });
    state.last_bootstrap_ms = Date.now() - bootstrapStarted;
    modelStarted = Date.now();
    await Promise.race([codex.request('turn/start', { threadId: state.thread_id, input }), result]);
    return await result;
  } finally {
    if (modelStarted !== undefined) state.last_model_ms = Date.now() - modelStarted;
    clearTimeout(timeout); if (monitor) clearInterval(monitor);
  }
}
