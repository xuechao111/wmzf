import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const fn=(name,next)=>source.slice(source.indexOf(`async function ${name}(`),source.indexOf(`async function ${next}(`));
function harness({phase='local',owner=false,serviceFail=false}={}){
 const state={updateRuntime:{runningSince:Date.now(),slotKey:'slot'},autoSchedule:{}};
 const calls=[];let ctx;
 const active=new Set(owner?['main']:[]);
 ctx={LOCAL_BASE:'main',CRM_RUNTIME_TIMEOUT_MS:360000,LOCAL_RUNTIME_TIMEOUT_MS:660000,activeUpdateRuns:active,
 normalizeLocalBase:x=>x,instanceStorageKey:n=>n,
 chrome:{storage:{local:{get:async()=>({...state}),set:async value=>Object.assign(state,value),remove:async key=>{delete state[key]}}}},
 fetchWithTimeout:async()=>({ok:true,json:async()=>({state:'success',phase,time:new Date().toISOString()})}),
 postLocalStatus:async(...a)=>calls.push(['status',...a]),appendRunLog:async()=>{},startMcpRelay:()=>()=>{},
 waitForLocalPreparation:async()=>({alreadyRunning:true}),waitForLocalCompletion:async()=>({message:'local done'}),
 runScheduledServiceUpdate:async()=>{calls.push(['service']);await ctx.reconcileUpdateRuntime('main');if(serviceFail)throw Error('service failed')},
 setTimeout:callback=>{callback();return 0},Date,Set};
 vm.createContext(ctx);
 vm.runInContext(fn('reconcileUpdateRuntime','waitForTabReady')+fn('runScheduledUpdate','checkMissedSchedules'),ctx);
 return {ctx,state,calls,active};
}
test('watchdog keeps live owner lock during intermediate local success',async()=>{
 const h=harness({owner:true});await h.ctx.reconcileUpdateRuntime('main');assert.ok(h.state.updateRuntime);assert.equal(h.state.autoSchedule.lastSuccessKey,undefined);
});
test('restart recovery does not stamp local-only completion as whole success',async()=>{
 const h=harness();await h.ctx.reconcileUpdateRuntime('main');assert.equal(h.state.autoSchedule.lastSuccessKey,undefined);assert.match(h.state.autoSchedule.lastResult,/教学服务未确认/);
});
test('joined local update must complete service before successful schedule',async()=>{
 const h=harness();delete h.state.updateRuntime;const r=await h.ctx.runScheduledUpdate('slot','main');assert.equal(r.ok,true);assert.equal(h.calls.filter(x=>x[0]==='service').length,1);assert.equal(h.state.autoSchedule.lastSuccessKey,'slot');assert.equal(h.active.size,0);
});
test('joined update failing service retries and remains failed',async()=>{
 const h=harness({serviceFail:true});delete h.state.updateRuntime;const r=await h.ctx.runScheduledUpdate('slot','main');assert.equal(r.ok,false);assert.equal(h.calls.filter(x=>x[0]==='service').length,2);assert.equal(h.state.autoSchedule.lastSuccessKey,undefined);assert.equal(h.active.size,0);
});
test('service completion ignores another run even with a fresh success timestamp',async()=>{
 const now=Date.now();const statuses=[{state:'success',runId:'other',time:new Date(now).toISOString()},{state:'success',runId:'expected',time:new Date(now).toISOString()}];let reads=0;
 const ctx={LOCAL_BASE:'main',normalizeLocalBase:x=>x,Date,setTimeout:callback=>{callback();return 0},fetchWithTimeout:async()=>({ok:true,json:async()=>statuses[reads++]})};
 vm.createContext(ctx);vm.runInContext(fn('waitForServiceCompletion','runScheduledServiceUpdate'),ctx);
 const result=await ctx.waitForServiceCompletion(now,1000,'main','expected');assert.equal(result.runId,'expected');assert.equal(reads,2);
});
