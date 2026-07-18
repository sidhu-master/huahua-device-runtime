import { ConnectionCard } from "./connection-card.js";

export type DeviceSession = { card: ConnectionCard; hostId: string; accessToken: string; expiresAtMs: number };
export type DeviceObservation = {
  id: string;
  capturedAtMs: number;
  pngBase64: string;
  foregroundApp: string;
  screenWidth: number;
  screenHeight: number;
};
export type DeviceCommandInput = {
  action: string;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  packageName?: string;
  text?: string;
  stepSummary?: string;
  expectedObservationId?: string;
};
export type DeviceCommandResponse = {
  outcome: string;
  detail: string;
  observation?: DeviceObservation;
};

export class HuahuaLanClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}
  async connect(card: ConnectionCard, hostId: string, hostDisplayName: string): Promise<DeviceSession> {
    const pairing = await this.request(card, "/v1/pairing/requests", { connectionId: card.connectionId, bootstrapToken: card.bootstrapToken, hostId, hostDisplayName });
    const deadline = Math.min(card.expiresAtMs, Date.now() + 5 * 60_000);
    while (Date.now() < deadline) {
      await this.sleep(1_000);
      const status = await this.get(card, `/v1/pairing/requests/${encodeURIComponent(pairing.request_id)}?host_id=${encodeURIComponent(hostId)}`);
      if (status.status === "approved") return { card, hostId, accessToken: status.host_access_token, expiresAtMs: status.expires_at_ms };
    }
    throw new Error("Timed out waiting for phone pairing approval");
  }
  async health(card: ConnectionCard) { return this.get(card, "/v1/health"); }
  async observe(session: DeviceSession): Promise<DeviceObservation> {
    const payload = await this.json(await this.fetchImpl(
      `${session.card.endpoint}/v1/observe?host_id=${encodeURIComponent(session.hostId)}`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
    ));
    return observationFrom(payload);
  }
  async command(session: DeviceSession, command: DeviceCommandInput): Promise<DeviceCommandResponse> {
    const { stepSummary, expectedObservationId, ...commandBody } = command;
    const payload = await this.json(await this.fetchImpl(`${session.card.endpoint}/v1/commands`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        hostId: session.hostId,
        ...commandBody,
        ...(stepSummary ? { step_summary: stepSummary } : {}),
        ...(expectedObservationId ? { expected_observation_id: expectedObservationId } : {}),
      }),
    }));
    return {
      outcome: String(payload.outcome ?? ""),
      detail: String(payload.detail ?? ""),
      observation: payload.observation ? observationFrom(payload.observation) : undefined,
    };
  }
  private async request(card: ConnectionCard, path: string, body: object): Promise<any> { return this.json(await this.fetchImpl(`${card.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
  private async get(card: ConnectionCard, path: string): Promise<any> { return this.json(await this.fetchImpl(`${card.endpoint}${path}`)); }
  private async json(response: Response): Promise<any> { const body = await response.json(); if (!response.ok || !body.ok) throw new Error(body.error ?? `Device agent returned ${response.status}`); return body; }
}

function observationFrom(payload: any): DeviceObservation {
  return {
    id: String(payload.observation_id ?? ""),
    capturedAtMs: Number(payload.captured_at_ms ?? 0),
    pngBase64: String(payload.png_base64 ?? ""),
    foregroundApp: String(payload.foreground_app ?? ""),
    screenWidth: Number(payload.screen_width ?? 0),
    screenHeight: Number(payload.screen_height ?? 0),
  };
}
