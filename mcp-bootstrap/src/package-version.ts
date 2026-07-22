import { createRequire } from "node:module";

const manifest = createRequire(import.meta.url)("../package.json") as { version?: unknown };

/** The installed npm package version, read from the package manifest at runtime. */
export const MCP_PACKAGE_VERSION = typeof manifest.version === "string" ? manifest.version : "0.0.0";
