export type ConnectionCard = {
  connectionId: string;
  endpoint: string;
  bootstrapToken: string;
  displayName: string;
  expiresAtMs: number;
  deviceId?: string;
  discoveryServiceType?: string;
};

const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

export function parseConnectionCard(serialized: string, nowMs = Date.now()): ConnectionCard {
  const uri = new URL(serialized);
  if (uri.protocol !== "huahua:" || uri.hostname !== "device-agent" || !["/v1", "/v2"].includes(uri.pathname)) throw new Error("不支持的 HuAHua 连接卡。");
  const required = (key: string) => {
    const value = uri.searchParams.get(key);
    if (!value) throw new Error(`连接卡缺少 ${key}。`);
    return value;
  };
  const card: ConnectionCard = {
    connectionId: decode(required("connection_id")), endpoint: decode(required("endpoint")), bootstrapToken: decode(required("token")),
    displayName: decode(required("name")), expiresAtMs: Number(required("expires_at_ms"))
  };
  if (uri.pathname === "/v2") {
    card.deviceId = decode(required("device_id"));
    card.discoveryServiceType = decode(required("discovery_service_type"));
    if (card.discoveryServiceType !== "_huahua-device-agent._tcp.") throw new Error("连接卡包含不支持的局域网发现服务。");
  }
  if (!Number.isSafeInteger(card.expiresAtMs) || card.expiresAtMs <= nowMs) throw new Error("连接卡已过期。请在 HuAHua 的“自己的 AI 控制手机”页面点击“刷新连接卡”，再将新卡发送给 AI。");
  const endpoint = new URL(card.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || !endpoint.hostname) throw new Error("连接卡中的局域网地址无效。");
  return card;
}
