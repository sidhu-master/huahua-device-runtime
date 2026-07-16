import { ConnectionCard } from "./connection-card.js";

export type DeviceSession = { card: ConnectionCard; hostId: string; accessToken: string; expiresAtMs: number };

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
  async command(session: DeviceSession, command: object) {
    return this.json(await this.fetchImpl(`${session.card.endpoint}/v1/commands`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ hostId: session.hostId, ...command })
    }));
  }
  private async request(card: ConnectionCard, path: string, body: object): Promise<any> { return this.json(await this.fetchImpl(`${card.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
  private async get(card: ConnectionCard, path: string): Promise<any> { return this.json(await this.fetchImpl(`${card.endpoint}${path}`)); }
  private async json(response: Response): Promise<any> { const body = await response.json(); if (!response.ok || !body.ok) throw new Error(body.error ?? `Device agent returned ${response.status}`); return body; }
}
