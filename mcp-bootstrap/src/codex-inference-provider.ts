import { createHash } from 'node:crypto';
import { CodexAppServer } from './codex-app-server.js';
import { samplePhoneRequest, type NativePhoneSession, SampleInvalidated } from './codex-phone-sampler.js';
import type { PhoneChildState } from './phone-delegation.js';
import type { PhoneInferenceProvider } from './phone-inference-provider.js';

type Session = { codex: CodexAppServer; native: NativePhoneSession; signature: string; busy: boolean; disposing?: Promise<void> };

/** Reuse one native GUI/compaction session per phone child, with phone-owned history replacement. */
export class CodexInferenceProvider implements PhoneInferenceProvider {
  readonly id = 'codex';
  private sessions = new Map<string, Map<string, Session>>();
  constructor(private factory: () => CodexAppServer = () => new CodexAppServer()) {}
  async sample(request: any, cwd: string, state: PhoneChildState, isCurrent: () => Promise<boolean>) {
    const purpose = request.purpose === 'compaction' ? 'compaction' : 'gui';
    const signature = createHash('sha256').update(JSON.stringify([state.model_selection, purpose === 'gui' ? request.tools : []])).digest('hex');
    let group = this.sessions.get(state.agent_id);
    if (!group) { group = new Map(); this.sessions.set(state.agent_id, group); }
    let session = group.get(purpose);
    if (session?.busy) throw new Error('Concurrent sampling for the same phone child is not allowed');
    if (session && session.signature !== signature) { group.delete(purpose); await this.dispose(session); session = undefined; }
    if (!session) { session = { codex: this.factory(), native: { initialized: false }, signature, busy: false }; group.set(purpose, session); }
    session.busy = true;
    try { return await samplePhoneRequest(session.codex, request, cwd, state, isCurrent, session.native); }
    catch (error) { if (group.get(purpose) === session) group.delete(purpose); await this.dispose(session); throw error; }
    finally { session.busy = false; }
  }
  cancel(agentId: string) {
    const group = this.sessions.get(agentId); this.sessions.delete(agentId);
    for (const session of group?.values() ?? []) {
      if (session.busy) session.codex.onFailure(new SampleInvalidated('Phone inference session closed'));
      void this.dispose(session);
    }
  }
  private dispose(session: Session): Promise<void> {
    if (session.disposing) return session.disposing;
    session.disposing = (async () => {
      const threadId = session.native.thread?.thread.id;
      try {
        if (threadId && session.busy && session.native.turnId) {
          try { await session.codex.request('turn/interrupt', { threadId, turnId: session.native.turnId }, 2000); } catch {}
        }
        // Delete only this internally created transport thread, never the user's Codex chat.
        if (threadId) { try { await session.codex.request('thread/delete', { threadId }, 3000); } catch {} }
      } finally { session.codex.close(); }
    })();
    return session.disposing;
  }
}
