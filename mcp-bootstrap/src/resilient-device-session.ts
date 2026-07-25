import { DeviceCommandInput, DeviceCommandResponse, DeviceObservation, DeviceSession, HuahuaLanClient } from "./client.js";

type SessionResumer = {
  resume(deviceId: string): Promise<DeviceSession>;
};

type DeviceClient = Pick<HuahuaLanClient, "observe" | "command"> & Partial<Pick<HuahuaLanClient, "heartbeat" | "complete">>;

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
  private readonly trustedDeviceId: string | undefined;

  constructor(
    private session: DeviceSession | undefined,
    private readonly sessions: SessionResumer | undefined,
    private readonly client: DeviceClient = new HuahuaLanClient(),
    private readonly nowMs: () => number = Date.now,
    trustedDeviceId?: string,
  ) {
    this.trustedDeviceId = trustedDeviceId ?? session?.card.deviceId;
  }

  /** Starts from a previous pairing without requiring the phone to be discoverable yet. */
  static forTrustedDevice(
    deviceId: string,
    sessions: SessionResumer,
    client: DeviceClient = new HuahuaLanClient(),
  ): ResilientDeviceSession {
    return new ResilientDeviceSession(undefined, sessions, client, Date.now, deviceId);
  }

  get current(): DeviceSession {
    if (!this.session) {
      throw new Error("正在等待已配对手机重新出现在局域网。请确认手机已开启 AI 控制此手机，且两台设备位于同一 Wi‑Fi。");
    }
    return this.session;
  }

  get connectionStatus(): { state: "connected" | "reconnecting"; deviceId: string | undefined } {
    return {
      state: this.session ? "connected" : "reconnecting",
      deviceId: this.trustedDeviceId,
    };
  }

  async heartbeat(): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    if (!this.client.heartbeat) return {};
    try {
      return await this.client.heartbeat(this.current);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      return await this.client.heartbeat(this.current);
    }
  }

  async observe(): Promise<DeviceObservation> {
    await this.ensureConnected();
    try {
      return await this.client.observe(this.current);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      return this.client.observe(this.current);
    }
  }

  async command(input: DeviceCommandInput): Promise<DeviceCommandResponse> {
    await this.ensureConnected();
    try {
      return await this.client.command(this.current, input);
    } catch (error) {
      await this.recoverAfterTransportFailure(error);
      throw new ActionRequiresFreshObservationError();
    }
  }

  async complete(summary: string): Promise<void> {
    if (!this.client.complete) {
      throw new Error("当前客户端不支持同步任务完成状态。请更新 HuAHua MCP 后重试。");
    }
    await this.ensureConnected();
    await this.client.complete(this.current, summary);
  }

  private async recoverAfterTransportFailure(error: unknown): Promise<void> {
    if (!isRecoverableSessionFailure(error)) throw error;
    await this.resumeTrustedSession();
  }

  private async refreshBeforeExpiry(): Promise<void> {
    if (this.session && this.session.expiresAtMs > this.nowMs() + SESSION_RENEWAL_WINDOW_MS) return;
    await this.resumeTrustedSession();
  }

  private async ensureConnected(): Promise<void> {
    await this.refreshBeforeExpiry();
  }

  private async resumeTrustedSession(): Promise<void> {
    const deviceId = this.trustedDeviceId;
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
