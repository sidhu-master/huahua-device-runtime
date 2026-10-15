import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {quotaSnapshot,appendSampleAudit} from '../dist/phone-sample-audit.js';
import {samplePhoneRequest} from '../dist/codex-phone-sampler.js';

test('quota journal excludes credentials, prompt and raw account identity; serialized records remain complete',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'huahua-audit-test-'));
 try{
  const value=quotaSnapshot({accountId:'private-account',ordinaryUsageAllowed:true,credentials:'secret',rateLimits:{limitId:'codex',planType:'plus',primary:{usedPercent:25,resetsAt:123,windowDurationMins:300},rawBody:'secret'}});
  await Promise.all(Array.from({length:5},(_,i)=>appendSampleAudit({i,value},dir)));
  const file=join(dir,'phone-sample-audit.jsonl');const text=await readFile(file,'utf8');
  assert.equal(text.includes('private-account'),false);assert.equal(text.includes('secret'),false);
  assert.deepEqual(text.trim().split('\n').map(x=>JSON.parse(x).i),[0,1,2,3,4]);
  assert.equal((await stat(file)).mode&0o777,0o600);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('one native generation; delayed post-interrupt token usage is retained without fake tool output',async()=>{
 let starts=0,quotaRequests=0;const state={agent_id:'a',model_selection:{model:'gpt-6-astra',reasoning_effort:'low'}};
 const c={onNotification(){},onFailure(){},onToolCall(){},async initialize(){},async request(method){
  if(method==='account/rateLimits/read'){quotaRequests++;throw Error('Quota RPC must not be used on sample hot path');}
  if(method==='config/read')return {config:{service_tier:'default'}};
  if(method==='thread/start')return {thread:{id:'t'},model:'gpt-6-astra',reasoningEffort:'low'};
  if(method==='turn/start'){
   starts++;c.onNotification('turn/started',{threadId:'t',turn:{id:'turn'}});
   queueMicrotask(()=>void c.onToolCall({threadId:'t',turnId:'turn',callId:'call',tool:'observe_ui',arguments:{}}));
   return {};
  }
  if(method==='turn/interrupt'){
   setTimeout(()=>c.onNotification('thread/tokenUsage/updated',{threadId:'t',tokenUsage:{total:{inputTokens:123,cachedInputTokens:20,outputTokens:4,totalTokens:127}}}),30);
   return {};
  }
  throw Error('unexpected RPC');
 }};
 const result=await samplePhoneRequest(c,{requestId:'r',messages:[],tools:[{function:{name:'observe_ui',parameters:{type:'object'}}}]},'/tmp',state);
 assert.equal(result.tool_calls.length,1);assert.equal(starts,1);assert.equal(quotaRequests,0);assert.equal(state.token_usage.inputTokens,123);
 assert.equal(state.sample_audit.turns_started,1);assert.equal(state.sample_audit.usage_updates,1);assert.equal(state.sample_audit.service_tier,'default');
 assert.equal(state.sample_audit.quota_source,'stream_event');
 assert.ok(state.sample_audit.phase_ms.model_to_decision>=0);
 assert.ok(state.sample_audit.phase_ms.usage_wait>=0);
});

test('upstream completion arrives before interrupt; raw usage is exact and not counted twice with TokenCount',async()=>{
 let rawArrived=false,interrupted=false;const state={agent_id:'raw'};
 const usage={inputTokens:200,cachedInputTokens:100,outputTokens:4,totalTokens:204};
 const c={onNotification(){},onFailure(){},onToolCall(){},async initialize(){},async request(method,p){
  if(method==='account/rateLimits/read'||method==='config/read')return {};
  if(method==='thread/start'){assert.equal(p.experimentalRawEvents,true);return {thread:{id:'t'}};}
  if(method==='turn/start'){
   c.onNotification('turn/started',{threadId:'t',turn:{id:'turn'}});
   queueMicrotask(()=>{void c.onToolCall({threadId:'t',turnId:'turn',callId:'call',tool:'observe_ui',arguments:{}});});
   setTimeout(()=>{rawArrived=true;c.onNotification('rawResponse/completed',{threadId:'t',turnId:'turn',responseId:'response',usage});},30);
   return {turn:{id:'turn'}};
  }
  if(method==='turn/interrupt'){
   assert.equal(rawArrived,true);interrupted=true;
   c.onNotification('thread/tokenUsage/updated',{threadId:'t',tokenUsage:{total:usage,last:usage}});return {};
  }
  throw Error('unexpected RPC');
 }};
 await samplePhoneRequest(c,{messages:[],tools:[{function:{name:'observe_ui',parameters:{type:'object'}}}]},'/tmp',state);
 assert.equal(interrupted,true);assert.equal(state.token_usage.inputTokens,200);assert.equal(state.sample_audit.usage_source,'raw_response');
});
