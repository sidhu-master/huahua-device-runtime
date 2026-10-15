import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePhoneModel } from '../dist/phone-model-selection.js';
import { samplePhoneRequest } from '../dist/codex-phone-sampler.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('default current requires known model and effort, never reads CLI defaults', async () => {
 const server={server:{getClientCapabilities:()=>({})}};
 assert.equal((await resolvePhoneModel(server,{})).state,'MODEL_SELECTION_REQUIRED');
 assert.equal((await resolvePhoneModel(server,{current_model:'gpt-6-astra'})).state,'MODEL_SELECTION_REQUIRED');
 assert.deepEqual(await resolvePhoneModel(server,{current_model:'gpt-6-astra',current_reasoning_effort:'low'}),{selection:{model:'gpt-6-astra',reasoning_effort:'low',source:'current'}});
});

test('standard MCP elicitation offers current choice; accepted or cancelled response is respected', async () => {
 const server=new McpServer({name:'test',version:'1'});
 server.tool('choose',{},async()=>({content:[{type:'text',text:JSON.stringify(await resolvePhoneModel(server,{current_model:'gpt-6-astra',current_reasoning_effort:'low',choose_model:true}))}]}));
 const client=new Client({name:'codex',version:'1'},{capabilities:{elicitation:{form:{}}}});
 let action='accept';
 client.setRequestHandler(ElicitRequestSchema,async({params})=>{
  assert.equal(params.requestedSchema.properties.source.default,'current');
  assert.equal(params.requestedSchema.properties.model.default,'gpt-6-astra');
  return action==='accept'?{action,content:{source:'current',model:'gpt-6-astra',reasoning_effort:'low'}}:{action};
 });
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try {
  assert.equal(JSON.parse((await client.callTool({name:'choose',arguments:{}})).content[0].text).selection.model,'gpt-6-astra');
  action='cancel';assert.equal(JSON.parse((await client.callTool({name:'choose',arguments:{}})).content[0].text).state,'MODEL_SELECTION_CANCELLED');
 }finally{await client.close();await server.close();}
});

test('selected model and effort reach native Codex and fallback mismatch stops before sampling', async()=>{
 const selection={model:'gpt-6-astra',reasoning_effort:'low',source:'current'};
 const calls=[];
 const codex={onFailure:()=>{},onNotification:()=>{},async initialize(){},async request(method,params){
  if(method==='account/rateLimits/read'||method==='config/read')return {};
  calls.push({method,params});
  if(method==='thread/start')return {thread:{id:'t'},model:'gpt-6-astra',reasoningEffort:'low'};
  queueMicrotask(()=>{codex.onNotification('item/completed',{item:{type:'agentMessage',text:'完成'}});codex.onNotification('turn/completed',{turn:{status:'completed'}});});return {};
 }};
 const state={agent_id:'a',model_selection:selection};
 await samplePhoneRequest(codex,{messages:[],tools:[]},'/tmp',state);
 assert.equal(calls[0].params.model,'gpt-6-astra');
 assert.equal(calls[0].params.config.model_reasoning_effort,'low');
 assert.equal(calls[1].params.effort,'low');assert.equal(state.reasoning_effort,'low');
 codex.request=async(method)=>{if(method==='account/rateLimits/read'||method==='config/read')return {};assert.equal(method,'thread/start');return {thread:{id:'t'},model:'gpt-6.1-sol',reasoningEffort:'low'};};
 await assert.rejects(samplePhoneRequest(codex,{messages:[],tools:[]},'/tmp',{agent_id:'a',model_selection:selection}),/模型.*不一致/);
});

test('missing selection returns a structured request without starting a phone task', async()=>{
 const {registerPhoneDelegationTools}=await import('../dist/phone-delegation.js');
 const server=new McpServer({name:'test',version:'1'});let starts=0;
 const device={async agentRequest(){starts++;throw Error('must not touch phone');}};
 const delegation=registerPhoneDelegationTools(server,device);
 const client=new Client({name:'codex',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try {
  const r=await client.callTool({name:'device_agent_delegate',arguments:{goal:'搜索律师',request_id:'r'}});
  assert.equal(JSON.parse(r.content[0].text).state,'MODEL_SELECTION_REQUIRED');assert.equal(starts,0);
 }finally{await delegation.close();await client.close();await server.close();}
});

test('recommended Astra low preset ignores unrelated model fields and needs no manual entry', async()=>{
 const stub={server:{getClientCapabilities:()=>({})}};
 const expected={selection:{model:'gpt-6-astra',reasoning_effort:'low',source:'custom'}};
 assert.deepEqual(await resolvePhoneModel(stub,{model_source:'astra_low'}),expected);
 assert.deepEqual(await resolvePhoneModel(stub,{model_source:'astra_low',model:'other',reasoning_effort:'high'}),expected);
 const server=new McpServer({name:'test',version:'1'});
 server.tool('choose',{},async()=>({content:[{type:'text',text:JSON.stringify(await resolvePhoneModel(server,{choose_model:true}))}]}));
 const client=new Client({name:'codex',version:'1'},{capabilities:{elicitation:{form:{}}}});
 client.setRequestHandler(ElicitRequestSchema,async({params})=>{
  assert.equal(params.requestedSchema.properties.source.default,'current');
  assert.deepEqual(params.requestedSchema.properties.source.oneOf.find(o=>o.const==='astra_low'),{const:'astra_low',title:'Astra + 轻度（推荐）'});
  assert.deepEqual(params.requestedSchema.required,['source']);
  return {action:'accept',content:{source:'astra_low'}};
 });
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try {assert.deepEqual(JSON.parse((await client.callTool({name:'choose',arguments:{}})).content[0].text),expected);}
 finally{await client.close();await server.close();}
});

test('first command asks despite known current settings; subsequent commands reuse confirmed choice',async()=>{
 const {PhoneModelSelector}=await import('../dist/phone-model-selection.js');
 let asked=0,action='cancel';
 const server={server:{getClientCapabilities:()=>({elicitation:{form:{}}}),async elicitInput(){asked++;return action==='accept'?{action,content:{source:'astra_low'}}:{action};}}};
 const selector=new PhoneModelSelector();
 const current={current_model:'gpt-6.1-sol',current_reasoning_effort:'medium'};
 assert.equal((await selector.resolve(server,current)).state,'MODEL_SELECTION_CANCELLED');
 action='accept';assert.equal((await selector.resolve(server,current)).selection.model,'gpt-6-astra');
 assert.equal((await selector.resolve(server,current)).selection.reasoning_effort,'low');assert.equal(asked,2);
 await selector.resolve(server,{...current,choose_model:true});assert.equal(asked,3);
});
