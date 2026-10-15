import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export type PhoneModelSelection = { model: string; reasoning_effort: z.infer<typeof effortSchema>; source: 'current' | 'custom' };
export const modelSelectionSchema = {
  model_source: z.enum(['current', 'astra_low', 'custom']).default('current').describe('Default: current conversation. astra_low selects recommended gpt-6-astra + low without manual fields. MCP cannot discover its model; pass current_model and current_reasoning_effort from known session settings, never guess.'),
  current_model: z.string().min(1).max(128).optional(),
  current_reasoning_effort: effortSchema.optional(),
  model: z.string().min(1).max(128).optional(),
  reasoning_effort: effortSchema.optional(),
  model_selection_confirmed: z.boolean().default(false).describe('Only true after the user has selected these settings in the host chat, when form elicitation is unavailable. Never assume confirmation.'),
  choose_model: z.boolean().default(false).describe('Ask the user using standard MCP form elicitation before starting the phone task.'),
};
export type SelectionInput = { model_source?: 'current' | 'astra_low' | 'custom'; current_model?: string; current_reasoning_effort?: z.infer<typeof effortSchema>; model?: string; reasoning_effort?: z.infer<typeof effortSchema>; choose_model?: boolean; model_selection_confirmed?: boolean };
export type SelectionResult = { selection: PhoneModelSelection } | { state: 'MODEL_SELECTION_REQUIRED' | 'MODEL_SELECTION_CANCELLED'; message: string };

/** No global config, disk/history scraping, or inference fallback. Select before phone-side effects. */
export async function resolvePhoneModel(server: McpServer, input: SelectionInput): Promise<SelectionResult> {
  const requestedSource = input.model_source ?? 'current';
  let source: 'current' | 'custom' = requestedSource === 'current' ? 'current' : 'custom';
  let model = source === 'current' ? input.current_model : input.model;
  let effort = source === 'current' ? input.current_reasoning_effort : input.reasoning_effort;
  if (requestedSource === 'astra_low') { model = 'gpt-6-astra'; effort = 'low'; }
  if (input.choose_model || !model || !effort) {
    if (!server.server.getClientCapabilities()?.elicitation?.form) return {
      state: 'MODEL_SELECTION_REQUIRED',
      message: '尚未取得当前会话的模型与推理强度。请在聊天中确认后传 current_model/current_reasoning_effort，或选择 astra_low（Astra + 轻度，推荐），或选择 custom 并传 model/reasoning_effort；不会使用本机默认模型。当前宿主未声明 MCP 表单询问能力。',
    };
    const hasCurrent = !!input.current_model && !!input.current_reasoning_effort;
    const result = await server.server.elicitInput({ mode: 'form',
      message: hasCurrent ? `请选择手机任务模型。当前会话：${input.current_model} / ${input.current_reasoning_effort}。选择只影响此任务。`
        : 'MCP 无法自动读取当前聊天的模型与推理强度。请填写当前会话的实际设置，或选择其他模型；不会静默使用默认模型。',
      requestedSchema: { type: 'object', properties: {
        source: { type: 'string', title: '手机任务模型', oneOf: [
          { const: 'current', title: '当前会话' },
          { const: 'astra_low', title: 'Astra + 轻度（推荐）' },
          { const: 'custom', title: '其他模型' },
        ], default: requestedSource },
        model: { type: 'string', title: '模型 ID（选择推荐项时无需填写）', ...(model ? { default: model } : {}) },
        reasoning_effort: { type: 'string', title: '推理强度（推荐项固定为 low）', enum: effortSchema.options, ...(effort ? { default: effort } : {}) },
      }, required: ['source'] },
    });
    if (result.action !== 'accept') return { state: 'MODEL_SELECTION_CANCELLED', message: '已取消模型选择，未启动手机任务。' };
    const selected = z.object({ source: z.enum(['current', 'astra_low', 'custom']), model: z.string().trim().max(128).optional(), reasoning_effort: effortSchema.optional() }).parse(result.content);
    source = selected.source === 'current' ? 'current' : 'custom';
    model = selected.source === 'astra_low' ? 'gpt-6-astra' : selected.model ?? (selected.source === 'current' ? input.current_model : undefined);
    effort = selected.source === 'astra_low' ? 'low' : selected.reasoning_effort ?? (selected.source === 'current' ? input.current_reasoning_effort : undefined);
    if (!model || !effort) return { state: 'MODEL_SELECTION_REQUIRED', message: '请补充所选模型与推理强度，或选择 Astra + 轻度（推荐）；未启动手机任务。' };
  }
  return { selection: { source, model: model!, reasoning_effort: effort! } };
}

/** One selection per MCP connection; first goal asks before any phone action. */
export class PhoneModelSelector {
  private selected?: PhoneModelSelection;
  async resolve(server: McpServer, input: SelectionInput): Promise<SelectionResult> {
    const explicit = input.model_source === 'astra_low' || input.model_source === 'custom';
    if (this.selected && !input.choose_model && !explicit) return { selection: { ...this.selected } };
    const result = await resolvePhoneModel(server, {
      ...input,
      choose_model: input.choose_model || (!this.selected && !input.model_selection_confirmed),
    });
    if ('selection' in result) this.selected = { ...result.selection };
    return result;
  }
}
