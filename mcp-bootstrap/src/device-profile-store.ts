import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DeviceProfile = {
  deviceId: string;
  displayName: string;
  discoveryServiceType: string;
  hostId: string;
};

/** Stores discovery metadata only; endpoints and access tokens are never saved. */
export class DeviceProfileStore {
  private readonly file: string;

  constructor(private readonly directory = join(homedir(), ".config", "huahua-mcp")) {
    this.file = join(directory, "device-profiles.json");
  }

  async save(profile: DeviceProfile): Promise<void> {
    validate(profile);
    const profiles = await this.loadAll();
    profiles[profile.deviceId] = profile;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await writeFile(this.file, `${JSON.stringify(profiles)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async load(deviceId: string): Promise<DeviceProfile | undefined> {
    return (await this.loadAll())[deviceId];
  }

  async list(): Promise<DeviceProfile[]> {
    return Object.values(await this.loadAll()).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  private async loadAll(): Promise<Record<string, DeviceProfile>> {
    try {
      const profiles = JSON.parse(await readFile(this.file, "utf8")) as Record<string, DeviceProfile>;
      Object.values(profiles).forEach(validate);
      return profiles;
    } catch (error: any) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }
}

function validate(profile: DeviceProfile): void {
  if (!profile.deviceId || !profile.displayName || !profile.hostId || profile.discoveryServiceType !== "_huahua-device-agent._tcp.") {
    throw new Error("HuAHua 设备配置无效，请重新通过连接卡配置。");
  }
}
