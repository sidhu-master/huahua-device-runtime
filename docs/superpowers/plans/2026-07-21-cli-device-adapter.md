# CLI Device Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-MCP CLI and a reusable session core so terminal-capable AI agents can control an approved HuAHua phone without MCP configuration.

**Architecture:** `DeviceSessionManager` owns pairing and trusted-session recovery using the existing client and local stores. MCP startup and CLI commands consume that manager, so they share host identity, device profile, discovery, short tokens and action protocol. The Skill is documentation that invokes the CLI.

**Tech Stack:** Node.js 20+, TypeScript, existing `HuahuaLanClient`, node:test, stdio MCP.

## Global Constraints

- Preserve `huahua-mcp connect` and `huahua-mcp serve --device` compatibility.
- Do not persist connection cards, endpoints or short access tokens.
- CLI actions must use the existing command types and observation-id precondition.
- No Android, server or model API changes.

---

### Task 1: Extract reusable device-session lifecycle

**Files:**
- Create: `mcp-bootstrap/src/device-session-manager.ts`
- Modify: `mcp-bootstrap/src/cli.ts`, `mcp-bootstrap/src/index.ts`
- Test: `mcp-bootstrap/test/bootstrap.test.mjs`

- [ ] Write a failing test proving first pairing saves a profile only after `HuahuaLanClient.connect` succeeds, and trusted recovery reads the same host identity/profile.
- [ ] Implement `DeviceSessionManager.pair(connectionCard, hostName)` and `resume(deviceId)` around existing `HostIdentityStore`, `DeviceProfileStore` and `HuahuaLanClient`.
- [ ] Route existing MCP `connect` and `serve` commands through this manager.
- [ ] Run `npm test` and commit the focused session-core change.

### Task 2: Add direct CLI commands

**Files:**
- Create: `mcp-bootstrap/src/cli-command-runner.ts`
- Modify: `mcp-bootstrap/src/cli.ts`, `mcp-bootstrap/package.json`
- Test: `mcp-bootstrap/test/bootstrap.test.mjs`

- [ ] Write failing tests for `pair`, `observe`, and `command` argument validation and JSON result shaping.
- [ ] Implement `huahua pair <connection-card>`, `huahua observe --device <id> [--image-file <path>]`, and `huahua command --device <id> --action ... --observation-id ... --summary ...`.
- [ ] Make each CLI invocation call `DeviceSessionManager.resume`; retain `huahua-mcp` as an alias using the same executable.
- [ ] Run `npm test`, `npm pack --dry-run`, and commit the CLI adapter.

### Task 3: Ship a generic skill and publish

**Files:**
- Create: `mcp-bootstrap/skills/huahua/SKILL.md`
- Modify: `mcp-bootstrap/README.md`, `mcp-bootstrap/package.json`, `mcp-bootstrap/package-lock.json`
- Test: `mcp-bootstrap/test/bootstrap.test.mjs`

- [ ] Write a failing package-content test for the CLI binary and Skill file.
- [ ] Document the safe workflow: pair once, observe before every action, save the observation image locally when available, stop for sensitive tasks, and never log a card/token.
- [ ] Bump package version, build, test, pack, publish, then verify a clean `npm exec` invocation of both binaries.
- [ ] Commit and push the public runtime repository main branch.
