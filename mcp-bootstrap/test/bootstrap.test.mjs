import assert from "node:assert/strict";
import test from "node:test";
import { HuahuaLanClient, parseConnectionCard, startMcpWithDevice } from "../dist/index.js";
import { HostIdentityStore } from "../dist/host-identity-store.js";
import { DeviceProfileStore } from "../dist/device-profile-store.js";
import { DeviceSessionManager } from "../dist/device-session-manager.js";
import { prepareHost } from "../dist/prepare-host.js";
import { resolveHostDisplayName } from "../dist/host-display-name.js";
import { ActionRequiresFreshObservationError, ResilientDeviceSession } from "../dist/resilient-device-session.js";
import { TrustedSessionHeartbeat, attachTrustedSessionHeartbeatToTransport } from "../dist/trusted-session-heartbeat.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const cardText = "huahua://device-agent/v1?connection_id=Y29ubmVjdGlvbi0x&endpoint=aHR0cDovLzE5Mi4xNjguMS4xMDozODQ3Mw&token=Ym9vdHN0cmFwLXNlY3JldA&name=UGl4ZWwgOQ&expires_at_ms=4102444800000";

test("declares the official public package name", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(manifest.name, "@newwe/huahua");
});

test("MCP maps Android semantic snapshots and diffs without default visual content", async () => {
  const observedUrls = [];
  const client = new HuahuaLanClient(async (url, init = {}) => {
    if (url.endsWith("/v3/tasks/start")) return json({ ok: true });
    if (url.endsWith("/v1/health")) return json({ ok: true, phone_control_ready: true });
    if (url.endsWith("/v2/trusted-sessions/heartbeat")) return json({ ok: true });
    if (url.includes("/v3/commands")) {
      return json({
        ok: true,
        outcome: "succeeded",
        detail: "已打开购物车",
        observation: semanticDiffObservation("obs-after-action", "snapshot-cart"),
      });
    }
    if (url.includes("/v3/observe")) {
      observedUrls.push(url);
      if (url.endsWith("&visual=true")) {
        return json({
          ...semanticDiffObservation("obs-visual", "snapshot-cart"),
          image_base64: "AQI=",
          image_mime_type: "image/jpeg",
          coordinate_space: "normalized_0_to_1000",
          visual_layout: "single",
        });
      }
      if (observedUrls.length === 1) return json(semanticSnapshotObservation("obs-first", "snapshot-home"));
      return json({
        ...semanticDiffObservation("obs-normal", "snapshot-home"),
        visual_fallback_required: true,
        visual_fallback_reason_code: "UI_TREE_UNAVAILABLE",
        image_base64: "AQI=",
        image_mime_type: "image/jpeg",
      });
    }
    throw new Error(`unexpected request: ${url} ${JSON.stringify(init)}`);
  });
  const device = new ResilientDeviceSession(trustedSession("http://127.0.0.1:1"), undefined, client);
  const [mcpTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startMcpWithDevice(device, client, serverTransport);
  const mcp = new Client({ name: "semantic-contract-test", version: "1.0.0" });
  await mcp.connect(mcpTransport);

  try {
    const started = await mcp.callTool({ name: "device_task_start", arguments: { original_user_command: "打开购物车" } });
    assert.equal(imageContent(started).length, 0);
    assert.deepEqual(textPayload(started).semantic_snapshot, semanticSnapshotObservation("obs-first", "snapshot-home").semantic_snapshot);
    assert.equal(/"ui_tree"/.test(JSON.stringify(started.content)), false);

    const normal = await mcp.callTool({ name: "device_observe", arguments: {} });
    assert.equal(imageContent(normal).length, 0);
    assert.equal(textPayload(normal).visual_fallback_required, true);
    assert.equal(textPayload(normal).next_action, "device_observe_visual");
    assert.deepEqual(textPayload(normal).semantic_diff, semanticDiffObservation("obs-normal", "snapshot-home").semantic_diff);

    const action = await mcp.callTool({ name: "device_tap", arguments: { x: 500, y: 500, step_summary: "打开购物车", observation_id: "obs-normal" } });
    assert.equal(imageContent(action).length, 0);
    assert.deepEqual(textPayload(action).semantic_diff, semanticDiffObservation("obs-after-action", "snapshot-cart").semantic_diff);
    assert.equal(observedUrls.length, 2, "actions consume their returned observation instead of observing again");

    const visual = await mcp.callTool({ name: "device_observe_visual", arguments: {} });
    assert.equal(imageContent(visual).length, 1);
    assert.equal(imageContent(visual)[0].data, "AQI=");
    assert.match(observedUrls[2], /\/v3\/observe\?host_id=host-a&visual=true$/);
  } finally {
    await mcp.close();
  }
});

function json(body) {
  return new Response(JSON.stringify(body));
}

function semanticSnapshotObservation(observationId, snapshotId) {
  return {
    ok: true,
    observation_id: observationId,
    captured_at_ms: 100,
    foreground_app: "com.example.shop",
    ui_tree_status: "available",
    semantic_snapshot: {
      snapshot_id: snapshotId,
      status: "available",
      foreground_app: "com.example.shop",
      captured_at_ms: 100,
      raw_node_count: 9,
      semantic_node_count: 2,
      semantic_character_count: 27,
      lines: [{ ref: "buy", source_index: 3, depth: 1, role: "button", label: "加入购物车" }],
    },
  };
}

function semanticDiffObservation(observationId, previousSnapshotId) {
  return {
    ok: true,
    observation_id: observationId,
    captured_at_ms: 200,
    foreground_app: "com.example.shop",
    ui_tree_status: "available",
    semantic_diff: {
      previous_snapshot_id: previousSnapshotId,
      current_snapshot_id: "snapshot-cart",
      page_changed: false,
      added: [],
      removed: [],
      changed: [{ ref: "buy", source_index: 3, depth: 1, role: "button", label: "已加入购物车" }],
    },
  };
}

function imageContent(result) {
  return result.content.filter(item => item.type === "image");
}

function textPayload(result) {
  return JSON.parse(result.content.find(item => item.type === "text" && item.text.includes("observation_id")).text);
}

test("rejects one-shot phone control commands and requires the persistent MCP server", () => {
  for (const command of ["pair", "status", "task-start", "observe", "command", "task-complete"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), command], {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /手机操作只支持通过常驻 MCP 工具执行/, command);
  }
});

test("prepare initializes the computer identity before a connection card is consumed", async () => {
  const output = [];
  let prepares = 0;

  await prepareHost({
    sessions: {
      prepare: async () => {
        prepares += 1;
        return { hostId: "host-ready" };
      },
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

test("does not publish the deferred direct CLI skill", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.doesNotMatch(manifest.description, /\bCLI\b/i);
  assert.ok(!manifest.files.includes("skills"));
  await assert.rejects(
    stat(new URL("../skills/huahua/SKILL.md", import.meta.url)),
    { code: "ENOENT" },
  );
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
    id, capturedAtMs: 100, foregroundApp: "com.example", uiTreeStatus: "available",
    semanticSnapshot: semanticSnapshotObservation(id, "snapshot-current").semantic_snapshot,
    visualFallbackRequired: false,
  };
}

test("uses the v3 semantic observation route and only the returned short token after resume", async () => {
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
    return new Response(JSON.stringify(semanticSnapshotObservation("obs-1", "snapshot-current")));
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

test("reads an authorized semantic observation without visual evidence", async () => {
  const card = parseConnectionCard(cardText, 1);
  const session = { card, hostId: "host-a", accessToken: "host-token", expiresAtMs: 9999 };
  const client = new HuahuaLanClient(async (url, init) => {
    assert.equal(url, `${card.endpoint}/v3/observe?host_id=host-a`);
    assert.equal(init.headers.authorization, "Bearer host-token");
    return new Response(JSON.stringify({
      ok: true,
      observation_id: "obs-1",
      captured_at_ms: 100,
      foreground_app: "com.example.app",
      ui_tree_status: "available",
      semantic_snapshot: semanticSnapshotObservation("obs-1", "snapshot-current").semantic_snapshot,
    }));
  });

  const observation = await client.observe(session);

  assert.equal(observation.id, "obs-1");
  assert.equal(observation.imageBase64, undefined);
  assert.equal(observation.imageMimeType, undefined);
  assert.equal(observation.foregroundApp, "com.example.app");
  assert.deepEqual(observation.semanticSnapshot, semanticSnapshotObservation("obs-1", "snapshot-current").semantic_snapshot);
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
