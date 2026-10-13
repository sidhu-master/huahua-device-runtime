import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkBuddyAcpProvider } from '../dist/workbuddy-acp-provider.js';
import { SampleInvalidated } from '../dist/phone-inference-provider.js';

async function fixture(mode) {
  const dir = await mkdtemp(join(tmpdir(), 'huahua-acp-test-'));
  const script = join(dir, 'fake.mjs'), log = join(dir, 'evidence.json');
  await writeFile(script, `
    import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
    const [log,mode]=process.argv.slice(2); let tools;
    function send(x){process.stdout.write('\\x1b]0;CLI\\x07\\x00'+JSON.stringify(x)+'\\n');}
    for await(const line of createInterface({input:process.stdin})) {
      const m=JSON.parse(line);
      if(m.method==='initialize') send({id:m.id,result:{agentCapabilities:{delegateToolsSupport:true,promptCapabilities:{image:true}}}});
      if(m.method==='session/new') send({id:m.id,result:{sessionId:'fresh'}});
      if(m.method==='_codebuddy.ai/delegateToolsChanged'){tools=m.params.tools;send({id:m.id,result:{}});}
      if(m.method==='session/prompt') {
        writeFileSync(log,JSON.stringify({tools,prompt:m.params.prompt,args:process.argv}));
        if(mode==='wait')continue;
        send({method:'session/update',params:{sessionId:'fresh',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'not a final decision'}}}});
        send({id:99,method:'fs/read_text_file',params:{path:'/private'}});
      }
      if(m.id===99){if(!m.error)process.exit(9);send({id:100,method:'_codebuddy.ai/delegateTool',params:{toolId:'tap',toolCallId:'native-call',input:{x:1,y:2}}});}
    }
  `);
  return { dir, log, provider: new WorkBuddyAcpProvider(process.execPath, [script, log, mode]) };
}
const request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'phone goal' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] }], tools: [{ type: 'function', function: { name: 'tap', parameters: { type: 'object' } } }] };
test('ACP captures one native decision, passes real vision, denies host actions and restricts tools', async () => {
  const f = await fixture('decision');
  try {
    const result = await f.provider.sample(request, f.dir, { agent_id: 'a' }, async () => true);
    assert.deepEqual(result.tool_calls[0], { id: 'native-call', type: 'function', function: { name: 'tap', arguments: '{"x":1,"y":2}' } });
    const captured = JSON.parse(await readFile(f.log, 'utf8'));
    assert.deepEqual(captured.prompt[1], { type: 'image', data: 'AQID', mimeType: 'image/png' });
    assert.equal(captured.tools[0].id, 'tap');
    assert.ok(captured.args.includes('DelegateTool'));
    assert.ok(captured.args.includes('--strict-mcp-config'));
    assert.ok(!captured.prompt[0].text.includes('AQID'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('phone steering invalidates an ACP sample before any submission', async () => {
  const f = await fixture('wait');
  try { await assert.rejects(f.provider.sample(request, f.dir, { agent_id: 'a' }, async () => false), SampleInvalidated); }
  finally { await rm(f.dir, { recursive: true, force: true }); }
});
