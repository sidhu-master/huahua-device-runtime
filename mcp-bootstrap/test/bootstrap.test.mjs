import assert from "node:assert/strict";
import test from "node:test";
import { HuahuaLanClient, parseConnectionCard } from "../dist/index.js";

const cardText = "huahua://device-agent/v1?connection_id=Y29ubmVjdGlvbi0x&endpoint=aHR0cDovLzE5Mi4xNjguMS4xMDozODQ3Mw&token=Ym9vdHN0cmFwLXNlY3JldA&name=UGl4ZWwgOQ&expires_at_ms=4102444800000";

test("parses the Android connection card format", () => {
  const card = parseConnectionCard(cardText, 1);
  assert.equal(card.connectionId, "connection-1");
  assert.equal(card.endpoint, "http://192.168.1.10:38473");
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
      png_base64: "AQI=",
      foreground_app: "com.example.app",
      screen_width: 1080,
      screen_height: 2400,
    }));
  });

  const observation = await client.observe(session);

  assert.equal(observation.id, "obs-1");
  assert.equal(observation.pngBase64, "AQI=");
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
