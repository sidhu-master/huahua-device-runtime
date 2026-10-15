import { inferenceContent } from './phone-agent-tools.js';
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function withoutTrees(value: any): any {
  if (typeof value === 'string' && /(?:^|\n)(?:system|developer|user|assistant|tool): /.test(value)) {
    return value.split(/\n(?=(?:system|developer|user|assistant|tool): )/).map(part => {
      const split = part.indexOf(': ');
      if (split < 0) return part;
      return part.slice(0, split + 2) + withoutTrees(part.slice(split + 2));
    }).join('\n');
  }
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try { return JSON.stringify(withoutTrees(JSON.parse(value))); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(withoutTrees);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'ui_tree' ? null : withoutTrees(v)]));
}
/** Transport correlation/deadline fields never belong in model context or its cache prefix. */
export function phoneSampleContext(request: any) {
  const evidence = inferenceContent({ purpose: request.purpose, messages: request.messages ?? [] });
  const input = evidence.content.map((item: any) => item.type === 'image'
    ? { type: 'image', url: `data:${item.mimeType};base64,${item.data}` }
    : { type: 'text', text: item.text, text_elements: [] });
  const textBytes = input.filter(i => i.type === 'text').reduce((n, i) => n + Buffer.byteLength(i.text!), 0);
  const modelContext = JSON.parse(input.find(i => i.type === 'text')!.text!);
  const breakdown = { prompt: 0, ui_tree: 0, state_receipts: 0, user_task: 0, history_checkpoint: 0, image_markers: 0, envelope: 0 };
  for (const message of modelContext.messages) {
    const size = bytes(message);
    const hasTrees = JSON.stringify(message).includes('ui_tree');
    const treeSize = hasTrees ? Math.max(0, size - bytes(withoutTrees(message))) : 0;
    breakdown.ui_tree += treeSize;
    const rest = size - treeSize;
    if (['system', 'developer'].includes(message.role)) breakdown.prompt += rest;
    else if (['assistant', 'tool'].includes(message.role) || hasTrees || message.contextKind === 'gui.observation') breakdown.state_receipts += rest;
    else if (typeof message.content === 'string' && message.content.startsWith('Context checkpoint summary')) breakdown.history_checkpoint += rest;
    else if (Array.isArray(message.content) || /^\[历史.*(?:图片|截图)|^当前屏幕视觉证据/.test(message.content ?? '')) breakdown.image_markers += rest;
    else breakdown.user_task += rest;
  }
  breakdown.envelope = textBytes - Object.values(breakdown).reduce((a, b) => a + b, 0);
  const imageCount = input.filter(i => i.type === 'image').length;
  return { input, stats: { message_count: request.messages?.length ?? 0, text_bytes: textBytes,
    image_count: imageCount, tools_bytes: bytes(request.tools ?? []), category_bytes: breakdown,
    image_budget_tokens: imageCount * 1844, estimate_method: 'UTF8_bytes_div4; images=Codex_resized_budget; not_provider_category_billing' } };
}
