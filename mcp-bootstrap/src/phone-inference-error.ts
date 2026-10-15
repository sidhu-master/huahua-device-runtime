export type InferenceErrorCode = 'rate_limit' | 'quota' | 'auth' | 'timeout' | 'connection' | 'model_error';
export class PhoneInferenceError extends Error {
  constructor(message: string, readonly providerInfo?: unknown) { super(message); }
}
/** Keep diagnostic codes/status only. Never expose provider response bodies, prompts or credentials. */
export function inferenceFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const info = error instanceof PhoneInferenceError ? error.providerInfo : undefined;
  const infoText = JSON.stringify(info ?? '').toLowerCase();
  let code: InferenceErrorCode = 'model_error';
  if (/usage limit|quota exceeded|insufficient_quota/.test(message.toLowerCase())) code = 'quota';
  else if (/\b429\b|too many requests|rate.?limit/.test(message.toLowerCase() + infoText)) code = 'rate_limit';
  else if (/\b401\b|unauthorized|authentication/.test(message.toLowerCase())) code = 'auth';
  else if (/timed out|timeout/.test(message.toLowerCase())) code = 'timeout';
  else if (/fetch failed|connection|app-server exited/.test(message.toLowerCase())) code = 'connection';
  const labels = {
    rate_limit: '电脑端 Codex 请求被暂时限流（429），任务已中断，请稍后重试；此状态不代表额度用完。',
    quota: '电脑端 Codex 提示用量达到上限，任务已中断，请检查电脑端用量。',
    auth: '电脑端 Codex 登录状态失效，任务已中断，请在电脑端重新登录。',
    timeout: '电脑端 Codex 推理超时，任务已中断，请稍后重试。',
    connection: '电脑端 Codex 推理连接异常，任务已中断，请检查电脑连接。',
    model_error: '电脑端 Codex 推理失败，任务已中断，请在电脑端检查错误后重试。',
  };
  const status = code === 'rate_limit' ? 429 : code === 'auth' ? 401 : undefined;
  const providerCode = typeof info === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(info) ? info :
    info && typeof info === 'object' ? Object.keys(info).find(key => /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(key)) : undefined;
  return { code, message: labels[code], http_status: status, provider_code: providerCode };
}
