import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {configuredServiceGroup,scopeServiceData,buildServiceViews} from '../sync-service-data.mjs';

test('group follows saved panel title and never defaults to the main group',()=>{
 for(const title of ['致远组','深圳战区 · 致远组','深圳战区｜木分组'])
  assert.equal(configuredServiceGroup({displayTitle:title}),title.includes('木分')?'木分组':'致远组');
 for(const title of ['', '组内教学控制台','深圳战区'])assert.throws(()=>configuredServiceGroup({displayTitle:title}),/配置面板/);
});
test('the screenshot title decoration is removed and explicit CRM group takes precedence',()=>{
 for(const title of ['教学数据工作台凌风踏浪组','教学数据工作台：凌风踏浪组','深圳战区 · 教学数据工作台凌风踏浪组'])
  assert.equal(configuredServiceGroup({displayTitle:title}),'凌风踏浪组');
 assert.equal(configuredServiceGroup({displayTitle:'任意封面标题',serviceGroupName:'凌风踏浪组'}),'凌风踏浪组');
 assert.equal(configuredServiceGroup({displayTitle:'屹柯组',serviceGroupName:'致远组'}),'致远组');
 assert.throws(()=>configuredServiceGroup({serviceGroupName:'A组|B组'}),/完整组名/);
 assert.throws(()=>configuredServiceGroup({displayTitle:'教学数据工作台'}),/完整组名/);
});
test('old other-group cache is hidden in daily, multi-day and group totals',()=>{
 const wrong={小组:'屹柯组',老师:'Other',im:90};
 const result=scopeServiceData({updatedAt:'old',dates:['2026-11-14'],teachers:[wrong],groups:[wrong],today:{date:'2026-11-14',teachers:[wrong],groups:[wrong]}},'致远组');
 assert.equal(result.updatedAt,'');assert.equal(result.teachers.length,0);assert.equal(result.today.teachers.length,0);assert.equal(result.groups.length,0);
});
test('scope changes filter metrics by exact group before merging teachers',()=>{
 const headers=['worker_no','beisen_user_fullname','level_7_department_name','pre_teacher_3m_reply_cnt'];
 const source={im:{teacher:{headers,rows:[
  {worker_no:'1',beisen_user_fullname:'A',level_7_department_name:'致远组',pre_teacher_3m_reply_cnt:'80%'},
  {worker_no:'2',beisen_user_fullname:'B',level_7_department_name:'屹柯组',pre_teacher_3m_reply_cnt:'95%'},
 ]}}};
 assert.deepEqual(buildServiceViews(source,'致远组').teachers.map(row=>row.老师),['A']);
 assert.deepEqual(buildServiceViews(source,'屹柯组').teachers.map(row=>row.老师),['B']);
});
test('browser, connector and writer use identical configuration parsing',()=>{
 for(const file of ['index.html','chrome-extension/background.js']){
  const code=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const start=code.indexOf('function configuredServiceGroup('),end=code.indexOf('\n}',start)+2;
  const ctx={};vm.createContext(ctx);vm.runInContext(code.slice(start,end),ctx);
  assert.equal(ctx.configuredServiceGroup({displayTitle:'深圳战区 · 致远组'}),'致远组');
 }
});
