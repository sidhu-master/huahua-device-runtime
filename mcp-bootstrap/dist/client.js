export class HuahuaLanClient {
    fetchImpl;
    sleep;
    constructor(fetchImpl = fetch, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))) {
        this.fetchImpl = fetchImpl;
        this.sleep = sleep;
    }
    async connect(card, hostId, hostDisplayName) {
        const pairing = await this.request(card, "/v1/pairing/requests", { connectionId: card.connectionId, bootstrapToken: card.bootstrapToken, hostId, hostDisplayName });
        const deadline = Math.min(card.expiresAtMs, Date.now() + 5 * 60_000);
        while (Date.now() < deadline) {
            await this.sleep(1_000);
            const status = await this.get(card, `/v1/pairing/requests/${encodeURIComponent(pairing.request_id)}?host_id=${encodeURIComponent(hostId)}`);
            if (status.status === "approved")
                return { card, hostId, accessToken: status.host_access_token, expiresAtMs: status.expires_at_ms };
        }
        throw new Error("Timed out waiting for phone pairing approval");
    }
    async health(card) { return this.get(card, "/v1/health"); }
    async request(card, path, body) { return this.json(await this.fetchImpl(`${card.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
    async get(card, path) { return this.json(await this.fetchImpl(`${card.endpoint}${path}`)); }
    async json(response) { const body = await response.json(); if (!response.ok || !body.ok)
        throw new Error(body.error ?? `Device agent returned ${response.status}`); return body; }
}
