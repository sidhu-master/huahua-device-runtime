import { ConnectionCard, parseConnectionCard } from "./connection-card.js";
import { HuahuaLanClient, DeviceSession } from "./client.js";
import { DeviceProfile, DeviceProfileStore } from "./device-profile-store.js";
import { HostIdentity, HostIdentityStore } from "./host-identity-store.js";

type SessionClient = Pick<HuahuaLanClient, "connect" | "resume">;
type IdentityStore = Pick<HostIdentityStore, "loadOrCreate">;
type ProfileStore = Pick<DeviceProfileStore, "load" | "save">;

export type DeviceSessionManagerOptions = {
  client?: SessionClient;
  identities?: IdentityStore;
  profiles?: ProfileStore;
};

/**
 * The only host-side owner of first pairing and trusted-session recovery.
 * MCP and CLI adapters use this class so they share one identity and profile.
 */
export class DeviceSessionManager {
  private readonly client: SessionClient;
  private readonly identities: IdentityStore;
  private readonly profiles: ProfileStore;

  constructor(options: DeviceSessionManagerOptions = {}) {
    this.client = options.client ?? new HuahuaLanClient();
    this.identities = options.identities ?? new HostIdentityStore();
    this.profiles = options.profiles ?? new DeviceProfileStore();
  }

  async prepare(): Promise<{ hostId: string }> {
    const identity = await this.identities.loadOrCreate();
    return { hostId: identity.hostId };
  }

  async pair(connectionCardText: string, hostName: string, nowMs = Date.now()): Promise<DeviceSession> {
    const card = parseConnectionCard(connectionCardText, nowMs);
    const identity = await this.identities.loadOrCreate();
    const session = await this.client.connect(card, identity.hostId, normalizedHostName(hostName), identity.publicKeySpki);
    await this.saveProfileAfterPairing(card, identity);
    return session;
  }

  async resume(deviceId: string): Promise<DeviceSession> {
    const profile = await this.profiles.load(required(deviceId, "设备 ID"));
    if (!profile) throw new Error("没有找到这台手机的配置。请先在手机 HuAHua 中复制连接卡，并运行 huahua connect <连接卡>。");
    const identity = await this.identities.loadOrCreate();
    return this.client.resume(profile, identity);
  }

  private async saveProfileAfterPairing(card: ConnectionCard, identity: HostIdentity): Promise<void> {
    if (!card.deviceId || !card.discoveryServiceType) return;
    const profile: DeviceProfile = {
      deviceId: card.deviceId,
      displayName: card.displayName,
      discoveryServiceType: card.discoveryServiceType,
      hostId: identity.hostId,
    };
    await this.profiles.save(profile);
  }
}

function normalizedHostName(value: string): string {
  return value.trim().slice(0, 128) || "AI Host";
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  return normalized;
}
