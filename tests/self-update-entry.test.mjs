import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.match(/<script id="replica-self-update-controls">([\s\S]*?)<\/script>/)[1];
function harness({port='8766',fail=false,state='running'}={}){
 const button={disabled:false,textContent:''},message={dataset:{},textContent:''},calls=[],timers=[];
 const scope={document:{querySelector:selector=>selector==='#selfUpdateBtn'?button:message},
  location:{port,reload:()=>calls.push('reload')},setTimeout:(fn,ms)=>timers.push({fn,ms}),
  json:async(url,options)=>{calls.push({url,options});if(fail)throw Error('local service unavailable');return {state,message:'fixture'};}};
 vm.runInNewContext(code,scope);return {button,message,calls,timers};
}
test('one update button is in the cover heading before metrics and sidebar',()=>{
 assert.equal((html.match(/id="selfUpdateBtn"/g)||[]).length,1);
 const index=html.indexOf('id="selfUpdateBtn"');
 assert.ok(index>html.indexOf('<div class="home-heading">'));
 assert.ok(index<html.indexOf('<div class="quick-stats">'));
 assert.ok(html.includes('>一键更新工作台</button>'));
});
test('manual update uses only the current replica endpoints and suppresses repeated clicks',async()=>{
 const h=harness();await h.button.onclick();await h.button.onclick();
 assert.equal(h.calls.filter(c=>c.url==='/self-update').length,1);
 assert.equal(h.calls[0].options.method,'POST');assert.equal(h.calls[1].url,'/self-update-status');
 assert.equal(h.button.disabled,true);assert.equal(h.message.dataset.state,'running');
});
test('the replica button cannot launch a main update',async()=>{
 const h=harness({port:'8765'});await h.button.onclick();assert.equal(h.calls.length,0);assert.equal(h.message.dataset.state,'error');
});
test('network and backend failures restore retry without reporting success',async()=>{
 for(const options of [{fail:true},{state:'error'}]){
  const h=harness(options);await h.button.onclick();
  assert.equal(h.button.disabled,false);assert.equal(h.message.dataset.state,'error');
  assert.equal(h.button.textContent,'重试更新工作台');
 }
});
test('successful software update reloads the current page without touching CRM',async()=>{
 const h=harness({state:'success'});await h.button.onclick();
 assert.ok(h.timers.some(t=>t.ms===5000));assert.equal(h.message.dataset.state,'success');
 assert.deepEqual(h.calls.map(c=>c.url),['/self-update','/self-update-status']);
});
