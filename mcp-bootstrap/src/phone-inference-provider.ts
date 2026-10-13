import type { PhoneChildState } from './phone-delegation.js';

export class SampleInvalidated extends Error {}

/** Host-specific inference is separate from the phone loop and authenticated MCP transport. */
export interface PhoneInferenceProvider {
  readonly id: string;
  sample(request: any, cwd: string, state: PhoneChildState, isCurrent: () => Promise<boolean>): Promise<any>;
  cancel(agentId: string): void;
}

export function selectInferenceProvider(clientName: string | undefined, requested: 'auto' | 'codex'): 'codex' {
  if (requested === 'codex') return 'codex';
  if (clientName && /^codex(?:\b|[-_ ])/i.test(clientName)) return 'codex';
  throw new Error(`当前客户端 ${clientName || 'unknown'} 尚未适配自动宿主推理；不会自动借用 Codex。当前已验证后端为 Codex。仅在用户明确选择 Codex 后端时指定 inference_provider=codex；否则使用通用手动协议或等待该客户端适配。`);
}
