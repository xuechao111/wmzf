import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const update=source.slice(source.indexOf('async function updateAll()'),source.indexOf('\n',source.indexOf('async function updateAll()')));
const refresh=source.slice(source.indexOf('async function refreshStatus()'),source.indexOf('refreshStatus();setInterval(refreshStatus',source.indexOf('async function refreshStatus()')));
function harness(versionCheck){
 let reads=0,starts=0;
 const ctx={state:{teachingReady:true,updateState:'success'},teachingRequestPending:false,teachingStartFailed:null,
   $:()=>({disabled:false}),renderUpdateStatus(){},Date,
   ensureExtensionVersion:versionCheck,extensionRequest:async()=>{starts++;return {ok:true}},
   json:async()=>{reads++;return {state:'success',message:'old success'}},setTimeout(){}};
 vm.createContext(ctx);vm.runInContext(update+refresh,ctx);return {ctx,reads:()=>reads,starts:()=>starts};
}
test('version check failure stays visible and never starts collection',async()=>{
 const h=harness(async()=>{throw Error('connector is outdated')});
 assert.equal(await h.ctx.updateAll(),false);await h.ctx.refreshStatus();
 assert.equal(h.ctx.state.updateState,'request-error');assert.match(h.ctx.state.updateStatus.detail,/outdated/);
 assert.equal(h.reads(),0);assert.equal(h.starts(),0);
});
test('old backend success cannot release a version check or allow duplicate clicks',async()=>{
 let release;const h=harness(()=>new Promise(resolve=>release=resolve));
 const active=h.ctx.updateAll();await h.ctx.refreshStatus();assert.equal(await h.ctx.updateAll(),false);
 assert.equal(h.reads(),0);assert.equal(h.starts(),0);
 release();assert.equal(await active,true);assert.equal(h.starts(),1);assert.equal(h.ctx.teachingRequestPending,false);
});
