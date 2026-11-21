import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=source.indexOf('function verifySavedConfiguration('),end=source.indexOf('  async function openConfig()',start);
const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
test('save success requires the active instance to return the submitted configuration',()=>{
 const payload={displayTitle:'致远组',workbookUrl:'https://example.test/book',dingtalkConnectionUrl:'https://example.test/mcp',renewalWorkbookUrl:'',serviceWorkbookUrl:''};
 ctx.verifySavedConfiguration(payload,{...payload,teachingReady:true});
 assert.throws(()=>ctx.verifySavedConfiguration(payload,{...payload,workbookUrl:'',teachingReady:false}),/未保存到当前副本/);
 assert.throws(()=>ctx.verifySavedConfiguration(payload,{...payload,teachingReady:false,teachingConfigurationIssues:['连接授权']}),/配置不完整/);
});
