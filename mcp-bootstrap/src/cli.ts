#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { HuahuaLanClient } from "./client.js";
import { parseConnectionCard } from "./connection-card.js";
import { startMcp } from "./index.js";

const [, , command, cardText] = process.argv;
if (command !== "connect" || !cardText) {
  console.error("Usage: huahua-mcp connect <huahua connection card>");
  process.exit(2);
}
const card = parseConnectionCard(cardText);
const hostId = process.env.HUAHUA_HOST_ID || randomUUID();
const session = await new HuahuaLanClient().connect(card, hostId, process.env.HUAHUA_HOST_NAME || "AI Host");
await startMcp(session);
