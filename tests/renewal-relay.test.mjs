import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const scriptPath=fileURLToPath(new URL('../sync-renewal-table.mjs',import.meta.url));
const source=fs.readFileSync(scriptPath,'utf8').replace(/^import .*;\r?\n/gm,'').split('const task=')[0].replace('fileURLToPath(import.meta.url)',JSON.stringify(scriptPath));
const success={result:{content:[{type:'text',text:JSON.stringify({success:true,values:[['verified']]})}]}};
async function harness(t,{direct='success',relay='success',port,wrongInstance=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'renewal-relay-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'dashboard-config.json'),JSON.stringify({dingtalkConnectionUrl:'https://mcp-gw.dingtalk.com/test-only',dingtalkAccessKey:'synthetic-test-token'}));
  const urls=[],writes=[];
  const filesystem={...fs,renameSync:(from,to)=>{
    fs.renameSync(from,to);writes.push(to);
    if(to.endsWith('.request.json')){
      const request=JSON.parse(fs.readFileSync(to,'utf8'));
      const reply={id:request.id,ok:relay!=='failure',status:relay==='failure'?503:200,bodyText:JSON.stringify(relay==='tool-error'?{result:{content:[{type:'text',text:'{"success":false,"errorMsg":"mock tool failure"}'}]}}:success)};
      fs.writeFileSync(to.replace('.request.json','.response.json'),JSON.stringify(reply));
      fs.writeFileSync(to.replace('.request.json','.claimed'),'claimed');
    }
  }};
  const env={HF_DASHBOARD_ROOT:root};if(port!==undefined)env.HF_DASHBOARD_PORT=port;
  const context={fs:filesystem,path,randomUUID,process:{env},Buffer,Date,Set,JSON,AbortController,TypeError,setTimeout,clearTimeout,console,
    fetch:async url=>{
      urls.push(url);
      if(url.startsWith('http://127.0.0.1:'))return {ok:true,json:async()=>({ok:true,runtimeRoot:wrongInstance?path.join(root,'other'):root})};
      if(direct==='network-error')throw new TypeError('fetch failed');
      return {ok:direct==='success',status:403,json:async()=>success};
    }};
  vm.createContext(context);vm.runInContext(source,context);
  return {run:()=>context.mcpCall('get_range',{sheetId:'test'},100),root,urls,writes};
}

test('successful direct call never creates a relay request',async t=>{
  const h=await harness(t);assert.equal((await h.run()).success,true);assert.equal(h.urls.length,1);assert.equal(h.writes.length,0);
});
test('network failure relays through default replica port and cleans queue files',async t=>{
  const h=await harness(t,{direct:'network-error'});assert.equal((await h.run()).success,true);
  assert.equal(h.urls[1],'http://127.0.0.1:8766/health');assert.equal(h.writes.length,1);
  assert.deepEqual(fs.readdirSync(path.join(h.root,'run-data','mcp-relay')),[]);
});
test('explicit instance port is honored and runtime root must match',async t=>{
  const h=await harness(t,{direct:'network-error',port:'8765',wrongInstance:true});
  await assert.rejects(h.run(),/INSTANCE_MISMATCH/);assert.equal(h.urls[1],'http://127.0.0.1:8765/health');assert.equal(h.writes.length,0);
});
test('relay transport failure never reports success or leaks remote error text',async t=>{
  const h=await harness(t,{direct:'network-error',relay:'failure'});await assert.rejects(h.run(),/DINGTALK_RELAY_FAILED:503/);
  assert.deepEqual(fs.readdirSync(path.join(h.root,'run-data','mcp-relay')),[]);
});
test('relay tool error remains a failed update',async t=>{
  const h=await harness(t,{direct:'network-error',relay:'tool-error'});await assert.rejects(h.run(),/DINGTALK_TOOL_ERROR/);
});
test('permission HTTP error does not replay a request via another channel',async t=>{
  const h=await harness(t,{direct:'http-error'});await assert.rejects(h.run(),/HTTP_403/);assert.equal(h.urls.length,1);assert.equal(h.writes.length,0);
});
test('invalid instance port stops before querying any local instance',async t=>{
  const h=await harness(t,{direct:'network-error',port:'1234'});await assert.rejects(h.run(),/INSTANCE_PORT_INVALID/);assert.equal(h.urls.length,1);assert.equal(h.writes.length,0);
});
