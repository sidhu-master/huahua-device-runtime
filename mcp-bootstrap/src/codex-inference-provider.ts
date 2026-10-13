import { CodexAppServer } from './codex-app-server.js';
import { samplePhoneRequest } from './codex-phone-sampler.js';
import type { PhoneChildState } from './phone-delegation.js';
import type { PhoneInferenceProvider } from './phone-inference-provider.js';

export class CodexInferenceProvider implements PhoneInferenceProvider {
  readonly id = 'codex';
  private active = new Map<string, CodexAppServer>();
  constructor(private factory: () => CodexAppServer = () => new CodexAppServer()) {}
  async sample(request: any, cwd: string, state: PhoneChildState, isCurrent: () => Promise<boolean>) {
    const codex = this.factory();
    this.active.set(state.agent_id, codex);
    try { return await samplePhoneRequest(codex, request, cwd, state, isCurrent); }
    finally { codex.close(); this.active.delete(state.agent_id); }
  }
  cancel(agentId: string) { this.active.get(agentId)?.close(); }
}
