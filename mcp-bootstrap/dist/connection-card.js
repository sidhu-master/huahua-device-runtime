const decode = (value) => Buffer.from(value, "base64url").toString("utf8");
export function parseConnectionCard(serialized, nowMs = Date.now()) {
    const uri = new URL(serialized);
    if (uri.protocol !== "huahua:" || uri.hostname !== "device-agent" || uri.pathname !== "/v1")
        throw new Error("Unsupported HuAHua connection card");
    const required = (key) => {
        const value = uri.searchParams.get(key);
        if (!value)
            throw new Error(`Connection card is missing ${key}`);
        return value;
    };
    const card = {
        connectionId: decode(required("connection_id")), endpoint: decode(required("endpoint")), bootstrapToken: decode(required("token")),
        displayName: decode(required("name")), expiresAtMs: Number(required("expires_at_ms"))
    };
    if (!Number.isSafeInteger(card.expiresAtMs) || card.expiresAtMs <= nowMs)
        throw new Error("Connection card has expired");
    const endpoint = new URL(card.endpoint);
    if (!["http:", "https:"].includes(endpoint.protocol) || !endpoint.hostname)
        throw new Error("Connection card has an invalid endpoint");
    return card;
}
