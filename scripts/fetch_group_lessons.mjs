import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] || 9222);
const classFile = process.argv[3] || "../data/classes.json";
const outFile = process.argv[4] || "../../data/group-lessons-raw.json";
const startClass = Number(process.argv[5] || 0);
const countClasses = Number(process.argv[6] || 0);
const courseChunkSize = Number(process.argv[7] || 2);
const classes = JSON.parse(fs.readFileSync(classFile, "utf8")).slice(startClass, countClasses ? startClass + countClasses : undefined);

async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
const targets = await json(`http://127.0.0.1:${port}/json/list`);
const page = targets.find(x => x.type === "page" && /codecamp-crm\.codemao\.cn/.test(x.url));
if (!page) throw new Error("CRM page not found on debug port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, {once:true}));
let seq=0; const pending=new Map();
ws.addEventListener("message", e => { const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
function send(method,params={}){const id=++seq;ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));}
async function evalJs(expression){const r=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;}
async function api(url, options){
  const merged={credentials:"include",...(options||{})};
  const expr=`(async()=>{const r=await fetch(${JSON.stringify(url)},${JSON.stringify(merged)});const t=await r.text();return {status:r.status,text:t}})()`;
  const r=await evalJs(expr); if(r.status<200||r.status>=300) throw new Error(`${r.status} ${url}: ${r.text.slice(0,300)}`); return JSON.parse(r.text);
}
const output=[];
for(let i=0;i<classes.length;i++){
  const [classId, hintedTermId]=classes[i];
  const infoResp=await api(`https://lbk-crm-teacher-web-api.codemao.cn/term/getTermInfo?classId=${classId}`);
  const info=infoResp.data||{}; const termId=Number(info.termId||hintedTermId);
  console.log(`[${i+1}/${classes.length}] class=${classId} teacher=${info.teacherName||"?"} term=${termId}`);
  if(info.teacherName==="薛超"){output.push({classId,termId,info,excluded:true,reason:"teacher"});continue;}
  let all=await api(`https://api-codecamp-crm.codemao.cn/terms/${termId}/courses/all`);
  let catalog=Array.isArray(all)?all:(all.data||[]);
  const lessons=catalog.filter(c=>/^\d+-/.test(String(c.course_name||""))&&!/赛考精讲课/.test(String(c.course_name||""))).sort((a,b)=>Number(a.unlock_time||0)-Number(b.unlock_time||0)||Number(a.course_number||0)-Number(b.course_number||0)).slice(0,50);
  if(!lessons.length) console.log("  course names:", catalog.slice(-12).map(x=>x.course_name).join(" | "));
  if(!lessons.length){output.push({classId,termId,info,lessons:[],items:[],reason:"no_lessons"});continue;}
  // Keep the current week and two preceding weeks. The extra prior week is
  // required when the dashboard falls back before this week's first class.
  const nowSec=Date.now()/1000;
  const shanghai=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));
  const weekday=(shanghai.getDay()+6)%7;
  const monday=new Date(shanghai);monday.setHours(0,0,0,0);monday.setDate(monday.getDate()-weekday);
  const windowStart=monday.getTime()/1000-14*86400,windowEnd=monday.getTime()/1000+7*86400;
  const courseIds=lessons.filter(x=>Number(x.unlock_time||0)>=windowStart&&Number(x.unlock_time||0)<windowEnd&&Number(x.unlock_time||0)<=nowSec).map(x=>x.course_id); const items=[]; const pageSize=500;
  for(let offset=0;offset<courseIds.length;offset+=courseChunkSize){
    const ids=courseIds.slice(offset,offset+courseChunkSize); const openCourseList=ids.map(courseId=>({courseId,paramValue:[0,1],isAllSelect:true}));
    let pageNo=1;
    while(true){
      const body={term_id:termId,class_id:classId,course_ids:ids,time_type:1,openCourseList,queryType:2};
      let resp; for(let attempt=1;attempt<=3;attempt++){try{resp=await api(`https://api-codecamp-crm.codemao.cn/annual/class/course-detail?page=${pageNo}&limit=${pageSize}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});break;}catch(e){if(attempt===3)throw e;await new Promise(r=>setTimeout(r,1000*attempt));}}
      const rows=resp.items||resp.data?.items||[]; items.push(...rows);
      const total=Number(resp.total??resp.data?.total??rows.length); console.log(`  courses=${offset+1}-${offset+ids.length} page=${pageNo} rows=${rows.length} total=${total}`);
      if(!rows.length||pageNo*pageSize>=total)break; pageNo++;
    }
  }
  const merged=new Map();
  for(const x of items){const k=`${x.user_id}|${x.course_id}`,old=merged.get(k);if(!old){merged.set(k,x);continue;}const preferred=(x.is_finish||x.is_open)?x:old;merged.set(k,{...old,...preferred,is_open:Boolean(old.is_open||x.is_open),is_finish:Boolean(old.is_finish||x.is_finish)});}
  const unique=[...merged.values()];
  output.push({classId,termId,info,lessons,items:unique});
  fs.mkdirSync(path.dirname(path.resolve(outFile)),{recursive:true}); fs.writeFileSync(outFile,JSON.stringify(output),"utf8");
}
ws.close();
fs.writeFileSync(outFile,JSON.stringify(output),"utf8");
console.log(`DONE ${path.resolve(outFile)}`);
