import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('function isCrmAuthenticationFailure('),source.indexOf('async function fetchInCrm('));
const fetchCode=source.slice(source.indexOf('async function fetchInCrm('),source.indexOf('const RENEWAL_COLUMN_NAMES'));
function harness({tabs=[],failure=null}={}){
 const calls=[];
 const context={LOCAL_BASE:'http://127.0.0.1:8765',normalizeLocalBase:x=>x,
  chrome:{tabs:{query:async()=>{calls.push('tabs-query');return tabs}}},
  waitForTabReady:async()=>{throw new Error('worker collection must not wait for a page')},
  collectCrmData:async()=>{calls.push('collect');if(failure)throw failure;return 'fresh CRM data'},
  fetchComparisonLiveRooms:()=>{},postLocalStatus:async()=>{},appendRunLog:async()=>{},
  setTimeout:()=>0,Date};
 vm.createContext(context);vm.runInContext(helper+fetchCode,context);
 return {context,calls};
}
for(const [name,tabs] of [['no visible CRM tab',[]],['discarded CRM page',[{id:1,discarded:true}]],['CRM page still loading',[{id:2,status:'loading'}]]]){
 test(name+' does not block authenticated worker collection',async()=>{
  const h=harness({tabs});const result=await h.context.fetchInCrm([[1,2]]);
  assert.equal(result.ok,true);assert.equal(result.data,'fresh CRM data');assert.deepEqual(h.calls,['collect']);
 });
}
test('actual API authentication failure has a structured code',async()=>{
 const h=harness({failure:new Error('CRM_LOGIN_EXPIRED')});const result=await h.context.fetchInCrm([[1,2]]);
 assert.equal(result.ok,false);assert.equal(result.code,'CRM_AUTH_REQUIRED');assert.equal(h.context.isCrmAuthenticationFailure(result),true);
});
test('HTTP 403 is a permission failure, not proof that login expired',async()=>{
 const h=harness({failure:new Error('CRM_HTTP_403')});const result=await h.context.fetchInCrm([[1,2]]);
 assert.equal(result.code,'CRM_READ_FAILED');assert.equal(h.context.isCrmAuthenticationFailure(result),false);
});
test('waiting classification only accepts confirmed authentication failures',()=>{
 const {context}=harness();
 for(const message of ['请先在当前浏览器打开并登录CRM后台；控制台不会另开页面。','CRM读取失败：NetworkError','CRM_HTTP_500','续费表格名称含登录CRM'])assert.equal(context.isCrmAuthenticationFailure({message}),false,message);
 for(const message of ['CRM_LOGIN_EXPIRED','CRM_API_401','当前浏览器的CRM登录已失效，请重新登录','当前谷歌浏览器的 Superset 登录已失效，请在原页面登录后重试。'])assert.equal(context.isCrmAuthenticationFailure({message}),true,message);
});
