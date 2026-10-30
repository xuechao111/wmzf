import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function resolveLiveBoardMatch('),source.indexOf('\nasync function collectCrmData('));
const context={};vm.runInNewContext(code,context);
const start=Date.parse('2026-10-16T19:20:00+08:00')/1000;
const block=(id=134089,name='曾易浩-C19848',time=start)=>({classId:id,info:{teacherName:name},lessons:[{course_number:1,course_id:11,course_name:'1-C++基础框架',unlock_time:time},{course_number:2,course_id:12,course_name:'2-课堂练习',unlock_time:time}]});
const room={livingId:344921,courseName:'C++基础框架',teacherName:'曾易浩-C19848',livingStartTime:start-1200,classIdList:[134089]};
test('class and course-title lookup handles an unnumbered first-lesson course name',()=>{
 const b=block(),m=context.resolveLiveBoardMatch(room,[b]);assert.equal(m.lessonNumber,1);assert.equal(m.targets[0],b);
});
test('original numbered course and nested class-ID matching remain authoritative',()=>{
 const b=block(),m=context.resolveLiveBoardMatch({...room,courseName:'1-C++基础框架',classIdList:[],classes:[{classId:134089}]},[b,block(134074,'侯启聪-C23846')]);assert.equal(m.lessonNumber,1);assert.equal(m.targets.length,1);assert.equal(m.targets[0],b);
});
test('teacher/course/time lookup rejects ambiguous or unrelated sessions',()=>{
 const r={...room,classIdList:[],livingStartTime:'2026-10-16 19:00:00'},b=block();
 assert.equal(context.resolveLiveBoardMatch(r,[b]).targets[0],b);
 assert.equal(context.resolveLiveBoardMatch(r,[block(134074,'侯启聪-C23846')]),null);
 assert.equal(context.resolveLiveBoardMatch(r,[b,block(999)]),null);
 assert.equal(context.resolveLiveBoardMatch(r,[block(134089,'曾易浩-C19848',start+86400)]),null);
});
test('collection preserves the original room filter and authoritative 104/92 roster counts',async()=>{
 const requests=[];
 const fetch=async(url,options={})=>{
  const body=JSON.parse(options.body||'{}');requests.push({url,body});let payload;
  if(url.includes('getTermInfo'))payload={data:{termId:77,teacherName:url.includes('classId=999')?'Other-C2':'曾易浩-C19848'}};
  else if(url.includes('/courses/all'))payload=block().lessons;
  else if(url.includes('/course-detail'))payload={items:body.class_id===999?[{user_id:1,course_id:11},{user_id:93,course_id:11}]:[],total:body.class_id===999?2:0};
  else if(url.includes('/living/boards'))payload={data:{items:[room],total:1,pageSize:100}};
  else if(url.includes('/living/students')){const first=body.isParticipated?1:93,count=body.isParticipated?92:12;payload={data:{items:Array.from({length:count},(_,i)=>({userId:first+i,studentName:'fixture'})),total:count,pageSize:100}};}
  else throw new Error('unexpected endpoint '+url);
  const bytes=new TextEncoder().encode(JSON.stringify(payload));return {ok:true,status:200,arrayBuffer:async()=>bytes.buffer};
 };
 const collection=source.slice(source.indexOf('async function collectCrmData('),source.indexOf('\nasync function fetchInCrm('));
 const runtime={fetch,TextDecoder,AbortController,setTimeout,clearTimeout,Date};vm.runInNewContext(code+'\n'+collection,runtime);
 const result=JSON.parse(await runtime.collectCrmData([[134089,77]],[]));
 const board=result[0].liveAttendance['1'];assert.equal(board.expectedIds.length,104);assert.equal(board.attendedIds.length,92);assert.equal(board.absentIds.length,12);
 assert.equal(requests.find(r=>r.url.includes('/living/boards')).body.livingTypes.join(','),'0');
 const denied=JSON.parse(await runtime.collectCrmData([[134089,77]],[],undefined,async()=>{throw new Error('SOURCE_DENIED')}));
 assert.equal(denied[0].liveMatchDiagnostics.comparisonLookupError,'SOURCE_DENIED');
 assert.equal(denied[0].liveAttendance['1'].expectedIds.length,104);
 assert.equal(denied[0].liveAttendance['1'].attendedIds.length,92);
 const sharedRoom={roomUuid:'shared-room',livingId:'shared-room',classIdList:[999],courseNumber:1,source:'superset-472-3645',sharedClassroom:true,expectedByClass:{999:2}};
 const shared=JSON.parse(await runtime.collectCrmData([[999,77]],[],undefined,async()=>[sharedRoom]));
 assert.equal(shared[0].liveAttendance['1'].expectedIds.length,2);
 assert.equal(shared[0].liveAttendance['1'].attendedIds.length,1);
 const mismatch=JSON.parse(await runtime.collectCrmData([[999,77]],[],undefined,async()=>[{...sharedRoom,expectedByClass:{999:3}}]));
 assert.equal(mismatch[0].liveAttendance,undefined);
 assert.equal(mismatch[0].liveMatchDiagnostics.comparisonRosterError,'SHARED_ROOM_CLASS_MEMBERSHIP_UNVERIFIED');
});
