import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const hash = (value: unknown) => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 20) : undefined;
const code = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function window(value: any) {
  if (!value || typeof value !== 'object') return undefined;
  return { used_percent: number(value.usedPercent), duration_minutes: number(value.windowDurationMins), resets_at: number(value.resetsAt) };
}
/** Explicit allowlist: account identity is hashed; no credit payload, error body or prompt is logged. */
export function quotaSnapshot(value: any) {
  if (!value?.rateLimits && !value?.rateLimitsByLimitId) return undefined;
  const limits = value.rateLimitsByLimitId ? Object.values(value.rateLimitsByLimitId) : [value.rateLimits];
  return { at_ms: Date.now(), account_hash: hash(value.accountId), allowed: typeof value.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : undefined,
    buckets: limits.map((v: any) => ({ id: code(v?.limitId), plan: code(v?.planType), reached: code(v?.rateLimitReachedType),
      primary: window(v?.primary), secondary: window(v?.secondary) })) };
}
export function newSampleAudit(requestId: unknown, agentId: unknown) {
  return { id: randomUUID(), request_hash: hash(requestId), agent_hash: hash(agentId), started_at_ms: Date.now(),
    native_thread_id: undefined as string | undefined, thread_reused: false,
    phase_ms: {} as Record<string, number>, quota_source: 'stream_event',
    turns_started: 0, usage_updates: 0, raw_usage_updates: 0, usage_source: undefined as 'raw_response' | 'thread_usage' | undefined, errors: 0, retry_notifications: 0, tool_calls: 0,
    usage_status: 'unavailable' as 'available' | 'unavailable',
    quota_before: undefined as ReturnType<typeof quotaSnapshot>, quota_after: undefined as ReturnType<typeof quotaSnapshot>,
    quota_events: [] as NonNullable<ReturnType<typeof quotaSnapshot>>[], service_tier: undefined as string | undefined,
    failure_code: undefined as string | undefined };
}
export type PhoneSampleAudit = ReturnType<typeof newSampleAudit>;
let pending: Promise<void> = Promise.resolve();
/** Bounded per-user journal. Diagnostic IO never replays inference. */
export function appendSampleAudit(record: unknown, directory = join(homedir(), '.config', 'huahua-mcp')): Promise<void> {
  const work = pending.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'phone-sample-audit.jsonl');
    try {
      if ((await stat(file)).size > 8 * 1024 * 1024) {
        const text = await readFile(file, 'utf8'); const tail = text.slice(-4 * 1024 * 1024);
        await writeFile(file, tail.slice(tail.indexOf('\n') + 1), { mode: 0o600 });
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 }); await chmod(file, 0o600);
  });
  pending = work; return work;
}
