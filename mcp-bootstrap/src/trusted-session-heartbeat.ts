import { ResilientDeviceSession } from "./resilient-device-session.js";

type IntervalHandle = ReturnType<typeof setInterval>;

export type TrustedSessionHeartbeatOptions = {
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, delay: number) => IntervalHandle;
  clearIntervalImpl?: (handle: IntervalHandle) => void;
};

type CloseAwareTransport = {
  onclose?: () => void;
};

/** Keeps the phone's live-connection lease fresh for the lifetime of one MCP process. */
export class TrustedSessionHeartbeat {
  private readonly intervalMs: number;
  private readonly setIntervalImpl: (callback: () => void, delay: number) => IntervalHandle;
  private readonly clearIntervalImpl: (handle: IntervalHandle) => void;
  private timer: IntervalHandle | undefined;
  private sseActive = false;
  private sseStopped = false;

  constructor(
    private readonly device: Pick<ResilientDeviceSession, "heartbeat" | "current">,
    options: TrustedSessionHeartbeatOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = this.setIntervalImpl(() => this.tick(), this.intervalMs);
    this.startSse();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = undefined;
    this.sseStopped = true;
  }

  private _pendingVoiceCommand: string | null = null;

  get pendingVoiceCommand(): string | null { return this._pendingVoiceCommand; }
  consumeVoiceCommand(): string | null {
    const v = this._pendingVoiceCommand;
    this._pendingVoiceCommand = null;
    return v;
  }

  /**
   * Triggers an immediate heartbeat tick and returns any voice command
   * that was pending on the phone (not yet cached by the periodic tick).
   * Falls back to the cached value if the heartbeat call fails.
   */
  async fetchVoiceCommandNow(): Promise<string | null> {
    try {
      const resp = await this.device.heartbeat();
      if (resp && typeof resp.pending_voice_command === "string") {
        this._pendingVoiceCommand = resp.pending_voice_command;
      }
    } catch {
      // ignore – use cached value
    }
    return this.consumeVoiceCommand();
  }

  /** SSE long-lived connection for instant voice command push (phone -> MCP). */
  private async startSse(): Promise<void> {
    if (this.sseStopped || this.sseActive) return;
    this.sseActive = true;
    try {
      const session = this.device.current;
      const url = `${session.card.endpoint}/v3/events?host_id=${encodeURIComponent(session.hostId)}`;
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${session.accessToken}` },
      });
      if (!res.ok || !res.body) {
        this.sseActive = false;
        setTimeout(() => void this.startSse(), 5_000);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const cmd = line.slice(6).trim();
            if (cmd) this._pendingVoiceCommand = cmd;
          }
        }
      }
    } catch {
      // Connection dropped or session unavailable
    }
    this.sseActive = false;
    if (!this.sseStopped) setTimeout(() => void this.startSse(), 3_000);
  }

  private tick(): void {
    void this.device.heartbeat().then((resp: Record<string, unknown> | undefined) => {
      if (resp && typeof resp.pending_voice_command === "string") {
        this._pendingVoiceCommand = resp.pending_voice_command;
      }
    }).catch(() => undefined);
  }
}

/** Keeps the lease alive after MCP startup and releases it only when its transport closes. */
export function attachTrustedSessionHeartbeatToTransport(
  heartbeat: Pick<TrustedSessionHeartbeat, "start" | "stop">,
  transport: CloseAwareTransport,
): void {
  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      previousOnClose?.();
    } finally {
      heartbeat.stop();
    }
  };
  heartbeat.start();
}
