import assert from "node:assert/strict";
import test from "node:test";
import { HuahuaLanClient, parseConnectionCard } from "../dist/index.js";
import { HostIdentityStore } from "../dist/host-identity-store.js";
import { DeviceProfileStore } from "../dist/device-profile-store.js";
import { DeviceSessionManager } from "../dist/device-session-manager.js";
import { runDirectCliCommand } from "../dist/cli-command-runner.js";
import { resolveHostDisplayName } from "../dist/host-display-name.js";
import { ActionRequiresFreshObservationError, ResilientDeviceSession } from "../dist/resilient-device-session.js";
import { TrustedSessionHeartbeat, attachTrustedSessionHeartbeatToTransport } from "../dist/trusted-session-heartbeat.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cardText = "huahua://device-agent/v1?connection_id=Y29ubmVjdGlvbi0x&endpoint=aHR0cDovLzE5Mi4xNjguMS4xMDozODQ3Mw&token=Ym9vdHN0cmFwLXNlY3JldA&name=UGl4ZWwgOQ&expires_at_ms=4102444800000";

test("declares the official public package name", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(manifest.name, "@newwe/huahua");
});

test("prepare initializes the computer identity before a connection card is consumed", async () => {
  const output = [];
  let prepares = 0;

  await runDirectCliCommand(["prepare"], {
    sessions: {
      prepare: async () => {
        prepares += 1;
        return { hostId: "host-ready" };
      },
      pair: async () => { throw new Error("pair must not run during prepare"); },
      resume: async () => { throw new Error("resume must not run during prepare"); },
    },
    hostName: "Sid的Mac mini",
    write: value => output.push(JSON.parse(value)),
  });

  assert.equal(prepares, 1);
  assert.deepEqual(output, [{
    state: "prepared",
    host_id: "host-ready",
    host_name: "Sid的Mac mini",
  }]);
});

test("maps a paired phone with incomplete phone setup to phone_setup_required", async () => {
  const module = await import("../dist/index.js");

  assert.equal(typeof module.phoneControlState, "function");
  assert.deepEqual(module.phoneControlState({ ok: true, phone_control_ready: false }), {
    state: "phone_setup_required",
    detail: "电脑 AI 已连接，请先在手机中完成控制准备。",
  });
  assert.deepEqual(module.phoneControlState({ ok: true, phone_control_ready: true }), {
    state: "connected",
  });
});

test("direct CLI status waits for phone setup without requesting a screenshot", async () => {
  const output = [];
  const session = trustedSession("http://phone");
  let observations = 0;

  await runDirectCliCommand(["status", "--device", "agent-device-a"], {
    sessions: {
      prepare: async () => ({ hostId: "host-a" }),
      pair: async () => { throw new Error("pair is not expected"); },
      resume: async () => session,
    },
    client: {
      health: async () => ({ ok: true, phone_control_ready: false }),
      observe: async () => {
        observations += 1;
        return observation("unexpected");
      },
      command: async () => { throw new Error("command is not expected"); },
    },
    write: value => output.push(JSON.parse(value)),
  });

  assert.equal(observations, 0);
  assert.deepEqual(output, [{
    state: "phone_setup_required",
    detail: "电脑 AI 已连接，请先在手机中完成控制准备。",
    device_id: "agent-device-a",
    device_name: "Pixel 9",
  }]);
});

test("keeps a trusted phone connection alive while the MCP process is running", async () => {
  let ticks = 0;
  let scheduled;
  let cleared;
  const heartbeat = new TrustedSessionHeartbeat(
    { heartbeat: async () => { ticks += 1; } },
    {
      intervalMs: 10,
      setIntervalImpl: callback => {
        scheduled = callback;
        return "timer";
      },
      clearIntervalImpl: timer => { cleared = timer; },
    },
  );

  heartbeat.start();
  await Promise.resolve();
  scheduled();
  await Promise.resolve();
  heartbeat.stop();

  assert.equal(ticks, 2);
  assert.equal(cleared, "timer");
});

test("resolves a readiness waiter from the structured phone SSE event", async () => {
  const heartbeat = new TrustedSessionHeartbeat(
    { heartbeat: async () => ({}), current: trustedSession("http://phone") },
  );
  const waiting = heartbeat.waitForPhoneControlReady(1_000);

  heartbeat.receiveEventData(JSON.stringify({ type: "phone_control_ready" }));

  assert.equal(await waiting, true);
});

test("keeps structured voice commands separate from readiness events", () => {
  const heartbeat = new TrustedSessionHeartbeat(
    { heartbeat: async () => ({}), current: trustedSession("http://phone") },
  );

  heartbeat.receiveEventData(JSON.stringify({ type: "voice_command", text: "继续搜索" }));
  heartbeat.receiveEventData(JSON.stringify({ type: "phone_control_ready" }));

  assert.equal(heartbeat.consumeVoiceCommand(), "继续搜索");
});

test("delivers phone pause immediately and retains it until the AI consumes it", () => {
  const heartbeat = new TrustedSessionHeartbeat(
    { heartbeat: async () => ({}), current: trustedSession("http://phone") },
  );
  const pushed = [];
  heartbeat.onControlEvent(event => pushed.push(event));

  heartbeat.receiveEventData(JSON.stringify({
    type: "control_paused",
    detail: "用户已在手机端暂停远程控制",
  }));

  assert.deepEqual(pushed, [{
    type: "control_paused",
    detail: "用户已在手机端暂停远程控制",
  }]);
  assert.deepEqual(heartbeat.consumeControlEvent(), {
    type: "control_paused",
    detail: "用户已在手机端暂停远程控制",
  });
  assert.equal(heartbeat.consumeControlEvent(), null);
});

test("delivers a phone pause returned by the periodic heartbeat", async () => {
  const pushed = [];
  const heartbeat = new TrustedSessionHeartbeat(
    {
      heartbeat: async () => ({
        pending_control_event: {
          type: "control_paused",
          detail: "用户已在手机端暂停远程控制",
        },
      }),
      current: trustedSession("http://phone"),
    },
    {
      setIntervalImpl: () => "timer",
      clearIntervalImpl: () => {},
    },
  );
  heartbeat.onControlEvent(event => pushed.push(event));

  heartbeat.start();
  await Promise.resolve();

  assert.deepEqual(pushed, [{
    type: "control_paused",
    detail: "用户已在手机端暂停远程控制",
  }]);
  heartbeat.stop();
});

test("keeps pause and steering events in order until the AI consumes them", () => {
  const heartbeat = new TrustedSessionHeartbeat(
    { heartbeat: async () => ({}), current: trustedSession("http://phone") },
  );

  heartbeat.receiveEventData(JSON.stringify({
    type: "task_paused",
    detail: "用户已暂停当前任务，请立即停止截图和操作",
    task_id: "task-1",
  }));
  heartbeat.receiveEventData(JSON.stringify({
    type: "task_steer",
    detail: "用户补充了任务要求，请先重新查看当前屏幕再继续",
    task_id: "task-1",
    text: "选择第二个结果",
    requires_fresh_observation: true,
  }));

  assert.deepEqual(heartbeat.consumeControlEvents(), [
    {
      type: "task_paused",
      detail: "用户已暂停当前任务，请立即停止截图和操作",
      task_id: "task-1",
    },
    {
      type: "task_steer",
      detail: "用户补充了任务要求，请先重新查看当前屏幕再继续",
      task_id: "task-1",
      text: "选择第二个结果",
      requires_fresh_observation: true,
    },
  ]);
  assert.deepEqual(heartbeat.consumeControlEvents(), []);
});

test("accepts an ordered event batch from heartbeat fallback", async () => {
  const heartbeat = new TrustedSessionHeartbeat(
    {
      heartbeat: async () => ({
        pending_control_events: [
          { type: "task_paused", detail: "已暂停", task_id: "task-1" },
          {
            type: "task_steer",
            detail: "已补充",
            task_id: "task-1",
            text: "改点第二个",
            requires_fresh_observation: true,
          },
        ],
      }),
      current: trustedSession("http://phone"),
    },
    {
      setIntervalImpl: () => "timer",
      clearIntervalImpl: () => {},
    },
  );

  heartbeat.start();
  await Promise.resolve();

  assert.deepEqual(heartbeat.consumeControlEvents().map(event => event.type), [
    "task_paused",
    "task_steer",
  ]);
  heartbeat.stop();
});

test("keeps the heartbeat running after MCP startup and stops it when the stdio transport closes", () => {
  let starts = 0;
  let stops = 0;
  const transport = {};

  attachTrustedSessionHeartbeatToTransport(
    { start: () => { starts += 1; }, stop: () => { stops += 1; } },
    transport,
  );

  assert.equal(starts, 1);
  assert.equal(stops, 0);
  transport.onclose();
  assert.equal(stops, 1);
});

test("retries trusted discovery after the MCP starts while the phone is offline", async () => {
  let attempts = 0;
  const recovery = ResilientDeviceSession.forTrustedDevice("agent-device-a", {
    resume: async deviceId => {
      attempts += 1;
      assert.equal(deviceId, "agent-device-a");
      if (attempts === 1) throw new TypeError("fetch failed");
      return trustedSession("http://192.168.1.55:45678");
    },
  }, {
    observe: async () => observation("unused"),
    command: async () => ({ outcome: "succeeded", detail: "unused" }),
    heartbeat: async () => {},
  });

  assert.equal(recovery.connectionStatus.state, "reconnecting");
  await assert.rejects(() => recovery.heartbeat(), /fetch failed/);
  await recovery.heartbeat();

  assert.equal(attempts, 2);
  assert.equal(recovery.connectionStatus.state, "connected");
  assert.equal(recovery.current.card.endpoint, "http://192.168.1.55:45678");
});

test("uses the system computer name by default while preserving an explicit host name", () => {
  assert.equal(
    resolveHostDisplayName({
      configuredName: "Trae IDE (Mac)",
      platform: "darwin",
      readMacComputerName: () => "Sid的Mac mini",
      readFallbackName: () => "homeassistant",
    }),
    "Trae IDE (Mac)",
  );
  assert.equal(
    resolveHostDisplayName({
      platform: "darwin",
      readMacComputerName: () => "Sid的Mac mini",
      readFallbackName: () => "homeassistant",
    }),
    "Sid的Mac mini",
  );
  assert.equal(
    resolveHostDisplayName({
      platform: "linux",
      readFallbackName: () => "office-ai",
    }),
    "office-ai",
  );
});

test("ships a terminal-agent skill that uses the direct CLI instead of MCP configuration", async () => {
  const skill = await readFile(new URL("../skills/huahua/SKILL.md", import.meta.url), "utf8");

  assert.match(skill, /@newwe\/huahua@<published-version> pair/);
  assert.match(skill, /@newwe\/huahua@<published-version> observe/);
  assert.match(skill, /observation id/i);
});

test("parses the Android connection card format", () => {
  const card = parseConnectionCard(cardText, 1);
  assert.equal(card.connectionId, "connection-1");
  assert.equal(card.endpoint, "http://192.168.1.10:38473");
});

test("expired cards tell the user how to refresh from HuAHua", () => {
  assert.throws(
    () => parseConnectionCard(cardText, 4102444800000),
    {
      message: "连接卡已过期。请在 HuAHua 的“自己的 AI 控制手机”页面点击“刷新连接卡”，再将新卡发送给 AI。",
    },
  );
});

test("host identity is stable after the first secure local write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huahua-mcp-test-"));
  const store = new HostIdentityStore(directory);

  const first = await store.loadOrCreate();
  assert.deepEqual(await store.loadOrCreate(), first);
  assert.equal((await stat(join(directory, "host-identity.json"))).mode & 0o777, 0o600);
});

test("persists a v2 device profile only after initial pairing succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huahua-mcp-profile-test-"));
  const store = new DeviceProfileStore(directory);
  const profile = {
    deviceId: "agent-device-a",
    displayName: "Pixel 9",
    discoveryServiceType: "_huahua-device-agent._tcp.",
    hostId: "host-a",
  };

  await store.save(profile);

  assert.deepEqual(await store.load("agent-device-a"), profile);
});

test("shared session manager pairs once and persists the reusable device profile", async () => {
  const saved = [];
  const manager = new DeviceSessionManager({
    client: {
      connect: async (card, hostId, hostName, publicKeySpki) => {
        assert.equal(hostId, "host-a");
        assert.equal(hostName, "Terminal AI");
        assert.equal(publicKeySpki, "public-key");
        return { card, hostId, accessToken: "short-token", expiresAtMs: 9999 };
      },
      resume: async () => { throw new Error("resume is not expected"); },
    },
    identities: { loadOrCreate: async () => ({ hostId: "host-a", privateKeyPem: "private-key", publicKeySpki: "public-key" }) },
    profiles: {
      save: async profile => saved.push(profile),
      load: async () => undefined,
    },
  });

  const v2CardText = cardText.replace("/v1?", "/v2?")
    + `&device_id=${Buffer.from("agent-device-a").toString("base64url")}`
    + `&discovery_service_type=${Buffer.from("_huahua-device-agent._tcp.").toString("base64url")}`;
  const session = await manager.pair(v2CardText, "Terminal AI", 1);

  assert.equal(session.accessToken, "short-token");
  assert.deepEqual(saved, [{
    deviceId: "agent-device-a",
    displayName: "Pixel 9",
    discoveryServiceType: "_huahua-device-agent._tcp.",
    hostId: "host-a",
  }]);
});

test("direct CLI resumes an approved device and writes the current observation image locally", async () => {
  const lines = [];
  const writes = [];
  await runDirectCliCommand(["observe", "--device", "agent-device-a", "--image-file", "/tmp/screen.jpg"], {
    sessions: {
      resume: async deviceId => ({
        hostId: "host-a", accessToken: "short-token", expiresAtMs: 9999,
        card: { connectionId: "trusted-session", endpoint: "http://phone", bootstrapToken: "", displayName: "Pixel 9", expiresAtMs: 9999, deviceId },
      }),
    },
    client: {
      observe: async () => observation("obs-1"),
      command: async () => { throw new Error("command is not expected"); },
    },
    writeImage: async (path, bytes) => writes.push({ path, bytes: [...bytes] }),
    write: value => lines.push(value),
  });

  assert.deepEqual(writes, [{ path: "/tmp/screen.jpg", bytes: [1, 2] }]);
  assert.deepEqual(JSON.parse(lines[0]), {
    device_id: "agent-device-a",
    device_name: "Pixel 9",
    observation: {
      observation_id: "obs-1",
      captured_at_ms: 100,
      image_mime_type: "image/jpeg",
      image_file: "/tmp/screen.jpg",
      foreground_app: "com.example",
      coordinate_space: "normalized_0_to_1000",
      visual_layout: "single",
      ui_tree_status: "unavailable",
      ui_tree: [],
    },
  });
});

test("direct CLI preserves the observation precondition for a tap", async () => {
  let commandInput;
  await runDirectCliCommand([
    "command", "--device", "agent-device-a", "--action", "tap", "--x", "12", "--y", "34",
    "--observation-id", "obs-1", "--summary", "点击搜索框",
  ], {
    sessions: { resume: async () => ({ hostId: "host-a", accessToken: "short-token", expiresAtMs: 9999, card: { connectionId: "trusted-session", endpoint: "http://phone", bootstrapToken: "", displayName: "Pixel 9", expiresAtMs: 9999, deviceId: "agent-device-a" } }) },
    client: {
      observe: async () => { throw new Error("observe is not expected"); },
      command: async (_session, input) => {
        commandInput = input;
        return { outcome: "succeeded", detail: "手机操作已完成。" };
      },
    },
    writeImage: async () => { throw new Error("image write is not expected"); },
    write: () => {},
  });

  assert.deepEqual(commandInput, { action: "tap", x: 12, y: 34, stepSummary: "点击搜索框", expectedObservationId: "obs-1" });
});

test("direct CLI starts a task with the user's original command", async () => {
  let originalCommand;
  await runDirectCliCommand(
    ["task-start", "--device", "agent-device-a", "--command", "打开抖音，搜索概率论"],
    {
      sessions: { resume: async () => trustedSession(), prepare: async () => {}, pair: async () => {} },
      client: {
        health: async () => ({ ok: true }),
        observe: async () => { throw new Error("observe is not expected"); },
        command: async () => { throw new Error("command is not expected"); },
        startTask: async (_session, command) => { originalCommand = command; },
      },
      write: () => {},
    },
  );

  assert.equal(originalCommand, "打开抖音，搜索概率论");
});

test("reports remote task completion through the trusted LAN session", async () => {
  const requests = [];
  const client = new HuahuaLanClient(async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await client.complete(trustedSession("http://192.168.1.10:38473"), "抖音搜索已完成");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://192.168.1.10:38473/v3/tasks/complete");
  assert.equal(requests[0].init.headers.authorization, "Bearer short-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    hostId: "host-a",
    summary: "抖音搜索已完成",
  });
});

test("direct CLI reports re-observation instead of replaying an action after recovery", async () => {
  const lines = [];
  let actionAttempts = 0;
  await runDirectCliCommand([
    "command", "--device", "agent-device-a", "--action", "tap", "--x", "12", "--y", "34",
    "--observation-id", "obs-1", "--summary", "点击搜索框",
  ], {
    sessions: {
      resume: async () => trustedSession("http://192.168.1.55:45678"),
    },
    client: {
      observe: async () => observation("unused"),
      command: async () => {
        actionAttempts += 1;
        throw new TypeError("fetch failed");
      },
    },
    writeImage: async () => { throw new Error("image write is not expected"); },
    write: value => lines.push(value),
  });

  assert.equal(actionAttempts, 1);
  assert.equal(JSON.parse(lines[0]).outcome, "reobserve_required");
});

test("retries one observation after a LAN address change by resuming the trusted session", async () => {
  const original = trustedSession("http://192.168.1.10:38473");
  const recovered = trustedSession("http://192.168.1.55:45678");
  const observedEndpoints = [];
  const recovery = new ResilientDeviceSession(original, {
    resume: async deviceId => {
      assert.equal(deviceId, "agent-device-a");
      return recovered;
    },
  }, {
    observe: async session => {
      observedEndpoints.push(session.card.endpoint);
      if (session.card.endpoint === original.card.endpoint) throw new TypeError("fetch failed");
      return observation("obs-after-ip-change");
    },
    command: async () => { throw new Error("command is not expected"); },
  });

  assert.equal((await recovery.observe()).id, "obs-after-ip-change");
  assert.deepEqual(observedEndpoints, ["http://192.168.1.10:38473", "http://192.168.1.55:45678"]);
});

test("renews an expired trusted-session token before retrying an observation", async () => {
  const original = trustedSession("http://192.168.1.10:38473");
  let observationAttempts = 0;
  const recovery = new ResilientDeviceSession(original, {
    resume: async () => trustedSession("http://192.168.1.10:38473"),
  }, {
    observe: async () => {
      observationAttempts += 1;
      if (observationAttempts === 1) throw new Error("此电脑未获手机授权或授权已被撤销，请在手机中重新连接。");
      return observation("obs-after-token-renewal");
    },
    command: async () => { throw new Error("command is not expected"); },
  });

  assert.equal((await recovery.observe()).id, "obs-after-token-renewal");
  assert.equal(observationAttempts, 2);
});

test("renews a near-expiry session before observing so the host never sees a 403", async () => {
  const original = trustedSession("http://192.168.1.10:38473", 1_000, "expiring-token");
  const renewed = trustedSession("http://192.168.1.10:38473", 600_000, "renewed-token");
  let resumes = 0;
  const recovery = new ResilientDeviceSession(original, {
    resume: async () => {
      resumes += 1;
      return renewed;
    },
  }, {
    observe: async session => {
      assert.equal(session.accessToken, renewed.accessToken);
      return observation("obs-after-proactive-renewal");
    },
    command: async () => { throw new Error("command is not expected"); },
  }, () => 0);

  assert.equal((await recovery.observe()).id, "obs-after-proactive-renewal");
  assert.equal(resumes, 1);
});

test("renews a near-expiry session before an action without replaying it", async () => {
  const original = trustedSession("http://192.168.1.10:38473", 1_000, "expiring-token");
  const renewed = trustedSession("http://192.168.1.10:38473", 600_000, "renewed-token");
  let actionAttempts = 0;
  const recovery = new ResilientDeviceSession(original, {
    resume: async () => renewed,
  }, {
    observe: async () => observation("unused"),
    command: async session => {
      actionAttempts += 1;
      assert.equal(session.accessToken, renewed.accessToken);
      return { outcome: "succeeded", detail: "手机操作已完成。" };
    },
  }, () => 0);

  assert.equal((await recovery.command({ action: "tap", x: 12, y: 34, stepSummary: "点击搜索框", expectedObservationId: "obs-1" })).outcome, "succeeded");
  assert.equal(actionAttempts, 1);
});

test("never retries a device action after a LAN address change", async () => {
  const original = trustedSession("http://192.168.1.10:38473");
  let actionAttempts = 0;
  let recoveries = 0;
  const recovery = new ResilientDeviceSession(original, {
    resume: async () => {
      recoveries += 1;
      return trustedSession("http://192.168.1.55:45678");
    },
  }, {
    observe: async () => observation("unused"),
    command: async () => {
      actionAttempts += 1;
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    () => recovery.command({ action: "tap", x: 12, y: 34, stepSummary: "点击搜索框", expectedObservationId: "obs-1" }),
    ActionRequiresFreshObservationError,
  );
  assert.equal(actionAttempts, 1);
  assert.equal(recoveries, 1);
});

test("resumes a trusted session through current LAN discovery instead of the old card endpoint", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const identity = {
    hostId: "host-a",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const profile = { deviceId: "agent-device-a", displayName: "Pixel 9", discoveryServiceType: "_huahua-device-agent._tcp.", hostId: "host-a" };
  const calls = [];
  const client = new HuahuaLanClient(async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/v2/trusted-sessions/challenges")) {
      return new Response(JSON.stringify({ ok: true, challenge_id: "challenge-1", challenge: Buffer.from("challenge").toString("base64url") }));
    }
    return new Response(JSON.stringify({ ok: true, host_access_token: "short-token", expires_at_ms: 9999 }));
  }, async () => {}, {
    resolve: async (deviceId, serviceType) => {
      assert.equal(deviceId, "agent-device-a");
      assert.equal(serviceType, "_huahua-device-agent._tcp.");
      return "http://192.168.1.55:45678";
    },
  });

  const session = await client.resume(profile, identity);

  assert.equal(session.accessToken, "short-token");
  assert.equal(session.card.endpoint, "http://192.168.1.55:45678");
  assert.match(calls[0].url, /^http:\/\/192\.168\.1\.55:45678\/v2\/trusted-sessions\/challenges$/);
  assert.match(calls[1].url, /^http:\/\/192\.168\.1\.55:45678\/v2\/trusted-sessions$/);
  assert.equal(JSON.parse(calls[1].init.body).hostId, "host-a");
  assert.ok(JSON.parse(calls[1].init.body).signature);
});

function trustedSession(endpoint, expiresAtMs = Date.now() + 10 * 60_000, accessToken = "short-token") {
  return {
    hostId: "host-a",
    accessToken,
    expiresAtMs,
    card: {
      connectionId: "trusted-session",
      endpoint,
      bootstrapToken: "",
      displayName: "Pixel 9",
      expiresAtMs,
      deviceId: "agent-device-a",
      discoveryServiceType: "_huahua-device-agent._tcp.",
    },
  };
}

function observation(id) {
  return {
    id, capturedAtMs: 100, imageBase64: "AQI=", imageMimeType: "image/jpeg", foregroundApp: "com.example",
    coordinateSpace: "normalized_0_to_1000", visualLayout: "single", uiTreeStatus: "unavailable", uiTree: [],
  };
}

test("uses the v3 normalized observation route and only the returned short token after resume", async () => {
  const session = {
    hostId: "host-a",
    accessToken: "short-token",
    expiresAtMs: 9999,
    card: {
      connectionId: "trusted-session", endpoint: "http://192.168.1.55:45678", bootstrapToken: "", displayName: "Pixel 9", expiresAtMs: 9999,
      deviceId: "agent-device-a", discoveryServiceType: "_huahua-device-agent._tcp.",
    },
  };
  const client = new HuahuaLanClient(async (url, init) => {
    assert.equal(url, "http://192.168.1.55:45678/v3/observe?host_id=host-a");
    assert.equal(init.headers.authorization, "Bearer short-token");
    return new Response(JSON.stringify({ ok: true, observation_id: "obs-1", captured_at_ms: 1, image_base64: "", image_mime_type: "image/jpeg", foreground_app: "", visual_layout: "single", coordinate_space: "normalized_0_to_1000", ui_tree_status: "unavailable", ui_tree: [] }));
  });

  await client.observe(session);
});

test("reports the trusted host heartbeat through the v2 route", async () => {
  const session = trustedSession("http://192.168.1.55:45678", 9999, "trusted-token");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const client = new HuahuaLanClient(async (url, init) => {
    assert.equal(url, "http://192.168.1.55:45678/v2/trusted-sessions/heartbeat");
    assert.equal(init.headers.authorization, "Bearer trusted-token");
    assert.deepEqual(JSON.parse(init.body), { hostId: "host-a", mcpVersion: manifest.version });
    return new Response(JSON.stringify({ ok: true }));
  });

  await client.heartbeat(session);
});

test("waits for explicit phone approval before returning a device session", async () => {
  let calls = 0;
  const fetchImpl = async () => new Response(JSON.stringify(++calls === 1
    ? { ok: true, request_id: "request-1", status: "pending" }
    : { ok: true, status: "approved", host_access_token: "host-token", expires_at_ms: 9999 }), { status: calls === 2 ? 202 : 200 });
  const client = new HuahuaLanClient(fetchImpl, async () => {});
  const session = await client.connect(parseConnectionCard(cardText, 1), "host-a", "Codex");
  assert.equal(session.accessToken, "host-token");
  assert.equal(session.hostId, "host-a");
});

test("reads an authorized current-screen observation", async () => {
  const card = parseConnectionCard(cardText, 1);
  const session = { card, hostId: "host-a", accessToken: "host-token", expiresAtMs: 9999 };
  const client = new HuahuaLanClient(async (url, init) => {
    assert.equal(url, `${card.endpoint}/v3/observe?host_id=host-a`);
    assert.equal(init.headers.authorization, "Bearer host-token");
    return new Response(JSON.stringify({
      ok: true,
      observation_id: "obs-1",
      captured_at_ms: 100,
      image_base64: "AQI=",
      image_mime_type: "image/jpeg",
      foreground_app: "com.example.app",
      visual_layout: "single",
      coordinate_space: "normalized_0_to_1000",
      ui_tree_status: "unavailable",
      ui_tree: [],
    }));
  });

  const observation = await client.observe(session);

  assert.equal(observation.id, "obs-1");
  assert.equal(observation.imageBase64, "AQI=");
  assert.equal(observation.imageMimeType, "image/jpeg");
  assert.equal(observation.foregroundApp, "com.example.app");
});

test("sends ordinary text with its observed-page precondition", async () => {
  const card = parseConnectionCard(cardText, 1);
  const session = { card, hostId: "host-a", accessToken: "host-token", expiresAtMs: 9999 };
  const client = new HuahuaLanClient(async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), {
      hostId: "host-a",
      action: "input_text",
      text: "666",
      step_summary: "输入文字",
      expected_observation_id: "obs-1",
    });
    return new Response(JSON.stringify({ ok: true, outcome: "succeeded", detail: "手机操作已完成。" }));
  });

  const response = await client.command(session, {
    action: "input_text",
    text: "666",
    stepSummary: "输入文字",
    expectedObservationId: "obs-1",
  });

  assert.equal(response.outcome, "succeeded");
});

test("starts a phone task with the user's original command", async () => {
  const card = parseConnectionCard(cardText, 1);
  const session = { card, hostId: "host-a", accessToken: "host-token", expiresAtMs: 9999 };
  const client = new HuahuaLanClient(async (url, init) => {
    assert.equal(url, `${card.endpoint}/v3/tasks/start`);
    assert.equal(init.headers.authorization, "Bearer host-token");
    assert.deepEqual(JSON.parse(init.body), {
      hostId: "host-a",
      user_command: "打开抖音，搜索概率论",
    });
    return new Response(JSON.stringify({ ok: true }));
  });

  await client.startTask(session, "  打开抖音，搜索概率论  ");
});
