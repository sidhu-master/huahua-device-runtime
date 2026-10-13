import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetTaskScheduler } from '../dist/fleet-task-scheduler.js';
import { FleetInferenceLimit } from '../dist/fleet-inference-limit.js';
import { SampleInvalidated } from '../dist/phone-inference-provider.js';
import { FleetTaskJournal } from '../dist/fleet-task-journal.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for(let i=0;i<400;i++){if(fn())return;await sleep(10);}throw Error('condition timed out'); }
function setup(saved=[]) {
 let rows=structuredClone(saved); const calls=[]; const agents=new Map();
 const devices={ async get(id){if(!['A','B'].includes(id))throw Error('unpaired');
  return {async agentRequest(op,args){calls.push({device:id,op,args});let agent=agents.get(id);
   if(op==='list')return {agents:agent?[agent]:[]};
   if(op==='start'){agent={id:'same-agent-id',goal:args.goal,requestId:args.request_id,status:'RUNNING',inferenceSource:'controller'};agents.set(id,agent);}
   if(op==='inference_submit')agent.status='COMPLETED';
   if(op==='pause')agent.status='PAUSED';if(op==='resume')agent.status='RUNNING';if(op==='interrupt')agent.status='CANCELLED';
   return {agent:structuredClone(agent), requests:agent.status==='RUNNING'?[{requestId:'sample-'+agent.requestId,tools:[],messages:[{role:'user',content:id+':'+agent.goal}]}]:[]};
  }};
 }};
 const journal={async load(){return structuredClone(rows);},async save(value){rows=structuredClone(value);}};
 const provider=()=>({id:'codex-test',async sample(request){await sleep(80);return {content:request.messages[0].content};},cancel(){}});
 const scheduler=new FleetTaskScheduler(devices,journal,2,provider);
 return {scheduler,devices,journal,calls,agents,rows:()=>rows};
}

test('fleet routes independent contexts despite equal phone agent IDs, serializes same phone, runs other phone concurrently', async()=>{
 const f=setup();await f.scheduler.initialize();
 try {
  const a=await f.scheduler.delegate('A','alpha','a1');const a2=await f.scheduler.delegate('A','second','a2');const b=await f.scheduler.delegate('B','beta','b1');
  await until(()=>[a,a2,b].every(t=>f.scheduler.status(t.task_id).state==='COMPLETED'));
  const starts=f.calls.filter(c=>c.op==='start');assert.deepEqual(starts.slice(0,2).map(c=>c.device).sort(),['A','B']);
  const firstSubmit=f.calls.findIndex(c=>c.device==='A'&&c.op==='inference_submit');const nextStart=f.calls.findIndex(c=>c.op==='start'&&c.args.request_id==='a2');assert.ok(nextStart>firstSubmit);
  assert.deepEqual(f.calls.filter(c=>c.op==='inference_submit').map(c=>c.args.response.content).sort(),['A:alpha','A:second','B:beta']);
 } finally {await f.scheduler.close();}
});

test('concurrent retries are idempotent and goal conflicts/unknown phones have no task side effects',async()=>{
 const f=setup();await f.scheduler.initialize();
 try {
  const [a,b]=await Promise.all([f.scheduler.delegate('A','goal','r'),f.scheduler.delegate('A','goal','r')]);assert.equal(a.task_id,b.task_id);
  await assert.rejects(f.scheduler.delegate('A','different','r'),/conflict/);await assert.rejects(f.scheduler.delegate('X','goal','r'),/unpaired/);assert.equal(f.scheduler.list().length,1);
 }finally{await f.scheduler.close();}
});

test('cancel queued task never starts phone execution and cannot be resumed',async()=>{
 const f=setup();await f.scheduler.initialize();
 try{const a=await f.scheduler.delegate('A','goal','r');await f.scheduler.control(a.task_id,'interrupt');await sleep(350);
 assert.equal(f.scheduler.status(a.task_id).state,'CANCELLED');assert.equal(f.calls.length,0);await assert.rejects(f.scheduler.control(a.task_id,'resume'),/terminal/);
 }finally{await f.scheduler.close();}
});

test('restart requires recovery, attaches existing running phone task without replaying start',async()=>{
 const f=setup([{task_id:'saved',device_id:'A',request_id:'r',goal:'goal',state:'RUNNING',phone_agent_id:'same-agent-id',created_at_ms:1,updated_at_ms:1}]);
 f.agents.set('A',{id:'same-agent-id',requestId:'r',goal:'goal',status:'RUNNING',inferenceSource:'controller'});await f.scheduler.initialize();
 try{assert.equal(f.scheduler.status('saved').state,'RECOVERY_REQUIRED');await sleep(300);assert.equal(f.calls.length,0);
 await f.scheduler.control('saved','resume');await until(()=>f.scheduler.status('saved').state==='COMPLETED');assert.equal(f.calls.filter(c=>c.op==='start'||c.op==='resume').length,0);
 }finally{await f.scheduler.close();}
});

test('lost start reply recovers matching request; unrelated phone task prevents new start',async()=>{
 const f=setup();f.agents.set('A',{id:'same-agent-id',requestId:'r',goal:'goal',status:'RUNNING',inferenceSource:'controller'});await f.scheduler.initialize();
 try{const a=await f.scheduler.delegate('A','goal','r');await until(()=>f.scheduler.status(a.task_id).state==='COMPLETED');assert.equal(f.calls.filter(c=>c.op==='start').length,0);
 f.agents.set('B',{id:'other',requestId:'other',goal:'other',status:'PAUSED',inferenceSource:'controller'});const b=await f.scheduler.delegate('B','new','new');await until(()=>f.scheduler.status(b.task_id).state==='RECOVERY_REQUIRED');assert.equal(f.calls.filter(c=>c.device==='B'&&c.op==='start').length,0);
 }finally{await f.scheduler.close();}
});

test('FIFO inference limit handles invalidated and expired waiters without leaking capacity',async()=>{
 const limit=new FleetInferenceLimit(1);let release;let entered=[];
 const wrapped=limit.wrap({id:'codex',cancel(){},async sample(r){entered.push(r.requestId);if(r.requestId==='first')await new Promise(ok=>release=ok);return {content:'done'};}});
 const first=wrapped.sample({requestId:'first'},'/tmp',{},async()=>true);await until(()=>!!release);
 await assert.rejects(wrapped.sample({requestId:'stale'},'/tmp',{},async()=>false),SampleInvalidated);
 await assert.rejects(wrapped.sample({requestId:'expired',deadlineAtMs:Date.now()},'/tmp',{},async()=>true),/deadline/);
 const second=wrapped.sample({requestId:'second'},'/tmp',{},async()=>true);release();await Promise.all([first,second]);assert.deepEqual(entered,['first','second']);
});

test('task journal atomic writes survive parallel saves and preserve recovery routing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'huahua-fleet-test-'));
 try{const j=new FleetTaskJournal(join(dir,'tasks.json'));assert.deepEqual(await j.load(),[]);
 const task={task_id:'t',device_id:'A',request_id:'r',goal:'goal',state:'QUEUED',created_at_ms:1,updated_at_ms:1};
 await Promise.all([j.save([task]),j.save([{...task,state:'PAUSED'}])]);assert.equal((await j.load())[0].state,'PAUSED');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('fleet MCP explicitly routes tasks, rejects non-Codex hosts and ambiguous device omission',async()=>{
 const {startFleetMcp}=await import('../dist/fleet-mcp.js');
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const f=setup();
 const fleet={async list(){return [{deviceId:'A',displayName:'same'},{deviceId:'B',displayName:'same'}];},async get(id){if(!id)throw Error('explicit device_id required');await f.devices.get(id);return {connectionStatus:{deviceId:id}};},close(){},async status(id){return {device_id:id,state:'connected'};}};
 const [ct,st]=InMemoryTransport.createLinkedPair();const host=await startFleetMcp(fleet,st,f.scheduler);const client=new Client({name:'Codex-test',version:'1'});await client.connect(ct);
 try {
  const toolNames=(await client.listTools()).tools.map(t=>t.name);assert.ok(!toolNames.includes('device_tap'));assert.ok(!toolNames.includes('device_agent_reply'));
  const list=JSON.parse((await client.callTool({name:'device_list',arguments:{}})).content[0].text);assert.deepEqual(list.devices.map(d=>d.device_id),['A','B']);
  assert.equal((await client.callTool({name:'device_agent_delegate',arguments:{goal:'goal',request_id:'r'}})).isError,true);
  const result=JSON.parse((await client.callTool({name:'device_agent_delegate',arguments:{device_id:'B',goal:'goal',request_id:'r'}})).content[0].text);
  await until(()=>f.scheduler.status(result.task_id).state==='COMPLETED');assert.equal(f.calls.filter(c=>c.op==='start')[0].device,'B');
  assert.equal((await client.callTool({name:'device_agent_worker_status',arguments:{task_id:'unknown'}})).isError,true);
 }finally{await f.scheduler.close();await client.close();await host.server.close();}
 const second=setup();const [ct2,st2]=InMemoryTransport.createLinkedPair();const host2=await startFleetMcp(fleet,st2,second.scheduler);const other=new Client({name:'WorkBuddy',version:'1'});await other.connect(ct2);
 try{const r=await other.callTool({name:'device_agent_delegate',arguments:{device_id:'B',goal:'goal',request_id:'r'}});assert.equal(r.isError,true);assert.equal(second.scheduler.list().length,0);}
 finally{await second.scheduler.close();await other.close();await host2.server.close();}
});

test('LAN agent list uses existing authenticated endpoint and rejects unknown operations',async()=>{
 const {HuahuaLanClient}=await import('../dist/client.js');let request;
 const client=new HuahuaLanClient(async(url,init)=>{request={url,init};return new Response(JSON.stringify({ok:true,agents:[]}));});
 const session={card:{endpoint:'http://phone'},hostId:'approved',accessToken:'test-token'};
 await client.agentRequest(session,'list',{host_id:'spoof'});assert.equal(request.url,'http://phone/v4/agents/list');assert.equal(JSON.parse(request.init.body).host_id,'approved');
 await assert.rejects(client.agentRequest(session,'unknown',{}),/Unknown agent operation/);
});

test('journal lease rejects a second fleet process and can be reacquired after shutdown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'huahua-fleet-lease-'));const a=new FleetTaskJournal(join(dir,'tasks.json'));const b=new FleetTaskJournal(join(dir,'tasks.json'));
 try{await a.acquire();await assert.rejects(b.acquire(),/in use/);await a.release();await b.acquire();}
 finally{await a.release();await b.release();await rm(dir,{recursive:true,force:true});}
});

test('provider failure pauses the phone and remains recoverable instead of silently failing over',async()=>{
 const f=setup();const scheduler=new FleetTaskScheduler(f.devices,f.journal,2,()=>({id:'codex',async sample(){throw Error('model unavailable');},cancel(){}}));await scheduler.initialize();
 try{const task=await scheduler.delegate('A','goal','r');await until(()=>scheduler.status(task.task_id).state==='RECOVERY_REQUIRED');assert.equal(f.agents.get('A').status,'PAUSED');assert.ok(scheduler.status(task.task_id).summary.includes('model unavailable'));
 }finally{await scheduler.close();}
});

test('fleet startup heartbeats every paired device without a tool call and closes safely', async () => {
 const { DeviceFleet } = await import('../dist/device-fleet.js');
 const beats=[];
 const fleet=new DeviceFleet({list:async()=>['a','b'].map(deviceId=>({deviceId}))},
  {resume:async deviceId=>({card:{endpoint:'http://127.0.0.1:1',deviceId},hostId:'host',accessToken:'test',expiresAtMs:Date.now()+60000})},
  {heartbeat:async session=>{beats.push(session.card.deviceId);return {};}});
 try {await fleet.start(); await new Promise(r=>setImmediate(r));assert.deepEqual([...new Set(beats)].sort(),['a','b']);}
 finally{fleet.close();}
 await assert.rejects(()=>fleet.get('a'),/closed/);
});
