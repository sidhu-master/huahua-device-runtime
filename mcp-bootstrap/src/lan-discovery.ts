import Bonjour from "bonjour-service";

export interface LanDiscovery {
  resolve(deviceId: string, discoveryServiceType: string): Promise<string>;
}

/** mDNS is discovery only. Authentication still requires the signed challenge. */
export class MdnsLanDiscovery implements LanDiscovery {
  constructor(private readonly timeoutMs = 5_000) {}

  async resolve(deviceId: string, discoveryServiceType: string): Promise<string> {
    const service = parseServiceType(discoveryServiceType);
    const bonjour = new Bonjour();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const browser = bonjour.find({ type: service.type, protocol: service.protocol });
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        browser.stop();
        bonjour.destroy();
        callback();
      };
      browser.on("up", found => {
        if (found.txt?.device_id !== deviceId && found.name !== deviceId) return;
        const address = found.addresses?.find(value => /^\d+\.\d+\.\d+\.\d+$/.test(value)) ?? found.addresses?.[0];
        if (!address || !found.port) return;
        const host = address.includes(":") ? `[${address}]` : address;
        finish(() => resolve(`http://${host}:${found.port}`));
      });
      timer = setTimeout(() => finish(() => reject(new Error("未在局域网发现该手机。请确认手机已开启 AI 控制此手机，并与电脑连接同一 Wi‑Fi。"))), this.timeoutMs);
    });
  }
}

function parseServiceType(value: string): { type: string; protocol: "tcp" | "udp" } {
  const match = /^_([a-z0-9-]+)\._(tcp|udp)\.$/i.exec(value);
  if (!match) throw new Error("HuAHua 设备发现服务类型无效，请重新通过连接卡配置。");
  return { type: match[1], protocol: match[2].toLowerCase() as "tcp" | "udp" };
}
