# Install-Before-Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare MCP before pairing, keep the approved connection alive, and block screenshots until phone control is ready.

**Architecture:** Add a local `prepare` command, expose phone-control readiness through the existing health endpoint, and make MCP status/observation tools enforce the shared setup state. Keep `connect` as the recommended single-process pairing entrypoint.

**Tech Stack:** TypeScript, Node.js 20+, MCP SDK, Kotlin, Android local LAN server.

## Global Constraints

- Do not persist connection cards, access tokens, or fixed LAN addresses.
- Do not expose implementation-specific privileged-service names in public protocol or copy.
- Do not use ADB or a data cable for the real-user pairing verification.

---

### Task 1: MCP preparation and readiness policy

**Files:**
- Modify: `mcp-bootstrap/src/device-session-manager.ts`
- Modify: `mcp-bootstrap/src/cli-command-runner.ts`
- Modify: `mcp-bootstrap/src/cli.ts`
- Modify: `mcp-bootstrap/src/index.ts`
- Test: `mcp-bootstrap/test/bootstrap.test.mjs`

**Interfaces:**
- Produces: `DeviceSessionManager.prepare(): Promise<{hostId: string}>`
- Produces: `huahua prepare`
- Consumes: health field `phone_control_ready`

- [ ] Add failing tests for preparation output and the `phone_setup_required` MCP readiness policy.
- [ ] Run the focused Node tests and confirm they fail for the missing behavior.
- [ ] Implement the preparation command and readiness policy.
- [ ] Run the complete MCP test suite.

### Task 2: Android phone-control readiness

**Files:**
- Modify: `app/src/main/java/com/sidhu/androidautoglm/deviceagent/DeviceAgentLanServer.kt`
- Modify: `app/src/main/java/com/sidhu/androidautoglm/deviceagent/DeviceAgentLanService.kt`
- Test: `app/src/test/java/com/sidhu/androidautoglm/deviceagent/DeviceAgentLanServerTest.kt`

**Interfaces:**
- Produces: `GET /v1/health` JSON field `phone_control_ready: Boolean`

- [ ] Add a failing health-route test for ready and not-ready states.
- [ ] Run the focused Android test and confirm it fails for the missing field.
- [ ] Inject the current control-runtime readiness into the LAN server health response.
- [ ] Run the focused test and Kotlin compilation.

### Task 3: AI-facing setup instructions

**Files:**
- Modify: `mcp-bootstrap/README.md`
- Modify: `mcp-bootstrap/skills/huahua/SKILL.md`

**Interfaces:**
- Consumes: `huahua prepare`, `connect`, and `device_status`.

- [ ] Rewrite first-time setup in the required order: prepare, configure/start MCP, approve, finish phone setup, observe.
- [ ] State that `device_observe` is forbidden until status is `connected`.
- [ ] Run package tests and `git diff --check` in both repositories.
