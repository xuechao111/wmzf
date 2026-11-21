import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
test('replica old scheduled slot is refused before storage or writes',async()=>{
 const start=source.indexOf('async function runScheduledUpdate('),end=source.indexOf('async function checkMissedSchedules(',start);
 const ctx={normalizeLocalBase:x=>x};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 assert.equal((await ctx.runScheduledUpdate('codemao-test-update-half-hour-slot','http://127.0.0.1:8766')).ok,false);
});
test('replica manual click starts directly instead of discarded auto alarm',async()=>{
 const start=source.indexOf('chrome.runtime.onMessage.addListener(');
 let listener,calls=[];
 const ctx={chrome:{runtime:{onMessage:{addListener:fn=>listener=fn}},alarms:{create:()=>{throw Error('manual must not use auto alarm')}}},
   runScheduledUpdate:async(...args)=>calls.push(args),Date};
 vm.createContext(ctx);vm.runInContext(source.slice(start),ctx);
 let reply;listener({source:'codemao-replica-dashboard',type:'run-scheduled-now',localBase:'http://127.0.0.1:8766'},null,r=>reply=r);
 assert.equal(reply.ok,true);assert.equal(calls.length,1);assert.match(calls[0][0],/^manual-/);assert.equal(calls[0][1],'http://127.0.0.1:8766');
});
