import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

for (const structured of [false,true]) test(`Windows PS5 preserves Chinese renewal errors (structured=${structured})`,{skip:process.platform!=='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'replica-renewal-encoding-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const runtime=path.join(root,'instances','test');fs.mkdirSync(runtime,{recursive:true});
 for(const file of ['run-scholarship-update.ps1','instance-guard.ps1']) fs.copyFileSync(new URL('../'+file,import.meta.url),path.join(root,file));
 const message='CRM_MISSING_TARGET_COLUMNS:测试字段';
 const code=`import fs from 'node:fs';import path from 'node:path';
 ${structured?`fs.writeFileSync(path.join(process.env.HF_DASHBOARD_ROOT,'renewal-error.json'),JSON.stringify({message:${JSON.stringify(message)}}),'utf8');`:''}
 console.error(${JSON.stringify(structured?'intentionally damaged stderr':message)});process.exitCode=1;`;
 fs.writeFileSync(path.join(root,'sync-renewal-table.mjs'),code);
 // A prior report must not override this attempt's result.
 fs.writeFileSync(path.join(runtime,'renewal-error.json'),JSON.stringify({message:'STALE_ERROR'}));
 const input=path.join(runtime,'renewal-table-source.json');fs.writeFileSync(input,JSON.stringify({renewalMonth:'2026-12-01'}));
 const result=spawnSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'run-scholarship-update.ps1'),'-InputFile',input],{
  env:{...process.env,HF_DASHBOARD_ROOT:runtime,HF_DASHBOARD_PORT:'8766'},encoding:'utf8',timeout:30000,
 });
 assert.equal(result.status,1,result.stderr);
 const status=JSON.parse(fs.readFileSync(path.join(runtime,'scholarship-status.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(status.state,'error');assert.ok(status.detail.includes('测试字段'),status.detail);
 assert.ok(!status.detail.includes('STALE_ERROR'));
 assert.ok(fs.existsSync(input),'failed input is retained');
 if(!structured) assert.ok(fs.readFileSync(path.join(runtime,'scholarship-update.log'),'utf8').includes(message));
});
