import { ResilientDeviceSession } from "./resilient-device-session.js";

type IntervalHandle = ReturnType<typeof setInterval>;

export type TrustedSessionHeartbeatOptions = {
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, delay: number) => IntervalHandle;
  clearIntervalImpl?: (handle: IntervalHandle) => void;
};

/** Keeps the phone's live-connection lease fresh for the lifetime of one MCP process. */
export class TrustedSessionHeartbeat {
  private readonly intervalMs: number;
  private readonly setIntervalImpl: (callback: () => void, delay: number) => IntervalHandle;
  private readonly clearIntervalImpl: (handle: IntervalHandle) => void;
  private timer: IntervalHandle | undefined;

  constructor(
    private readonly device: Pick<ResilientDeviceSession, "heartbeat">,
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
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    void this.device.heartbeat().catch(() => undefined);
  }
}
