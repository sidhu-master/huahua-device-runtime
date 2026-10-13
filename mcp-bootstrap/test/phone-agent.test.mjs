import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPhoneAgentTools, inferenceContent } from '../dist/phone-agent-tools.js';
import { HuahuaLanClient } from '../dist/client.js';

test('existing MCP starts child, submits decision and returns next sampling with real image block', async () => {
  const operations = [];
  let replied = false; let stale = true;
  const device = { async agentRequest(op, args) {
    operations.push([op, args]);
    if (op === 'start') return { ok: true, agent: { id: 'child' } };
    if (op === 'inference_submit') { replied = true; return { ok: true }; }
    const requestId = replied && !stale ? 'next-2' : 'next';
    if (replied) stale = false;
    return { ok: true, agent: { id: 'child', status: 'RUNNING' }, requests: [{ requestId, messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } }] }
    ] }] };
  } };
  const server = new McpServer({ name: 'test', version: '1' });
  registerPhoneAgentTools(server, device);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'codex', version: '1' });
  await server.connect(st); await client.connect(ct);
  try {
    const first = await client.callTool({ name: 'device_agent_start', arguments: { goal: '打开设置', request_id: 'start-id' } });
    assert.equal(operations[0][1].inference_source, 'controller');
    assert.equal(first.content[1].type, 'image');
    assert.equal(first.content[1].data, 'AQI=');
    assert.ok(!first.content[0].text.includes('base64'));
    const second = await client.callTool({ name: 'device_agent_reply', arguments: { agent_id: 'child', request_id: 'next', response: {
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'observe_ui', arguments: '{}' } }]
    } } });
    assert.equal(JSON.parse(second.content[0].text).requests[0].requestId, 'next-2');
    assert.deepEqual(operations.map(x => x[0]), ['start', 'inference_read', 'inference_submit', 'inference_read', 'inference_read']);
  } finally { await client.close(); await server.close(); }
});

test('agent extension uses same trusted-session endpoint and authentic host identity', async () => {
  let request;
  const client = new HuahuaLanClient(async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await client.agentRequest({ card: { endpoint: 'http://phone' }, hostId: 'trusted', accessToken: 'token' }, 'read', { agent_id: 'child', host_id: 'spoofed' });
  assert.equal(request.url, 'http://phone/v4/agents/read');
  assert.equal(JSON.parse(request.init.body).host_id, 'trusted');
  assert.equal(request.init.headers.authorization, 'Bearer token');
});

test('external image URL cannot turn evidence into a remote fetch', () => {
  assert.throws(() => inferenceContent({ image_url: { url: 'https://untrusted/image' } }));
});

test('manual decisions cannot race an attached automatic inference bridge',async()=>{
 const server=new McpServer({name:'test',version:'1'});
 registerPhoneAgentTools(server,{async agentRequest(){throw new Error('must not submit');}},()=>true);
 const client=new Client({name:'test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);
 try {
  const result=await client.callTool({name:'device_agent_reply',arguments:{agent_id:'a',request_id:'r',response:{content:'manual'}}});
  assert.equal(result.isError,true);assert.ok(result.content[0].text.includes('Automatic inference bridge owns'));
 }finally{await client.close();await server.close();}
});
