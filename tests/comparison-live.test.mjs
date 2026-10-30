import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const src=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=src.slice(src.indexOf('async function fetchComparisonLiveRooms('),src.indexOf('async function fetchInCrm('));

test('room lookup fetches a chart definition when dashboard listing omits query context',async()=>{
 const requests=[];
 const chrome={tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async({func,args})=>{
  const sandbox={fetch:async(url,options={})=>{
   requests.push(url);
   let result;
   if(url.endsWith('/472/charts'))result={result:[{id:3645}]};
   else if(url.endsWith('/chart/3645'))result={result:{query_context:JSON.stringify({queries:[{}]})}};
   else if(url.includes('csrf_token'))result={result:'fixture'};
   else if(url.endsWith('/chart/data')){
    const query=JSON.parse(options.body);assert.equal(query.force,true);assert.equal(query.queries[0].row_limit,200000);
    result={result:[{colnames:['课堂UUID','老师工号','课程id','课期id','开播时间'],data:[{'课堂UUID':'room','老师工号':'C1','课程id':99,'课期id':11,'开播时间':'2026-10-17'}]}]};
   }else throw Error(url);
   return {ok:true,json:async()=>result};
  },document:{querySelector(){throw Error('Must not use rendered-page fallback')},getElementById(){throw Error('Must not use rendered-page fallback')}}};
  const run=vm.runInNewContext('('+func.toString()+')',sandbox);
  return [{result:await run(...args)}];
 }}};
 const context={chrome};vm.runInNewContext(code,context);
 const time=Date.parse('2026-10-17T15:00:00+08:00')/1000;
 const rooms=await context.fetchComparisonLiveRooms([{classId:1,termId:11,info:{teacherName:'Teacher-C1'},lessons:[{course_id:99,course_number:25,unlock_time:time}]}],time-86400,time+3600);
 assert.ok(requests.includes('/api/v1/chart/3645'));
 assert.equal(rooms.length,1);assert.equal(rooms[0].courseNumber,25);
});
test('cross-group room lookup matches teacher, actual term and course without mixing Saturday slots',async()=>{
 const context={chrome:{tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:{ok:true,columns:['课堂UUID','老师工号','课程id','课期id','开播时间'],verbose:{},rows:[{'课堂UUID':'room-noon','老师工号':'C1','课程id':99,'课期id':11,'开播时间':'2026-10-17'}]}}]}}};
 vm.runInNewContext(code,context);
 const noon=Date.parse('2026-10-17T15:00:00+08:00')/1000,night=Date.parse('2026-10-17T19:20:00+08:00')/1000;
 const block=(id,term,time)=>({classId:id,termId:term,info:{teacherName:'Teacher-C1'},lessons:[{course_id:99,course_number:1,unlock_time:time}]});
 const rooms=await context.fetchComparisonLiveRooms([block(1,11,noon),block(2,12,night)],noon-86400,night+3600);
 assert.equal(rooms.length,1);assert.equal(rooms[0].classIdList[0],1);assert.equal(rooms[0].roomUuid,'room-noon');
});

test('shared classroom requires class roster filtering even when another teacher is not configured',async()=>{
 const columns=['课堂UUID','老师工号','课程id','课期id','开播时间'];
 const rows=['C1','C2'].map(worker=>({'课堂UUID':'shared-room','老师工号':worker,'课程id':99,'课期id':11,'开播时间':'2026-10-17'}));
 const context={chrome:{tabs:{query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:{ok:true,columns,rows,verbose:{}}}]}}};
 vm.runInNewContext(code,context);
 const noon=Date.parse('2026-10-17T15:00:00+08:00')/1000;
 const blocks=[{classId:1,termId:11,info:{teacherName:'Teacher-C1'},lessons:[{course_id:99,course_number:1,unlock_time:noon}]}];
 const rooms=await context.fetchComparisonLiveRooms(blocks,noon-86400,noon+3600);
 assert.equal(rooms.length,1);assert.equal(rooms[0].sharedClassroom,true);
});
