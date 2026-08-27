import fs from "node:fs";
import path from "node:path";

const dataDir=path.resolve(process.argv[2]||"../data");
const classFile=path.resolve(process.argv[3]||"../data/classes.json");
const rawFiles=(process.argv[4]||"group-lessons-raw.json").split(",");
const classPairs=JSON.parse(fs.readFileSync(classFile,"utf8"));
const mainTermByClass=new Map(classPairs.map(([classId,termId])=>[Number(classId),Number(termId)]));
const files=rawFiles;
const byClass=new Map();
for(const f of files) for(const x of JSON.parse(fs.readFileSync(path.join(dataDir,f),"utf8"))) byClass.set(Number(x.classId),x);
const classes=[...byClass.values()].filter(x=>!x.excluded&&x.info?.teacherName!=="薛超"&&x.items?.some(i=>i.is_open));
const teacherName=s=>String(s||"").replace(/-C\d+$/i,"");
const summary=[]; const courseNames=new Map();
for(const c of classes){
  const lessonNo=new Map(c.lessons.map((x,i)=>[Number(x.course_id),i+1]));
  for(const x of c.lessons){const n=lessonNo.get(Number(x.course_id));if(n)courseNames.set(n,String(x.course_name));}
  const byStudent=new Map();
  for(const x of c.items){const uid=String(x.user_id??"");if(!byStudent.has(uid))byStudent.set(uid,{uid,name:x.child_name||"",items:new Map()});byStudent.get(uid).items.set(lessonNo.get(Number(x.course_id)),x);}
  const teacher=teacherName(c.info.teacherName); const className=c.info.className||c.items[0]?.class_name||"";
  for(let n=2;n<=50;n+=2){const rows=[...byStudent.values()].map(s=>s.items.get(n)).filter(Boolean);if(!rows.length)continue;const sample=rows[0];const courseStarted=Number(sample.unlock_time||0)<=Date.now()/1000;const expected=courseStarted?rows.length:0;const doneRows=courseStarted?rows.filter(x=>x.is_finish):[];const done=doneRows.length;const firstRows=[...byStudent.values()].map(s=>s.items.get(n-1)).filter(Boolean);const firstStarted=firstRows.length&&Number(firstRows[0].unlock_time||0)<=Date.now()/1000;const firstExpected=firstStarted?firstRows.length:0;const firstArrivedIds=new Set(firstStarted?firstRows.filter(x=>x.is_open).map(x=>String(x.user_id)):[]);const doneIds=new Set(doneRows.map(x=>String(x.user_id)));const arrivedIncomplete=courseStarted?[...firstArrivedIds].filter(uid=>!doneIds.has(uid)).length:0;const unarrived=courseStarted?rows.filter(x=>!firstArrivedIds.has(String(x.user_id))).length:0;const board=c.liveAttendance?.[n-1];const liveAttend=board?new Set(board.attendedIds||[]).size:firstRows.filter(x=>x.live_course===true).length;const liveExpected=firstStarted?(board?new Set(board.expectedIds||[]).size:firstRows.length):0;summary.push([mainTermByClass.get(Number(c.classId))||c.termId,c.info.termName||"",teacher,c.classId,className,n,courseNames.get(n)||"",Number(sample.unlock_time||0),expected,done,firstExpected,firstArrivedIds.size,arrivedIncomplete,unarrived,expected-done,expected?done/expected:0,liveExpected,firstStarted?liveAttend:0,liveExpected?liveAttend/liveExpected:0,courseNames.get(n-1)||""]);}
}
const now=new Date();const shanghai=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));const day=(shanghai.getDay()+6)%7;const monday=new Date(shanghai);monday.setHours(0,0,0,0);monday.setDate(monday.getDate()-day);const sunday=new Date(monday);sunday.setDate(sunday.getDate()+7);const startSec=monday.getTime()/1000,endSec=sunday.getTime()/1000;
let dashboardStartSec=startSec,dashboardEndSec=endSec;
let weekly=summary.filter(r=>r[5]%2===0&&r[7]>=dashboardStartSec&&r[7]<dashboardEndSec);
if(!weekly.some(r=>r[8]>0||r[16]>0)){
  dashboardStartSec-=7*86400;dashboardEndSec-=7*86400;
  weekly=summary.filter(r=>r[5]%2===0&&r[7]>=dashboardStartSec&&r[7]<dashboardEndSec);
}
weekly.sort((a,b)=>a[0]-b[0]||b[15]-a[15]||b[18]-a[18]||String(a[2]).localeCompare(String(b[2]),"zh-CN")||a[3]-b[3]);
const overview=[];const groups=new Map();for(const r of weekly){const k=`${r[0]}|${r[2]}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}for(const rs of groups.values()){const total=rs.reduce((a,r)=>a+r[8],0),done=rs.reduce((a,r)=>a+r[9],0),arrivalExpected=rs.reduce((a,r)=>a+r[10],0),arrivalAttend=rs.reduce((a,r)=>a+r[11],0),arrived=rs.reduce((a,r)=>a+r[12],0),liveTotal=rs.reduce((a,r)=>a+r[16],0),liveAttend=rs.reduce((a,r)=>a+r[17],0),openedClasses=new Set(rs.filter(r=>r[8]>0||r[16]>0).map(r=>r[3])).size;overview.push([rs[0][0],rs[0][2],openedClasses,arrivalExpected,arrivalAttend,arrivalExpected?arrivalAttend/arrivalExpected:0,liveTotal,liveAttend,liveTotal?liveAttend/liveTotal:0,total,done,arrived,total-done,total?done/total:0]);}
overview.sort((a,b)=>a[0]-b[0]||b[13]-a[13]||b[8]-a[8]||String(a[1]).localeCompare(String(b[1]),"zh-CN"));
const teacherOrder=new Map(overview.map((r,i)=>[`${r[0]}|${r[1]}`,i]));
weekly.sort((a,b)=>a[0]-b[0]||(teacherOrder.get(`${a[0]}|${a[2]}`)??999)-(teacherOrder.get(`${b[0]}|${b[2]}`)??999)||a[3]-b[3]||a[5]-b[5]);
const termStats=new Map();
for(const r of overview){if(!termStats.has(r[0]))termStats.set(r[0],[]);termStats.get(r[0]).push(r);}
const anomalies=overview.map((r,i)=>{const peers=termStats.get(r[0]);const liveAvg=peers.reduce((a,x)=>a+x[8],0)/peers.length,finishAvg=peers.reduce((a,x)=>a+x[13],0)/peers.length,arriveAvg=peers.reduce((a,x)=>a+(x[9]?x[11]/x[9]:0),0)/peers.length,arriveRate=r[9]?r[11]/r[9]:0;return {row:i+2,mainTermId:r[0],teacher:r[1],liveBelow:r[8]<liveAvg,finishBelow:r[13]<finishAvg,arrivalIncompleteAbove:arriveRate>arriveAvg};});
const sheets={
  "组内概览":{columns:["主课期ID","老师","已开课班级数","第一节课应到次数","第一节课到课次数","到课率","直播应到次数","直播上座次数","直播上座率","偶数课应完课次数","偶数课已完课次数","到课未完课次数","偶数课未完课次数","偶数课完课率"],data:overview,dtypes:{"主课期ID":"int","已开课班级数":"int","第一节课应到次数":"int","第一节课到课次数":"int","到课率":"float","直播应到次数":"int","直播上座次数":"int","直播上座率":"float","偶数课应完课次数":"int","偶数课已完课次数":"int","到课未完课次数":"int","偶数课未完课次数":"int","偶数课完课率":"float"},formats:{"到课率":"0.0%","直播上座率":"0.0%","偶数课完课率":"0.0%"},anomalies},
  "班级课次看板":{columns:["主课期ID","课期","老师","班级ID","班级","偶数课节","偶数课课程名称","配对第一节课","第一节课应到人数","第一节课到课人数","到课率","直播应到人数","直播上座人数","直播上座率","应完课次数","已完课次数","到课未完课次数","未到课次数","未完课次数","完课率"],data:weekly.map(r=>[r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[19],r[10],r[11],r[10]?r[11]/r[10]:0,r[16],r[17],r[18],r[8],r[9],r[12],r[13],r[14],r[15]]),dtypes:{"主课期ID":"int","班级ID":"int","偶数课节":"int","第一节课应到人数":"int","第一节课到课人数":"int","到课率":"float","直播应到人数":"int","直播上座人数":"int","直播上座率":"float","应完课次数":"int","已完课次数":"int","到课未完课次数":"int","未到课次数":"int","未完课次数":"int","完课率":"float"},formats:{"到课率":"0.0%","直播上座率":"0.0%","完课率":"0.0%"}}
};
fs.writeFileSync(path.join(dataDir,"group-dashboard-tables.json"),JSON.stringify({classes:classes.length,sourceClasses:byClass.size,sheets}),"utf8");
console.log(JSON.stringify({sourceClasses:byClass.size,openedClasses:classes.length,teachers:new Set(classes.map(c=>teacherName(c.info.teacherName))).size,week:[new Date(dashboardStartSec*1000).toISOString(),new Date(dashboardEndSec*1000).toISOString()],fallbackToPreviousWeek:dashboardStartSec!==startSec,rows:Object.fromEntries(Object.entries(sheets).map(([k,v])=>[k,v.data.length]))}));
