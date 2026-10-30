import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const start=source.indexOf('async function waitForLocalPreparation(');
const code=source.slice(start,source.indexOf('\nasync function postLocalStatus',start));

async function prepare(responses){
  const calls=[];
  const context={LOCAL_BASE:'http://127.0.0.1:8765',normalizeLocalBase:value=>value,
    fetchWithTimeout:async(url)=>{calls.push(url);return responses.shift();},
    setTimeout:callback=>callback()};
  vm.runInNewContext(code,context);
  return {payload:await context.waitForLocalPreparation(),calls};
}

test('preparation waits for live IDs instead of accepting a pending response',async()=>{
  const result=await prepare([
    {ok:false,status:503,json:async()=>({preparing:true})},
    {ok:true,status:200,json:async()=>({classes:[[3,30]],classSource:'workbook'})},
  ]);
  assert.deepEqual(result.payload.classes,[[3,30]]);
  assert.equal(result.calls.length,2);
});

test('workbook read failure stops update immediately without retrying stale output',async()=>{
  await assert.rejects(prepare([{ok:false,status:422,json:async()=>({message:'Latest class list unavailable'})}]),/CLASS_SOURCE_FAILED/);
});
