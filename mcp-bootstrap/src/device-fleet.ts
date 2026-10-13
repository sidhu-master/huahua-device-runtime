import { DeviceProfileStore, type DeviceProfile } from './device-profile-store.js';
import { DeviceSessionManager } from './device-session-manager.js';
import { ResilientDeviceSession } from './resilient-device-session.js';
import { HuahuaLanClient } from './client.js';
import { TrustedSessionHeartbeat } from './trusted-session-heartbeat.js';
import { phoneControlState } from './phone-control-state.js';

/** Device identity, never a mutable globally selected phone. */
export class DeviceFleet {
  private closed = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private entries = new Map<string, { device: ResilientDeviceSession; heartbeat: TrustedSessionHeartbeat }>();
  constructor(private profiles = new DeviceProfileStore(), private sessions = new DeviceSessionManager(), private client = new HuahuaLanClient()) {}
  list(): Promise<DeviceProfile[]> { return this.profiles.list(); }
  async start(): Promise<void> {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.refresh().catch(() => {}), 30_000);
    this.refreshTimer.unref?.();
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      const profiles = await this.list();
      if (this.closed) return;
      const ids = new Set(profiles.map(p => p.deviceId));
      for (const [id, entry] of this.entries) if (!ids.has(id)) {
        entry.heartbeat.stop(); this.entries.delete(id);
      }
      await Promise.allSettled(profiles.map(p => this.get(p.deviceId)));
    } finally { this.refreshing = false; }
  }
  async get(id?: string): Promise<ResilientDeviceSession> {
    const profiles = await this.list();
    if (this.closed) throw new Error('Device fleet is closed');
    if (!id) {
      if (profiles.length !== 1) throw new Error('请使用 device_list 并明确指定 device_id；不能猜测目标手机。');
      id = profiles[0].deviceId;
    }
    if (!profiles.some(p => p.deviceId === id)) throw new Error('Unknown or unpaired device_id');
    let entry = this.entries.get(id);
    if (!entry) {
      const device = ResilientDeviceSession.forTrustedDevice(id, this.sessions, this.client);
      const heartbeat = new TrustedSessionHeartbeat(device);
      entry = { device, heartbeat }; this.entries.set(id, entry); heartbeat.start();
    }
    return entry.device;
  }
  async status(id: string) {
    const device = await this.get(id);
    try { await device.heartbeat(); const health = await this.client.health(device.current.card);
      return { device_id: id, ...phoneControlState(health), checked_at_ms: Date.now() }; }
    catch { return { device_id: id, state: 'unavailable', checked_at_ms: Date.now() }; }
  }
  close() { this.closed = true; if (this.refreshTimer) clearInterval(this.refreshTimer); for (const entry of this.entries.values()) entry.heartbeat.stop(); }
}
