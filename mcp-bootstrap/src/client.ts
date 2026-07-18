import { ConnectionCard } from "./connection-card.js";
import { DeviceProfile } from "./device-profile-store.js";
import { HostIdentity } from "./host-identity-store.js";
import { LanDiscovery, MdnsLanDiscovery } from "./lan-discovery.js";
import { sign } from "node:crypto";

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
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private readonly discovery: LanDiscovery = new MdnsLanDiscovery(),
  ) {}
  async connect(card: ConnectionCard, hostId: string, hostDisplayName: string, hostPublicKeySpki?: string): Promise<DeviceSession> {
    const pairing = await this.request(card, "/v1/pairing/requests", {
      connectionId: card.connectionId,
      bootstrapToken: card.bootstrapToken,
      hostId,
      hostDisplayName,
      ...(hostPublicKeySpki ? { hostPublicKeySpki } : {}),
    });
    const deadline = Math.min(card.expiresAtMs, Date.now() + 5 * 60_000);
    while (Date.now() < deadline) {
      await this.sleep(1_000);
      const status = await this.get(card, `/v1/pairing/requests/${encodeURIComponent(pairing.request_id)}?host_id=${encodeURIComponent(hostId)}`);
      if (status.status === "approved") return { card, hostId, accessToken: status.host_access_token, expiresAtMs: status.expires_at_ms };
    }
    throw new Error("等待手机确认连接超时，请在 HuAHua 中重新发起连接。");
  }
  async resume(profile: DeviceProfile, identity: HostIdentity): Promise<DeviceSession> {
    if (profile.hostId !== identity.hostId) throw new Error("此电脑身份与已保存的手机配置不匹配，请重新通过连接卡配置。");
    const endpoint = await this.discovery.resolve(profile.deviceId, profile.discoveryServiceType);
    const challenge = await this.requestEndpoint(endpoint, "/v2/trusted-sessions/challenges", { hostId: identity.hostId });
    const challengeValue = String(challenge.challenge ?? "");
    const challengeId = String(challenge.challenge_id ?? "");
    if (!challengeValue || !challengeId) throw new Error("手机返回的连接挑战无效，请稍后重试。");
    const signature = sign("sha256", Buffer.from(challengeValue, "base64url"), identity.privateKeyPem).toString("base64url");
    const session = await this.requestEndpoint(endpoint, "/v2/trusted-sessions", { hostId: identity.hostId, challengeId, signature });
    const accessToken = String(session.host_access_token ?? "");
    const expiresAtMs = Number(session.expires_at_ms ?? 0);
    if (!accessToken || !Number.isSafeInteger(expiresAtMs)) throw new Error("手机没有返回有效的短期控制会话，请稍后重试。");
    return {
      hostId: identity.hostId,
      accessToken,
      expiresAtMs,
      card: {
        connectionId: "trusted-session", endpoint, bootstrapToken: "", displayName: profile.displayName, expiresAtMs,
        deviceId: profile.deviceId, discoveryServiceType: profile.discoveryServiceType,
      },
    };
  }
  async health(card: ConnectionCard) { return this.get(card, "/v1/health"); }
  async observe(session: DeviceSession): Promise<DeviceObservation> {
    const version = apiVersion(session.card);
    const payload = await this.json(await this.fetchImpl(
      `${session.card.endpoint}/${version}/observe?host_id=${encodeURIComponent(session.hostId)}`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
    ));
    return observationFrom(payload);
  }
  async command(session: DeviceSession, command: DeviceCommandInput): Promise<DeviceCommandResponse> {
    const version = apiVersion(session.card);
    const { stepSummary, expectedObservationId, ...commandBody } = command;
    const payload = await this.json(await this.fetchImpl(`${session.card.endpoint}/${version}/commands`, {
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
  private async requestEndpoint(endpoint: string, path: string, body: object): Promise<any> { return this.json(await this.fetchImpl(`${endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
  private async get(card: ConnectionCard, path: string): Promise<any> { return this.json(await this.fetchImpl(`${card.endpoint}${path}`)); }
  private async json(response: Response): Promise<any> {
    const body = await response.json();
    if (!response.ok || !body.ok) {
      if (response.status === 403) throw new Error("此电脑未获手机授权或授权已被撤销，请在手机中重新连接。");
      throw new Error(String(body.error ?? `手机控制服务返回错误（${response.status}）。`));
    }
    return body;
  }
}

const apiVersion = (card: ConnectionCard): "v1" | "v2" => card.deviceId && card.discoveryServiceType ? "v2" : "v1";

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
