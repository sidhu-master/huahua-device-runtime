import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexInferenceProvider} from '../dist/codex-inference-provider.js';

function harness({failRevert=false,hang=false}={}){
 const instances=[];
 const factory=()=>{
  const id='native-'+instances.length;let turn=0,history=[];const calls=[];const seen=[];let model,effort;
  const c={calls,seen,onFailure(){},onNotification(){},onToolCall(){},closed:false,async initialize(){calls.push('initialize');},close(){c.closed=true;},async request(method,p){
   calls.push(method);
   if(method==='config/read')return {config:{service_tier:'default'}};
   if(method==='account/rateLimits/read'||method==='thread/delete'||method==='turn/interrupt')return {};
   if(method==='thread/start'){model=p.model;effort=p.config?.model_reasoning_effort;assert.equal(p.ephemeral,false);assert.equal(p.historyMode,'paginated');return {thread:{id},model,reasoningEffort:effort};}
   if(method==='thread/revert'){if(failRevert)throw Error('revert refused');assert.equal(p.threadId,id);assert.equal(p.beforeTurnId,'turn-'+(turn-1));history=[];return {thread:{id}};}
   assert.equal(method,'turn/start');seen.push({previous:[...history],input:p.input});history.push(p.input);const turnId='turn-'+turn++;
   c.onNotification('turn/started',{threadId:id,turn:{id:turnId}});
   if(!hang)queueMicrotask(()=>{
    const usage={threadId:id,tokenUsage:{total:{inputTokens:10000+turn,outputTokens:2000+turn,totalTokens:12000+2*turn},last:{inputTokens:41,cachedInputTokens:20,outputTokens:2,totalTokens:43}}};
    c.onNotification('thread/tokenUsage/updated',usage);c.onNotification('thread/tokenUsage/updated',usage);
    c.onNotification('item/completed',{threadId:id,item:{type:'agentMessage',text:'OK'}});c.onNotification('turn/completed',{threadId:id,turn:{id:turnId,status:'completed'}});
   });
   return {turn:{id:turnId}};
  }};instances.push(c);return c;
 };return {instances,provider:new CodexInferenceProvider(factory)};
}
const state=id=>({agent_id:id,model_selection:{model:'gpt-6-astra',reasoning_effort:'low',source:'custom'}});
const request=(text,purpose='gui')=>({requestId:text,purpose,messages:[{role:'user',content:text}],tools:[]});

test('same phone thread reverts history and reports sample-local usage despite cumulative/duplicate native events',async()=>{
 const {provider,instances}=harness();const s=state('a');
 try{
  await provider.sample(request('old'),'/tmp',s,async()=>true);const first=s.thread_id;
  await provider.sample(request('fresh'),'/tmp',s,async()=>true);
  assert.equal(instances.length,1);assert.equal(s.thread_id,first);assert.equal(s.sample_audit.thread_reused,true);
  assert.deepEqual(instances[0].seen[1].previous,[]);assert.ok(!JSON.stringify(instances[0].seen[1].input).includes('old'));
  assert.equal(s.token_usage.inputTokens,41);assert.equal(s.token_usage.outputTokens,2);
  assert.equal(instances[0].calls.filter(x=>x==='initialize').length,1);
  assert.equal(instances[0].calls.filter(x=>x==='config/read').length,1);
  assert.equal(instances[0].calls.filter(x=>x==='account/rateLimits/read').length,0);
 }finally{provider.cancel('a');}
});

test('phones and compaction use independent sessions; changed selected model cannot reuse stale configuration',async()=>{
 const {provider,instances}=harness();const a=state('a'),b=state('b');
 try{
  await provider.sample(request('one'),'/tmp',a,async()=>true);const gui=a.thread_id;
  await provider.sample(request('compact','compaction'),'/tmp',a,async()=>true);assert.notEqual(a.thread_id,gui);
  await provider.sample(request('two'),'/tmp',b,async()=>true);assert.notEqual(a.thread_id,b.thread_id);
  a.model_selection.model='gpt-6.1-sol';await provider.sample(request('other-model'),'/tmp',a,async()=>true);
  assert.equal(instances.length,4);assert.equal(instances[0].closed,true);assert.equal(a.model,'gpt-6.1-sol');
 }finally{provider.cancel('a');provider.cancel('b');}
});

test('failed history replacement stops before another generation instead of appending phone history',async()=>{
 const {provider,instances}=harness({failRevert:true});const s=state('a');
 try{
  await provider.sample(request('old'),'/tmp',s,async()=>true);
  await assert.rejects(provider.sample(request('new'),'/tmp',s,async()=>true),/revert refused/);
  assert.equal(instances[0].calls.filter(x=>x==='turn/start').length,1);assert.equal(instances[0].closed,true);
 }finally{provider.cancel('a');}
});

test('cancel interrupts pending generation and deletes only the internally owned thread',async()=>{
 const {provider,instances}=harness({hang:true});const s=state('a');
 const pending=provider.sample(request('pending'),'/tmp',s,async()=>true);
 for(let i=0;i<100&&!instances[0]?.calls.includes('turn/start');i++)await new Promise(r=>setTimeout(r,1));
 provider.cancel('a');await assert.rejects(pending,/closed/);
 assert.ok(instances[0].calls.includes('turn/interrupt'));assert.ok(instances[0].calls.includes('thread/delete'));assert.equal(instances[0].closed,true);
});
