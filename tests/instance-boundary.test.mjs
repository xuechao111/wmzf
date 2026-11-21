import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ownPort=8766, peerPort=ownPort===8765?8766:8765;
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('standalone writers reject peer runtime and port before reading private configuration',()=>{
 for(const file of ['sync-renewal-table.mjs','sync-service-data.mjs','sync-nct-table.mjs']){
  for(const env of [{HF_DASHBOARD_ROOT:path.join(path.dirname(root),ownPort===8765?'hyperframes-dashboard-replica':'hyperframes-dashboard'),HF_DASHBOARD_PORT:String(ownPort)},
                    {HF_DASHBOARD_ROOT:root,HF_DASHBOARD_PORT:String(peerPort)}]){
   const r=spawnSync(process.execPath,[path.join(root,file)],{env:{...process.env,...env},encoding:'utf8',timeout:5000});
   assert.notEqual(r.status,0,file);assert.match(r.stderr,/INSTANCE_(ROOT|PORT)_MISMATCH/,file);
  }
 }
});
test('localhost and loopback share one canonical task identity',()=>{
 const source=read('chrome-extension/background.js');
 const code=source.slice(source.indexOf('function normalizeLocalBase('),source.indexOf('function instanceStorageKey('));
 const scope={LOCAL_BASE:`http://127.0.0.1:${ownPort}`};vm.createContext(scope);vm.runInContext(code,scope);
 assert.equal(scope.normalizeLocalBase(`http://localhost:${ownPort}`),`http://127.0.0.1:${ownPort}`);
 assert.throws(()=>scope.normalizeLocalBase(`http://127.0.0.1:${peerPort}`));
});
test('content bridge never installs a listener in the other workbench',()=>{
 let installed=false;
 vm.runInNewContext(read('chrome-extension/bridge.js'),{location:{origin:`http://127.0.0.1:${peerPort}`},window:{addEventListener(){installed=true}}});
 assert.equal(installed,false);
});
