import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const src=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=src.slice(src.indexOf('async function fetchRenewalInCurrentChrome('),src.indexOf('async function fetchNctInCurrentChrome('));
for(const month of ['2026-12-01','2027-01-01','2027-02-01'])test(`renewal ${month} discards saved group/teacher/SQL filters and returns all groups`,async()=>{
 let sent;
 const saved={queries:[{filters:[{col:'level_7_department_name',op:'IN',val:['屹柯组']},{col:'worker_no',op:'IN',val:['one-teacher']},{col:'renew_month',op:'IN',val:['2020-01-01']}],
   extras:{where:"level_7_department_name = '屹柯组'",having:'count(*) > 100',time_range:'Last week'},time_range:'Last week'}],
   form_data:{datasource:'1__table',viz_type:'table',adhoc_filters:[{sqlExpression:"小组='屹柯组'"}],extra_form_data:{filters:[{col:'group',val:['屹柯组']}],where:'old scope'},where:'old scope'}};
 const context={RENEWAL_COLUMN_NAMES:{},waitForTabReady:async()=>{},location:{href:'https://bigdata-superset.codemao.cn/dashboard/598'},
   fetch:async(url,options)=>{
     if(url==='/api/v1/chart/5014')return {ok:true,json:async()=>({result:{query_context:JSON.stringify(saved)}})};
     if(url.includes('csrf_token'))return {ok:true,json:async()=>({result:'fixture'})};
     sent=JSON.parse(options.body);return {ok:true,json:async()=>({result:[{data:[{'组':'屹柯组'},{'组':'其他组'}],rowcount:2}]})};
   },chrome:{tabs:{query:async()=>[{id:1,active:true}]},scripting:{executeScript:async({func,args})=>{
     const inner=vm.runInContext(`(${func.toString()})`,ctx);return [{result:await inner(...args)}];
   }}}};
 const ctx=vm.createContext(context);vm.runInContext(code,ctx);
 const result=await ctx.fetchRenewalInCurrentChrome(month);assert.equal(result.ok,true);
 const data=JSON.parse(result.data);assert.equal(data.rows.length,2);assert.equal(data.renewalScope.groupScope,'all');assert.equal(data.renewalScope.month,month);
 assert.deepEqual(sent.queries[0].filters,[{col:'renew_month',op:'IN',val:[month]},{col:'renew_state',op:'IN',val:['首续']},{col:'level_6_department_name',op:'IN',val:['深圳战区']}]);
 assert.equal(sent.queries[0].extras.where,'');assert.equal(sent.queries[0].extras.having,'');assert.equal(sent.queries[0].time_range,'No filter');
 assert.equal(JSON.stringify(sent).includes('屹柯组'),false);assert.equal(JSON.stringify(sent).includes('one-teacher'),false);
 assert.equal(saved.queries[0].filters.length,3,'source chart is never modified');
});
