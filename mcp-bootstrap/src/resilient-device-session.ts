import { DeviceCommandInput, DeviceCommandResponse, DeviceObservation, DeviceSession, HuahuaLanClient } from "./client.js";

type SessionResumer = {
  resume(deviceId: string): Promise<DeviceSession>;
};

type DeviceClient = Pick<HuahuaLanClient, "observe" | "command">;

/** Returned after transport recovery when repeating the original action would be unsafe. */
export class ActionRequiresFreshObservationError extends Error {
  constructor() {
    super("手机的局域网地址已变化，连接已恢复。为避免重复操作，未再次执行该动作；请先观察当前页面，再决定下一步。");
    this.name = "ActionRequiresFreshObservationError";
  }
}

/**
 * Keeps a trusted device session usable across a DHCP address change.
 * Observations are safe to retry once. Actions are deliberately never replayed.
 */
export class ResilientDeviceSession {
  private recovery: Promise<DeviceSession> | undefined;

  constructor(
    private session: DeviceSession,
    private readonly sessions: SessionResumer | undefined,
    private readonly client: DeviceClient = new HuahuaLanClient(),
    private readonly nowMs: () => number = Date.now,
  ) {}

  get current(): DeviceSession {
    return this.session;
  }

  async observe(): Promise<DeviceObservation> {
    await this.refreshBeforeExpiry();
    try {
      return await this.client.observe(this.session);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      return this.client.observe(this.session);
    }
  }

  async command(input: DeviceCommandInput): Promise<DeviceCommandResponse> {
    await this.refreshBeforeExpiry();
    try {
      return await this.client.command(this.session, input);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      throw new ActionRequiresFreshObservationError();
    }
  }

  private async recoverAfterTransportFailure(error: unknown): Promise<void> {
    if (!isRecoverableSessionFailure(error)) throw error;
    await this.resumeTrustedSession();
  }

  private async refreshBeforeExpiry(): Promise<void> {
    if (this.session.expiresAtMs > this.nowMs() + SESSION_RENEWAL_WINDOW_MS) return;
    await this.resumeTrustedSession();
  }

  private async resumeTrustedSession(): Promise<void> {
    const deviceId = this.session.card.deviceId;
    if (!deviceId || !this.sessions) {
      throw new Error("当前短期控制会话无法续连，请在手机中重新连接。");
    }
    const pending = this.recovery ?? this.sessions.resume(deviceId);
    this.recovery = pending;
    try {
      this.session = await pending;
    } finally {
      if (this.recovery === pending) this.recovery = undefined;
    }
  }
}

const SESSION_RENEWAL_WINDOW_MS = 60_000;

function isRecoverableSessionFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /fetch failed|network|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|此电脑未获手机授权或授权已被撤销/i.test(error.message);
}
