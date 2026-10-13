import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexInferenceProvider } from '../dist/codex-inference-provider.js';
import { selectInferenceProvider } from '../dist/phone-inference-provider.js';
import { PhoneDelegation } from '../dist/phone-delegation.js';
import { samplePhoneRequest, SampleInvalidated } from '../dist/codex-phone-sampler.js';
import { systemHttpsProxy, resolveCodexBinary } from '../dist/codex-app-server.js';

test('system proxy accepts enabled valid HTTPS configuration only', () => {
 assert.equal(systemHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890'), 'http://127.0.0.1:7890');
 assert.equal(systemHttpsProxy('HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890'), undefined);
 assert.equal(systemHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : host\nHTTPSPort : 99999'), undefined);
});
const tool={type:'function',function:{name:'observe_ui',description:'observe',parameters:{type:'object',properties:{}}}};

test('desktop Codex is discovered without requiring custom PATH configuration', () => {
 const bundled='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
 assert.equal(resolveCodexBinary({},'darwin',p=>p===bundled),bundled);
 assert.equal(resolveCodexBinary({PATH:'/usr/local/bin'},'darwin',p=>p==='/usr/local/bin/codex'),'/usr/local/bin/codex');
});

test('phone owns loop/history; each native Codex session supplies one sample with real image', async () => {
 let status='RUNNING', sample=0, closed=0;
 const configs=[], inputs=[], submitted=[];
 const device={async agentRequest(op,args) {
  if(op==='inference_submit') {submitted.push(args);sample++;if(sample===2)status='COMPLETED';return {ok:true};}
  if(op==='pause') {status='PAUSED';return {ok:true};}
  const agent={id:'child',goal:'phone-owned goal',inferenceSource:'controller',status,outcome:status==='COMPLETED'?{summary:'done'}:undefined};
  return {ok:true,agent,requests:status==='RUNNING'?[{requestId:'sample-'+sample,purpose:'gui',tools:[tool],messages:[{role:'user',content:'phone-owned history '+sample},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AQI='}}]}]}]:[]};
 }};
 const factory=()=>{
  const n=inputs.length;
  let isClosed=false;
  const codex={onFailure:()=>{},onNotification:()=>{},onToolCall:()=>{},async initialize(){},close(){if(!isClosed)closed++;isClosed=true;},async request(method,params) {
   if(method==='thread/start') {configs.push(params);return {thread:{id:'thread-'+n},model:'configured-model'};}
   inputs.push(params.input);
   queueMicrotask(async()=>{
    if(n===0) await codex.onToolCall({threadId:'thread-'+n,callId:'call-1',tool:'observe_ui',arguments:{}});
    else {codex.onNotification('item/completed',{threadId:'thread-'+n,item:{type:'agentMessage',text:'done'}});codex.onNotification('turn/completed',{threadId:'thread-'+n,turn:{status:'completed'}});}
   });
   return {turn:{status:'inProgress'}};
  }};return codex;
 };
 const manager=new PhoneDelegation(device,new CodexInferenceProvider(factory));
 assert.ok(!('messages' in await manager.start('child')));
 for(let i=0;i<100&&manager.status('child').state!=='COMPLETED';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(manager.status('child').state,'COMPLETED');assert.equal(closed,2);
 assert.equal(configs.length,2);
 for(const config of configs) {assert.equal(config.ephemeral,true);assert.equal(config.sandbox,'read-only');assert.deepEqual(config.dynamicTools.map(t=>t.name),['observe_ui']);}
 assert.ok(inputs[1][0].text.includes('phone-owned history 1'));
 assert.ok(!inputs[1][0].text.includes('"parameters"'));
 assert.ok(!inputs[1][0].text.includes('phone-owned history 0'));
 assert.equal(inputs[0][1].url,'data:image/png;base64,AQI=');
 assert.equal(submitted[0].response.tool_calls[0].function.name,'observe_ui');
 assert.deepEqual(submitted[1].response,{content:'done'});
 await manager.close();
});

test('steering or pause invalidates native inference without submitting an old decision', async()=>{
 const codex={onFailure:()=>{},onNotification:()=>{},onToolCall:()=>{},async initialize(){},async request(method){return method==='thread/start'?{thread:{id:'t'}}:{turn:{status:'inProgress'}};}};
 await assert.rejects(samplePhoneRequest(codex,{requestId:'r',tools:[tool],messages:[]},'/tmp',{agent_id:'a'},async()=>false),SampleInvalidated);
});

test('expired phone deadline cancels a stuck Codex bootstrap and closes the process', async()=>{
 let closed=0, threadStarted=0;
 const provider=new CodexInferenceProvider(()=>({onFailure:()=>{},onNotification:()=>{},onToolCall:()=>{},
  initialize:()=>new Promise(()=>{}), request:async()=>{threadStarted++;},close(){closed++;}}));
 await assert.rejects(provider.sample({requestId:'expired',deadlineAtMs:Date.now(),messages:[],tools:[]},'/tmp',{agent_id:'a'},async()=>true),/timed out/);
 assert.equal(closed,1);assert.equal(threadStarted,0);
});

test('steering during thread creation aborts bootstrap without waiting for RPC timeout', async()=>{
 let closed=0,turnStarted=0,threadRequested=false;
 const provider=new CodexInferenceProvider(()=>({onFailure:()=>{},onNotification:()=>{},onToolCall:()=>{},async initialize(){},
  request(method){if(method==='thread/start'){threadRequested=true;return new Promise(()=>{});}turnStarted++;return Promise.resolve({});},close(){closed++;}}));
 await assert.rejects(provider.sample({requestId:'old',messages:[],tools:[]},'/tmp',{agent_id:'a'},async()=>false),SampleInvalidated);
 assert.equal(threadRequested,true);assert.equal(closed,1);assert.equal(turnStarted,0);
});

test('paused bridge stays attached and phone resume triggers fresh inference without another delegation', async()=>{
 let status='RUNNING', generation=0, processes=0, submissions=0;
 const device={async agentRequest(op,args){
  if(op==='pause'){status='PAUSED';return {ok:true};}
  if(op==='inference_submit'){submissions++;status='COMPLETED';return {ok:true};}
  return {agent:{id:'a',goal:'observe',inferenceSource:'controller',status},requests:status==='RUNNING'?[{requestId:'r'+generation,messages:[],tools:[]}]:[]};
 }};
 const factory=()=>{const n=processes++;const c={onFailure:()=>{},onNotification:()=>{},onToolCall:()=>{},async initialize(){},close(){},async request(method){
  if(method==='thread/start')return {thread:{id:'t'+n}};
  if(n===0){status='PAUSED';generation++;}
  else queueMicrotask(()=>{c.onNotification('item/completed',{item:{type:'agentMessage',text:'done'}});c.onNotification('turn/completed',{turn:{status:'completed'}});});
  return {turn:{status:'inProgress'}};
 }};return c;};
 const m=new PhoneDelegation(device,new CodexInferenceProvider(factory));await m.start('a');
 for(let i=0;i<200&&m.status('a').state!=='PAUSED';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(m.status('a').state,'PAUSED');assert.equal(submissions,0);
 status='RUNNING';
 for(let i=0;i<200&&m.status('a').state!=='COMPLETED';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(m.status('a').state,'COMPLETED');assert.equal(submissions,1);assert.equal(processes,2);
 await m.close();
});


test('automatic backend never silently borrows Codex for another host',()=>{
 assert.equal(selectInferenceProvider('Codex-validation','auto'),'codex');
 for(const host of ['claude-code','WorkBuddy','codebuddy','unknown',undefined]) assert.throws(()=>selectInferenceProvider(host,'auto'),/不会自动借用 Codex/);
 assert.equal(selectInferenceProvider('claude-code','codex'),'codex');
});

test('generic provider can supply phone decisions without constructing a Codex client',async()=>{
 let done=false,sampled=0;
 const device={async agentRequest(op){
  if(op==='inference_submit'){done=true;return {ok:true};}
  return {agent:{id:'g',goal:'observe',inferenceSource:'controller',status:done?'COMPLETED':'RUNNING'},requests:done?[]:[{requestId:'r',messages:[],tools:[]}]};
 }};
 const provider={id:'test-host',async sample(){sampled++;return {content:'host model answer'};},cancel(){}};
 const m=new PhoneDelegation(device,provider);await m.start('g');
 for(let i=0;i<100&&m.status('g').state!=='COMPLETED';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(m.status('g').state,'COMPLETED');assert.equal(m.status('g').inference_provider,'test-host');assert.equal(sampled,1);
 await m.close();
});

test('unsupported host is rejected before creating a phone task, capabilities remain inspectable',async()=>{
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {registerPhoneDelegationTools}=await import('../dist/phone-delegation.js');
 let calls=0;
 const server=new McpServer({name:'test',version:'1'});
 const manager=registerPhoneDelegationTools(server,{async agentRequest(){calls++;throw new Error('must not start');}});
 const client=new Client({name:'claude-code',version:'test'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try {
  const result=await client.callTool({name:'device_agent_delegate',arguments:{goal:'observe',request_id:'r'}});
  assert.equal(result.isError,true);assert.equal(calls,0);
  const capability=JSON.parse((await client.callTool({name:'device_agent_inference_capabilities',arguments:{}})).content[0].text);
  assert.equal(capability.automatic_backend,null);assert.equal(capability.host.name,'claude-code');
 } finally{await manager.close();await client.close();await server.close();}
});

test('phone sampling disables arbitrary inherited MCP names without touching user config', async () => {
 const { disabledMcpOverrides } = await import('../dist/codex-app-server.js');
 const global='[mcp_servers.huahua]\ncommand = "node"\n[mcp_servers."other-tools"]\nurl = "http://localhost"\n';
 const project='[mcp_servers.project_tool]\ncommand = "tool"\n[mcp_servers.huahua]\nenabled = true\n';
 const args=disabledMcpOverrides([global, project]);
 const { parse } = await import('smol-toml');
 assert.deepEqual(JSON.parse(JSON.stringify(parse(args[1]).mcp_servers)), { huahua:{enabled:false}, 'other-tools':{enabled:false}, project_tool:{enabled:false} });
 assert.throws(()=>disabledMcpOverrides(['[broken']));
 assert.deepEqual(JSON.parse(JSON.stringify(parse(disabledMcpOverrides(['[mcp_servers."name.with.dots"]\ncommand = "tool"'])[1]).mcp_servers)), {'name.with.dots':{enabled:false}});
});
