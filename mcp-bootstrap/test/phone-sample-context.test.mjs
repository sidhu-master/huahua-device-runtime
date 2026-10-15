import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneSampleContext} from '../dist/phone-sample-context.js';
import {samplePhoneRequest} from '../dist/codex-phone-sampler.js';
test('model prefix excludes changing transport IDs and keeps real images, goals and paired receipts',()=>{
 const messages=[{role:'system',content:'policy'},{role:'user',content:'完整用户目标'},
 {role:'assistant',tool_calls:[{id:'call',function:{name:'observe'}}]},{role:'tool',tool_call_id:'call',content:'evidence'},
 {role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AQI='}}]}];
 const a=phoneSampleContext({requestId:'r1',agentId:'a1',deadlineAtMs:1,purpose:'gui',messages,tools:[]});
 const b=phoneSampleContext({requestId:'r2',agentId:'a2',deadlineAtMs:2,purpose:'gui',messages,tools:[]});
 assert.deepEqual(a,b);assert.equal(a.stats.image_count,1);assert.ok(a.input[0].text.includes('完整用户目标'));
 assert.ok(a.input[0].text.includes('tool_call_id'));assert.ok(!a.input[0].text.includes('AQI='));assert.equal(a.input[1].url,'data:image/png;base64,AQI=');
});
test('capturing one tool decision never responds with an invented execution receipt',async()=>{
 let replied=false;
 const codex={onFailure:()=>{},onNotification:()=>{},onToolCall:()=>{},async initialize(){},async request(method){
  if(method==='account/rateLimits/read'||method==='config/read')return {};
  if(method==='thread/start')return {thread:{id:'t'}};
  queueMicrotask(()=>{void codex.onToolCall({threadId:'t',callId:'call',tool:'observe',arguments:{}}).then(()=>{replied=true;});});return {};
 }};
 const r=await samplePhoneRequest(codex,{purpose:'gui',messages:[],tools:[{function:{name:'observe',parameters:{type:'object'}}}]},'/tmp',{agent_id:'a'});
 assert.equal(r.tool_calls.length,1);await new Promise(r=>setTimeout(r,10));assert.equal(replied,false);
});

test('checkpoint text is not counted as an image and escaped compaction trees are measured',()=>{
 const checkpoint='Context checkpoint summary\n历史截图已经归档，保留任务事实';
 const screen={observation_id:'old',ui_tree:{nodes:[{label:'律师咨询',bounds:[1,2,3,4]}]}};
 const gui=phoneSampleContext({purpose:'gui',messages:[{role:'user',content:checkpoint}],tools:[]});
 assert.ok(gui.stats.category_bytes.history_checkpoint>0);assert.equal(gui.stats.category_bytes.image_markers,0);
 const compact=phoneSampleContext({purpose:'compaction',messages:[{role:'user',content:'user: '+JSON.stringify(screen)+'\ntool: '+JSON.stringify({screen:JSON.stringify(screen)})}],tools:[]});
 assert.ok(compact.stats.category_bytes.ui_tree>0);
 assert.equal(Object.values(compact.stats.category_bytes).reduce((a,b)=>a+b,0),compact.stats.text_bytes);
});
