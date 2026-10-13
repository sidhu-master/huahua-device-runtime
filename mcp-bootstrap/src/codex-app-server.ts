import { MCP_PACKAGE_VERSION } from './package-version.js';
import { spawn, execFileSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { homedir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';

/** JSONL transport for the upstream app-server protocol, not another agent loop.
 * Source: codex-rs/app-server-protocol/{protocol/common.rs,protocol/v2/thread.rs,item.rs,turn.rs}.
 */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private failure?: Error;
  private closed = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onNotification: (method: string, params: any) => void = () => {};
  onToolCall: (params: any) => Promise<any> = async () => { throw new Error('No phone tool handler'); };
  onFailure: (error: Error) => void = () => {};

  constructor(binary = resolveCodexBinary()) {
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://',
      '-c', 'features.shell_tool=false',
      '-c', 'features.multi_agent=false',
      '-c', 'features.plugins=false',
      '-c', 'features.apps=false',
      '-c', 'features.recommended_plugins=false',
      '-c', 'mcp_servers={}',
      ...isolatedMcpOverrides(), '-c', 'web_search="disabled"'], { stdio: 'pipe', env: codexEnvironment() });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try { void this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Invalid Codex app-server protocol')); }
    });
    // Drain stderr; provider tokens, page content and prompts are never written to host logs.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new Error('未找到本机 Codex 程序；请先安装 Codex。无需配置模型 URL 或 API key。') : error));
    this.child.on('exit', () => this.fail(new Error('Codex app-server exited')));
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'huahua-phone-child', title: 'HuAHua phone child', version: MCP_PACKAGE_VERSION }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  request(method: string, params: any, timeoutMs = 30_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private send(message: any) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  private async receive(message: any) {
    if (message.method && message.id !== undefined) {
      if (message.method !== 'item/tool/call') {
        this.send({ id: message.id, error: { code: -32601, message: 'Phone child only accepts registered phone tools' } });
        return;
      }
      try { this.send({ id: message.id, result: await this.onToolCall(message.params) }); }
      catch (error) { this.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Phone tool failed' }] } }); }
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? 'Codex RPC rejected'));
      else request.resolve(message.result);
    } else if (message.method) this.onNotification(message.method, message.params);
  }
  private fail(error: Error) {
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.onFailure(error);
  }
  close() { if (this.closed) return; this.closed = true; this.onFailure = () => {}; this.child.kill(); this.fail(new Error('Codex child closed')); }
}

/** Prefer an installed CLI; discover desktop bundles without changing user configuration. */
export function resolveCodexBinary(env = process.env, platform = process.platform, exists = existsSync): string {
  if (env.HUAHUA_CODEX_BINARY) return env.HUAHUA_CODEX_BINARY;
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const path of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(path, executable);
    if (exists(candidate)) return candidate;
  }
  if (platform === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')]) {
      for (const app of ['Codex.app', 'ChatGPT.app']) {
        const candidate = join(root, app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
        if (exists(candidate)) return candidate;
      }
    }
  }
  return 'codex';
}

/** CLI processes do not inherit macOS system proxy preferences. Preserve explicit env overrides. */
function codexEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform !== 'darwin' || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return env;
  try {
    const settings = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1000 });
    const proxy = systemHttpsProxy(settings);
    if (proxy) env.HTTPS_PROXY = proxy;
  } catch { /* No system proxy: retain normal Codex networking and fallback. */ }
  return env;
}
export function systemHttpsProxy(settings: string): string | undefined {
  if (!/^\s*HTTPSEnable\s*:\s*1\s*$/m.test(settings)) return undefined;
  const host = settings.match(/^\s*HTTPSProxy\s*:\s*([\w.:-]+)\s*$/m)?.[1];
  const port = Number(settings.match(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m)?.[1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** Disable inherited MCP tools only for the disposable sample process. Never edit user config. */
export function disabledMcpOverrides(configs: string[]): string[] {
  const names = new Set<string>();
  for (const text of configs) {
    const config = parse(text);
    for (const name of Object.keys(config.mcp_servers ?? {})) names.add(name);
  }
  if (!names.size) return [];
  // Override the table value, not dotted CLI keys: server names may themselves contain dots.
  const entries = [...names].map(name => `${JSON.stringify(name)} = { enabled = false }`);
  return ['-c', `mcp_servers = { ${entries.join(', ')} }`];
}
function isolatedMcpOverrides(): string[] {
  const files = new Set([join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')]);
  let directory = process.cwd();
  for (;;) {
    files.add(join(directory, '.codex', 'config.toml'));
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  try { return disabledMcpOverrides([...files].filter(existsSync).map(file => readFileSync(file, 'utf8'))); }
  catch { throw new Error('无法读取 Codex 配置并隔离手机推理工具；未修改用户配置。'); }
}
