import { DeviceSessionManager } from "./device-session-manager.js";
import { resolveHostDisplayName } from "./host-display-name.js";

type HostPreparer = Pick<DeviceSessionManager, "prepare">;

export type PrepareHostDependencies = {
  sessions?: HostPreparer;
  write?: (value: string) => void;
  hostName?: string;
};

/** Prepares the local host identity without pairing or controlling a phone. */
export async function prepareHost(dependencies: PrepareHostDependencies = {}): Promise<void> {
  const sessions = dependencies.sessions ?? new DeviceSessionManager();
  const write = dependencies.write ?? (value => process.stdout.write(`${value}\n`));
  const hostName = resolveHostDisplayName({
    configuredName: dependencies.hostName ?? process.env.HUAHUA_HOST_NAME,
  });
  const prepared = await sessions.prepare();
  write(JSON.stringify({ state: "prepared", host_id: prepared.hostId, host_name: hostName }));
}
