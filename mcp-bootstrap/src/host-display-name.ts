import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export type HostDisplayNameOptions = {
  configuredName?: string;
  platform?: NodeJS.Platform;
  readMacComputerName?: () => string | undefined;
  readFallbackName?: () => string | undefined;
};

/** Resolves a human-readable name for the computer that is pairing with the phone. */
export function resolveHostDisplayName(options: HostDisplayNameOptions = {}): string {
  const configuredName = normalized(options.configuredName);
  if (configuredName) return configuredName;

  if ((options.platform ?? process.platform) === "darwin") {
    const computerName = normalized((options.readMacComputerName ?? macComputerName)());
    if (computerName) return computerName;
  }

  return normalized((options.readFallbackName ?? hostname)()) ?? "AI 控制端";
}

function macComputerName(): string | undefined {
  try {
    return execFileSync("scutil", ["--get", "ComputerName"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
