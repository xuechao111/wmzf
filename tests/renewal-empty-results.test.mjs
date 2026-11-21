import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const src=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=src.slice(src.indexOf('async function fetchRenewalInCurrentChrome('),src.indexOf('async function fetchNctInCurrentChrome('));
async function run(responses){
 const queries=[];let index=0;
 const context={RENEWAL_COLUMN_NAMES:{},waitForTabReady:async()=>{},location:{href:'https://bigdata-superset.codemao.cn/dashboard/598'},
 fetch:async(url,options)=>{
  if(url==='/api/v1/chart/5014')return {ok:true,json:async()=>({result:{query_context:JSON.stringify({queries:[{}],form_data:{}})}})};
  if(url.includes('csrf_token'))return {ok:true,json:async()=>({result:'fixture'})};
  queries.push(JSON.parse(options.body));const response=responses[Math.min(index++,responses.length-1)];
  return response.http?{ok:false,status:response.http}:{ok:true,json:async()=>response};
 },chrome:{tabs:{query:async()=>[{id:1,active:true}]},scripting:{executeScript:async({func,args})=>{
  try{return [{result:await vm.runInContext(`(${func.toString()})`,ctx)(...args)}]}catch{return [{}]}
 }}}};
 const ctx=vm.createContext(context);vm.runInContext(code,ctx);
 return {result:await ctx.fetchRenewalInCurrentChrome('2026-11-01'),queries};
}
test('two empty results name the selected month and keep original data',async()=>{
 const h=await run([{result:[{data:[],rowcount:0}]}]);
 assert.equal(h.result.ok,false);assert.match(h.result.error,/CRM_RENEWAL_EMPTY:2026-11-01/);assert.match(h.result.error,/原表未清空/);assert.equal(h.queries.length,2);
 for(const q of h.queries)assert.equal(q.queries[0].filters[0].val[0],'2026-11-01');
});
test('temporary empty result retries the exact same month and scope',async()=>{
 const h=await run([{result:[{data:[],rowcount:0}]},{result:[{data:[{'组':'其他组'}],rowcount:1}]}]);
 assert.equal(h.result.ok,true);assert.equal(JSON.parse(h.result.data).rows.length,1);assert.deepEqual(h.queries[0],h.queries[1]);
});
test('query error is serialized instead of mislabeled empty',async()=>{
 const h=await run([{result:[{data:[],error:'query failed',status:'failed'}]}]);
 assert.equal(h.result.ok,false);assert.match(h.result.error,/CRM_RENEWAL_QUERY_FAILED/);assert.equal(h.queries.length,1);
});
test('403 remains a permission failure without retry',async()=>{
 const h=await run([{http:403}]);assert.equal(h.result.ok,false);assert.match(h.result.error,/CRM_RENEWAL_ACCESS_DENIED/);assert.equal(h.queries.length,1);
});
test('positive total with empty page is rejected as truncation',async()=>{
 const h=await run([{result:[{data:[],rowcount:30}]}]);assert.equal(h.result.ok,false);assert.match(h.result.error,/CRM_DATA_TRUNCATED:0\/30/);assert.equal(h.queries.length,1);
});
test('multiple tables cannot silently become empty or partial data',async()=>{
 const h=await run([{result:[{data:[]},{data:[{id:1}]}]}]);assert.equal(h.result.ok,false);assert.match(h.result.error,/CRM_RENEWAL_RESULT_AMBIGUOUS/);
});
