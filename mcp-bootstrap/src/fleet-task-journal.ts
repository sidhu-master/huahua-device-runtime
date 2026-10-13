import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { FleetTask } from './fleet-task-scheduler.js';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';

export interface FleetJournal { load(): Promise<FleetTask[]>; save(tasks: FleetTask[]): Promise<void>; acquire?(): Promise<void>; release?(): Promise<void> }
/** Routing and authored goals only. No credentials, observations or model history. */
export class FleetTaskJournal implements FleetJournal {
  private writing: Promise<void> = Promise.resolve();
  private lease?: Server;
  constructor(private path = join(homedir(), '.config', 'huahua-mcp', 'fleet-tasks.json')) {}
  /** Kernel-owned lease is automatically released after a crash; no stale lock files. */
  async acquire(): Promise<void> {
    if (this.lease) throw new Error('Fleet journal already in use');
    const port = 45000 + createHash('sha256').update(this.path).digest().readUInt16BE(0) % 15000;
    const lease = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      lease.once('error', () => reject(new Error('Fleet journal is in use by another MCP process (or its local lease port is occupied)')));
      lease.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
    });
    this.lease = lease;
  }
  async release(): Promise<void> {
    const lease = this.lease; this.lease = undefined;
    if (lease) await new Promise<void>(resolve => lease.close(() => resolve()));
  }
  async load(): Promise<FleetTask[]> {
    try {
      const rows = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(rows) || rows.some(t => !t.task_id || !t.device_id || !t.request_id || !t.goal || !t.state)) throw new Error('Invalid fleet task journal');
      return rows;
    } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  }
  save(tasks: FleetTask[]): Promise<void> {
    const body = JSON.stringify(tasks);
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = this.path + '.tmp';
      await writeFile(temp, body, { mode: 0o600 }); await chmod(temp, 0o600);
      await rename(temp, this.path);
    });
    this.writing = next.catch(() => {}); return next;
  }
}
