import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function collectCrmData('),source.indexOf('async function fetchComparisonLiveRooms('));
const epoch=Date.parse('2026-11-06T12:00:00+08:00');
const lessons=[['2026-10-27',1],['2026-10-28',2],['2026-11-03',3],['2026-11-04',4]].map(([day,id])=>({course_id:id,course_number:id,course_name:`${id}-course`,unlock_time:Date.parse(`${day}T12:00:00+08:00`)/1000}));
function harness(detail){
  let elapsed=0;
  const requests=[],timers=[];
  class Clock extends Date {static now(){return epoch+elapsed;}}
  const response=(data,status=200)=>({status,ok:status>=200&&status<300,arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(data)).buffer});
  const context={Date:Clock,AbortController,TextDecoder,URL,
    setTimeout:(callback,delay)=>{timers.push(delay);if(delay<3000){elapsed+=delay;callback();}return timers.length;},clearTimeout:()=>{},
    fetch:async(url,options)=>{
      requests.push(url);
      if(url.includes('getTermInfo'))return response({data:{teacherName:'Teacher',termId:2,classId:1}});
      if(url.includes('/courses/all'))return response({data:lessons});
      if(url.includes('/course-detail'))return detail({url,body:JSON.parse(options.body),response,advance:ms=>{elapsed+=ms;}});
      if(url.includes('/living/boards'))return response({data:{items:[],total:0}});
      throw Error(`Unexpected request ${url}`);
    }};
  vm.createContext(context);vm.runInContext(code,context);
  return {run:()=>context.collectCrmData([[1,2]],[]),requests,timers};
}

test('transient course-detail failures have one three-attempt budget',async()=>{
  let count=0;
  const h=harness(({response})=>{count++;return response({message:'temporary'},503);});
  await assert.rejects(h.run(),/CRM_REQUEST_FAILED.*CRM_HTTP_503/);
  assert.equal(count,3);
});

test('permanent detail failures and expired sessions are never retried',async()=>{
  for(const status of [400,401,403]){
    let count=0;
    const h=harness(({response})=>{count++;return response({},status);});
    await assert.rejects(h.run(),status===401?/CRM_LOGIN_EXPIRED/:new RegExp(`CRM_HTTP_${status}`));
    assert.equal(count,1);
  }
});

test('all pages of both weekly pairs survive a transient retry unchanged',async()=>{
  let failed=false;
  const calls=[];
  const h=harness(({url,body,response})=>{
    const page=Number(new URL(url).searchParams.get('page'));
    calls.push([body.course_ids.join(','),page]);
    if(!failed&&page===2){failed=true;return response({},503);}
    const rows=Array.from({length:page===1?100:3},(_,i)=>({user_id:(page-1)*100+i+1,course_id:body.course_ids[0],is_finish:i%2===0,is_open:true}));
    return response({items:rows,total:103});
  });
  const blocks=JSON.parse(await h.run());
  assert.equal(blocks[0].items.length,206);
  assert.deepEqual(calls,[['1,2',1],['1,2',2],['1,2',2],['3,4',1],['3,4',2]]);
  assert.equal(blocks[0].items.filter(row=>row.course_id===1).length,103);
  assert.equal(blocks[0].items.filter(row=>row.course_id===3).length,103);
});

test('premature empty detail pages fail rather than publish partial data',async()=>{
  const h=harness(({url,response})=>response({items:new URL(url).searchParams.get('page')==='1'?[{user_id:1,course_id:1}]:[],total:103}));
  await assert.rejects(h.run(),/CRM_DETAIL_INCOMPLETE:1:2:1\/103/);
});

test('deadline exhaustion does not start another retry or accept a late response',async()=>{
  for(const lateSuccess of [false,true]){
    let count=0;
    const h=harness(({response,advance})=>{count++;advance(240000);return response(lateSuccess?{items:[],total:0}:{},lateSuccess?200:503);});
    await assert.rejects(h.run(),/CRM_TOTAL_TIMEOUT/);
    assert.equal(count,1);
  }
});

test('request timers use the remaining collection budget',async()=>{
  let count=0;
  const h=harness(({response,advance})=>{
    if(++count===1){advance(230000);return response({},503);}
    return response({},400);
  });
  await assert.rejects(h.run(),/CRM_HTTP_400/);
  assert.ok(h.timers.includes(9100),`missing remaining-budget timer: ${h.timers}`);
});
