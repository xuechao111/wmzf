import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function resolveLiveBoardMatch('),source.indexOf('\nasync function fetchInCrm('));
const start=Date.now()/1000-3600;
const lessons=[{course_number:1,course_id:11,course_name:'1-lesson',unlock_time:start},{course_number:2,course_id:12,course_name:'2-practice',unlock_time:start}];
async function collect(mode){
 const fetch=async(url,options={})=>{
  const b=JSON.parse(options.body||'{}');let data;
  if(url.includes('getTermInfo'))data={data:{termId:77,teacherName:'Assigned-C1'}};
  else if(url.includes('/courses/all'))data=lessons;
  else if(url.includes('/course-detail'))data={items:[{user_id:1,course_id:11,is_open:true},{user_id:1,course_id:12,is_open:true,is_finish:true}],total:2};
  else if(url.includes('/living/boards'))data={data:{items:mode==='empty'?[]:[{roomUuid:'room',classIdList:[1],courseNumber:1,teacherName:mode==='substitute'?'Other-C2':'Assigned-C1',livingStartTime:start}],total:mode==='empty'?0:1}};
  else if(url.includes('/living/students')){
   if(mode==='auth')return {ok:false,status:401,arrayBuffer:async()=>new TextEncoder().encode('{}').buffer};
   if(mode==='bad-room')return {ok:false,status:400,arrayBuffer:async()=>new TextEncoder().encode('{}').buffer};
   data={data:{items:b.isParticipated?[{userId:1}]:[],total:b.isParticipated?1:0}};
  }else throw new Error(url);
  return {ok:true,status:200,arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(data)).buffer};
 };
 const runtime={fetch,TextDecoder,AbortController,setTimeout,clearTimeout,Date,URL};vm.runInNewContext(code,runtime);
 return JSON.parse(await runtime.collectCrmData([[1,77]],[]));
}
for(const mode of ['empty','substitute','bad-room'])test(mode+' keeps lesson data while live attendance is unavailable',async()=>{
 const rows=await collect(mode);assert.equal(rows.length,1);assert.equal(rows[0].items.length,2);assert.equal(rows[0].items[1].is_finish,true);assert.equal(Object.keys(rows[0].liveAttendance||{}).length,0);
});
test('login failure is not disguised as a pending broadcast',async()=>{await assert.rejects(()=>collect('auth'),/CRM_LOGIN_EXPIRED/);});
test('valid attendance keeps verified room counts',async()=>{const rows=await collect('valid');assert.equal(rows[0].liveAttendance[1].attendedIds.length,1);});
