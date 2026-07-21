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
  ) {}

  get current(): DeviceSession {
    return this.session;
  }

  async observe(): Promise<DeviceObservation> {
    try {
      return await this.client.observe(this.session);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      return this.client.observe(this.session);
    }
  }

  async command(input: DeviceCommandInput): Promise<DeviceCommandResponse> {
    try {
      return await this.client.command(this.session, input);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      throw new ActionRequiresFreshObservationError();
    }
  }

  private async recoverAfterTransportFailure(error: unknown): Promise<void> {
    if (!isTransportFailure(error)) throw error;
    const deviceId = this.session.card.deviceId;
    if (!deviceId || !this.sessions) throw error;
    const pending = this.recovery ?? this.sessions.resume(deviceId);
    this.recovery = pending;
    try {
      this.session = await pending;
    } finally {
      if (this.recovery === pending) this.recovery = undefined;
    }
  }
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /fetch failed|network|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(error.message);
}
