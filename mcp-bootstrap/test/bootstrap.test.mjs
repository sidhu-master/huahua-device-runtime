import assert from "node:assert/strict";
import test from "node:test";
import { HuahuaLanClient, parseConnectionCard } from "../dist/index.js";
import { HostIdentityStore } from "../dist/host-identity-store.js";
import { DeviceProfileStore } from "../dist/device-profile-store.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cardText = "huahua://device-agent/v1?connection_id=Y29ubmVjdGlvbi0x&endpoint=aHR0cDovLzE5Mi4xNjguMS4xMDozODQ3Mw&token=Ym9vdHN0cmFwLXNlY3JldA&name=UGl4ZWwgOQ&expires_at_ms=4102444800000";

test("parses the Android connection card format", () => {
  const card = parseConnectionCard(cardText, 1);
  assert.equal(card.connectionId, "connection-1");
  assert.equal(card.endpoint, "http://192.168.1.10:38473");
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

test("uses the v2 observation route and only the returned short token after resume", async () => {
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
    assert.equal(url, "http://192.168.1.55:45678/v2/observe?host_id=host-a");
    assert.equal(init.headers.authorization, "Bearer short-token");
    return new Response(JSON.stringify({ ok: true, observation_id: "obs-1", captured_at_ms: 1, image_base64: "", image_mime_type: "image/jpeg", foreground_app: "", screen_width: 1, screen_height: 1 }));
  });

  await client.observe(session);
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
    assert.equal(url, `${card.endpoint}/v1/observe?host_id=host-a`);
    assert.equal(init.headers.authorization, "Bearer host-token");
    return new Response(JSON.stringify({
      ok: true,
      observation_id: "obs-1",
      captured_at_ms: 100,
      image_base64: "AQI=",
      image_mime_type: "image/jpeg",
      foreground_app: "com.example.app",
      screen_width: 1080,
      screen_height: 2400,
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
