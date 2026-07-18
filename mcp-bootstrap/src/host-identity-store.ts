import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostIdentity = {
  hostId: string;
  privateKeyPem: string;
  publicKeySpki: string;
};

/** A local, user-only P-256 identity. It is never a server access token. */
export class HostIdentityStore {
  private readonly file: string;

  constructor(private readonly directory = join(homedir(), ".config", "huahua-mcp")) {
    this.file = join(directory, "host-identity.json");
  }

  async loadOrCreate(): Promise<HostIdentity> {
    try {
      return await this.load();
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const identity = createIdentity();
    try {
      await writeFile(this.file, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(this.file, 0o600);
      return identity;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      return this.load();
    }
  }

  private async load(): Promise<HostIdentity> {
    const fileStat = await stat(this.file);
    if ((fileStat.mode & 0o077) !== 0) {
      throw new Error("HuAHua 主机身份文件权限过宽，请将其权限改为 0600 后重试。");
    }
    const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<HostIdentity>;
    if (!parsed.hostId || !parsed.privateKeyPem || !parsed.publicKeySpki) {
      throw new Error("HuAHua 主机身份文件无效，请删除后重新连接手机。");
    }
    const derivedSpki = createPublicKey(createPrivateKey(parsed.privateKeyPem)).export({ type: "spki", format: "der" }).toString("base64");
    if (derivedSpki !== parsed.publicKeySpki || !isP256(parsed.privateKeyPem)) {
      throw new Error("HuAHua 主机身份不是有效的 P-256 密钥，请删除后重新连接手机。");
    }
    return { hostId: parsed.hostId, privateKeyPem: parsed.privateKeyPem, publicKeySpki: parsed.publicKeySpki };
  }
}

function createIdentity(): HostIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    hostId: randomUUID(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function isP256(privateKeyPem: string): boolean {
  const details = createPrivateKey(privateKeyPem).asymmetricKeyDetails;
  return details?.namedCurve === "prime256v1";
}
