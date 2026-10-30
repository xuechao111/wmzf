let LOCAL_BASE="http://127.0.0.1:8765";
const CRM_RUNTIME_TIMEOUT_MS=6*60*1000;
const LOCAL_RUNTIME_TIMEOUT_MS=11*60*1000;
const activeUpdateRuns=new Set();

function normalizeLocalBase(value){
  return /^http:\/\/(127\.0\.0\.1|localhost):876[56]$/.test(String(value||""))?String(value):"http://127.0.0.1:8765";
}
function instanceStorageKey(name,localBase=LOCAL_BASE){
  return `${name}${normalizeLocalBase(localBase).endsWith(":8766")?"Test":""}`;
}
function instanceAlarmPrefix(localBase=LOCAL_BASE){
  return normalizeLocalBase(localBase).endsWith(":8766")?"codemao-test-update":"codemao-update";
}

async function injectDashboardBridge(){
  try{
    const tabs=await chrome.tabs.query({url:["http://127.0.0.1/*","http://localhost/*"]});
    await Promise.all(tabs.map(tab=>chrome.scripting.executeScript({target:{tabId:tab.id},files:["bridge.js"]}).catch(()=>null)));
  }catch{}
}

async function fetchWithTimeout(url,options={},timeout=20000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{return await fetch(url,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);}
}

async function waitForLocalPreparation(slotKey="manual",timeout=2*60*1000,localBase=LOCAL_BASE,endpoint="prepare-extension"){
  localBase=normalizeLocalBase(localBase);
  const deadline=Date.now()+timeout;
  let lastError="本地控制台服务未启动";
  while(Date.now()<deadline){
    try{
      // Reading the DingTalk class configuration can exceed ten seconds.
      // Aborting at 10s left the local service finishing work for a socket the
      // browser had already closed, which was incorrectly surfaced as an
      // update failure.  Keep this below the outer two-minute deadline while
      // allowing one preparation attempt to finish normally.
      const response=await fetchWithTimeout(`${localBase}/${endpoint}`,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({slotKey})},60000);
      if(response.status===409)throw new Error("已有更新正在运行");
      if(response.status===429){let detail="同一自动更新时段正在冷却";try{detail=(await response.json()).message||detail}catch{}throw new Error(`SCHEDULE_COOLDOWN:${detail}`);}
      if(response.ok||response.status===503){const payload=await response.json();if(!payload.preparing&&response.ok)return payload;lastError="正在读取钉钉最新班级明细";}
      else if(response.status===422){const error=await response.json();throw new Error(`CLASS_SOURCE_FAILED:${error.message||error.detail||"读取最新班级明细失败"}`);}
      if(!response.ok)lastError=`本地控制台返回 ${response.status}`;
    }catch(error){
      const message=String(error?.message||error);
      if(message==="已有更新正在运行")throw error;
      if(message.startsWith("SCHEDULE_COOLDOWN:"))throw error;
      if(message.startsWith("CLASS_SOURCE_FAILED:"))throw error;
      lastError=message;
    }
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw new Error(`本地控制台服务连续2分钟不可用：${lastError}`);
}

async function postLocalStatus(state,message,detail="",phase="crm",localBase=LOCAL_BASE){
  const body=JSON.stringify({state,message,detail,phase}).replace(/[\u0080-\uFFFF]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,"0")}`);
  try{await fetchWithTimeout(`${normalizeLocalBase(localBase)}/extension-status`,{method:"POST",headers:{"Content-Type":"application/json"},body},5000);}catch{}
}

async function appendRunLog(event,detail="",localBase=LOCAL_BASE){
  const key=instanceStorageKey("updateRunLog",localBase);
  const stored=await chrome.storage.local.get(key);
  const rows=Array.isArray(stored[key])?stored[key]:[];
  rows.push({time:new Date().toLocaleString("zh-CN",{hour12:false}),event,detail:String(detail||"")});
  await chrome.storage.local.set({[key]:rows.slice(-30)});
}

function base64ToBytes(value){
  const raw=atob(String(value||""));
  const bytes=new Uint8Array(raw.length);
  for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);
  return bytes;
}

async function pollMcpRelay(localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  let request=null;
  try{
    const response=await fetchWithTimeout(`${localBase}/mcp-relay-next`,{cache:"no-store"},4000);
    if(!response.ok)return false;
    request=await response.json();
    if(request.id==null||request.id===""||request.idle)return false;
  }catch{return false;}
  const finish=async(payload)=>{
    try{await fetchWithTimeout(`${localBase}/mcp-relay-result`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:request.id,...payload})},5000);}catch{}
  };
  try{
    if(!/^https:\/\/mcp-gw\.dingtalk\.com\//.test(String(request.url||"")))throw new Error("钉钉中继地址不合法");
    const headers={"Content-Type":"application/json","Accept":"application/json"};
    if(request.token)headers.Authorization=`Bearer ${request.token}`;
    const response=await fetchWithTimeout(request.url,{method:"POST",headers,body:base64ToBytes(request.bodyBase64)},Number(request.timeoutMs||180000));
    const bodyText=await response.text();
    await finish({ok:response.ok,status:response.status,bodyText,error:response.ok?"":bodyText.slice(0,500)});
    return true;
  }catch(error){
    await finish({ok:false,error:String(error?.message||error)});
    return true;
  }
}

function startMcpRelay(localBase=LOCAL_BASE){
  let stopped=false,running=false;
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try{await pollMcpRelay(localBase);}finally{running=false;}
  };
  const timer=setInterval(tick,350);
  tick();
  return ()=>{stopped=true;clearInterval(timer);};
}

const mcpRelayLeases=new Map();
function leaseMcpRelay(localBase=LOCAL_BASE,ttl=12*60*1000){
  localBase=normalizeLocalBase(localBase);
  const previous=mcpRelayLeases.get(localBase);
  if(previous?.timer)clearTimeout(previous.timer);
  const stop=previous?.stop||startMcpRelay(localBase);
  const timer=setTimeout(()=>{
    stop();
    mcpRelayLeases.delete(localBase);
  },ttl);
  mcpRelayLeases.set(localBase,{stop,timer});
  return stop;
}

async function reconcileUpdateRuntime(localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const runtimeKey=instanceStorageKey("updateRuntime",localBase),scheduleKey=instanceStorageKey("autoSchedule",localBase);
  // A live owner still has to finish service collection after local success.
  if(activeUpdateRuns.has(localBase))return;
  const stored=await chrome.storage.local.get([runtimeKey,scheduleKey]);
  const runtime=stored[runtimeKey]||{};
  const runningSince=Number(runtime.runningSince||0);
  if(!runningSince)return;
  try{
    const response=await fetchWithTimeout(`${localBase}/status`,{cache:"no-store"},5000);
    if(!response.ok)return;
    const status=await response.json();
    const state=String(status.state||"");
    if(state==="running"){
      const phase=String(status.phase||"crm");
      const timeout=phase==="service"?32*60*1000:phase==="local"?LOCAL_RUNTIME_TIMEOUT_MS:CRM_RUNTIME_TIMEOUT_MS;
      if(Date.now()-runningSince<=timeout)return;
      const detail=phase==="service"?"教学服务阶段超过32分钟未完成，已解除连接器等待；请查看教学服务状态后重试。":phase==="local"
        ?"本地计算或钉钉同步超过11分钟没有完成，已解除连接器等待；部分子表可能已更新，请查看日志后重试。"
        :"CRM连接超过6分钟没有返回，已自动解除任务锁；旧数据保持不变，可以重新更新。";
      const schedule=stored[scheduleKey]||{};
      const endedAt=new Date().toLocaleString("zh-CN",{hour12:false});
      await postLocalStatus("error","更新已超时并自动解除",detail,"timeout",localBase);
      await chrome.storage.local.set({[scheduleKey]:{...schedule,lastRun:endedAt,lastResult:detail}});
      await chrome.storage.local.remove(runtimeKey);
      await appendRunLog("自动解除卡住任务",detail,localBase);
      return;
    }
    if(!["success","error"].includes(state))return;
    const statusTime=Date.parse(String(status.time||"").replace(" ","T"));
    if(!Number.isFinite(statusTime)||statusTime+5000<runningSince)return;
    const schedule=stored[scheduleKey]||{};
    const success=status.state==="success"&&status.phase==="service";
    await chrome.storage.local.set({[scheduleKey]:{
      ...schedule,
      lastRun:String(status.time||new Date().toLocaleString("zh-CN",{hour12:false})),
      lastResult:success?"更新成功":String(status.state==="success"?"教学数据已完成，但教学服务未确认完成，请重新更新":status.detail||status.message||"更新失败"),
      ...(success?{lastSuccessKey:runtime.slotKey||schedule.lastSuccessKey||"",lastSuccessAt:String(status.time||new Date().toLocaleString("zh-CN",{hour12:false}))}:{})
    }});
    await chrome.storage.local.remove(runtimeKey);
    await appendRunLog(success?"自动恢复成功状态":"自动恢复失败状态",status.message||status.detail||"",localBase);
  }catch{}
}

async function waitForTabReady(tabId,timeout=20000){
  const tab=await chrome.tabs.get(tabId);
  if(tab.status==="complete"&&!tab.discarded)return tab;
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);reject(new Error("CRM页面加载超时"));},timeout);
    const listener=(id,change,current)=>{if(id===tabId&&change.status==="complete"){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve(current);}};
    chrome.tabs.onUpdated.addListener(listener);
    if(tab.discarded)chrome.tabs.reload(tabId).catch(reject);
  });
}


function resolveLiveBoardMatch(board,blocks){
  const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const teacher=value=>text(value).split('-C')[0].trim();
  const titles=[board.courseName,board.livingTitle,board.livingName,board.title].map(text).filter(Boolean);
  const numbered=titles.map(value=>value.match(/^(\d+)\s*[-‐‑–—－、.]/)).find(Boolean);
  const explicit=Number(board.courseNumber||board.course_number||0);
  const number=numbered?Number(numbered[1]):(Number.isInteger(explicit)&&explicit>0?explicit:0);
  const courseTitle=value=>text(value).replace(/^\d+\s*[-‐‑–—－、.]\s*/,'');
  const ids=new Set();
  const visit=(node,key='')=>{
    if(Array.isArray(node)){node.forEach(value=>visit(value,key));return}
    if(node&&typeof node==='object'){Object.entries(node).forEach(([k,v])=>visit(v,k));return}
    if(/class.*id|id.*class/i.test(key)&&Number.isInteger(Number(node))&&Number(node)>0)ids.add(Number(node));
  };
  visit(board);
  const exact=blocks.filter(block=>!block.excluded&&ids.has(Number(block.classId)));
  const boardTeacher=teacher(board.teacherName||board.teacherFullName||board.teacherNickname||board.nickname||board.teacher?.name);
  const rawStart=board.livingStartTime||board.startTime||board.livingBeginTime||0;
  let start=Number(rawStart);
  if(!Number.isFinite(start)){const value=text(rawStart);start=Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value)?value:value.replace(' ','T')+'+08:00')/1000;}
  if(start>1e12)start=Math.floor(start/1000);
  const lessonMatches=block=>(block.lessons||[]).filter(lesson=>{
    const courseNumber=Number(lesson.course_number||0);
    if(!courseNumber)return false;
    return number?courseNumber===number:titles.some(title=>courseTitle(title)===courseTitle(lesson.course_name));
  });
  if(exact.length){
    if(number)return {lessonNumber:number,targets:exact,method:'class-id'};
    const matches=exact.flatMap(block=>lessonMatches(block).map(lesson=>({block,lesson})));
    const numbers=[...new Set(matches.map(({lesson})=>Number(lesson.course_number)))];
    if(numbers.length===1)return {lessonNumber:numbers[0],targets:[...new Set(matches.map(({block})=>block))],method:'class-id-course-title'};
    return null;
  }
  // Preserve the original teacher + course + time lookup, but never merge
  // ambiguous same-teacher sessions or accept an unverified room title.
  if(!boardTeacher||!Number.isFinite(start)||start<=0)return null;
  const candidates=blocks.filter(block=>!block.excluded&&teacher(block.info?.teacherName)===boardTeacher)
    .flatMap(block=>lessonMatches(block).filter(lesson=>Math.abs(Number(lesson.unlock_time||0)-start)<=7200).map(lesson=>({block,lesson})));
  const matchedBlocks=[...new Set(candidates.map(({block})=>block))];
  const numbers=[...new Set(candidates.map(({lesson})=>Number(lesson.course_number)))];
  if(matchedBlocks.length!==1||numbers.length!==1)return null;
  return {lessonNumber:numbers[0],targets:matchedBlocks,method:'teacher-course-time'};
}

async function collectCrmData(classes,excludedTeachers=["薛超"],onProgress=async()=>{},roomLookup=null){
        const deadline=Date.now()+4*60*1000;
        const api=async(url,options,policy={})=>{
          const maxAttempts=Math.max(1,Number(policy.attempts||3));
          const requestTimeout=Math.max(3000,Number(policy.timeout||20000));
          let lastError;
          for(let attempt=1;attempt<=maxAttempts;attempt++){
            if(Date.now()>=deadline)throw new Error("CRM_TOTAL_TIMEOUT");
            const controller=new AbortController();
            const timer=setTimeout(()=>controller.abort(),requestTimeout);
            try{
              const r=await fetch(url,{credentials:"include",...(options||{}),signal:controller.signal});
              const bytes=await r.arrayBuffer();
              let text;
              try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
              catch{text=new TextDecoder("gb18030",{fatal:true}).decode(bytes);}
              if(r.status===401)throw new Error("CRM_LOGIN_EXPIRED");
              if(!r.ok){
                let reason="";
                try{const errorPayload=JSON.parse(text);reason=String(errorPayload?.message||errorPayload?.msg||errorPayload?.error||"").replace(/\s+/g," ").trim().slice(0,160);}catch{}
                const httpError=new Error(`CRM_HTTP_${r.status}${reason?`:${reason}`:""}`);
                httpError.httpStatus=r.status;
                throw httpError;
              }
              const parsed=JSON.parse(text);
              if(parsed?.code&&Number(parsed.code)!==200)throw new Error(`CRM_API_${parsed.code}`);
              return parsed;
            }catch(error){
              lastError=error;
              if(String(error?.message||error).includes("CRM_LOGIN_EXPIRED"))throw error;
              const httpStatus=Number(error?.httpStatus||0);
              if(httpStatus>=400&&httpStatus<500&&httpStatus!==408&&httpStatus!==429)throw error;
              if(attempt<maxAttempts)await new Promise(r=>setTimeout(r,900*attempt));
            }finally{clearTimeout(timer);}
          }
          const endpoint=(()=>{try{const parsed=new URL(url);return `${parsed.hostname}${parsed.pathname}`}catch{return String(url)}})();
          const reason=String(lastError?.message||lastError||"CRM_REQUEST_FAILED");
          throw new Error(`CRM_REQUEST_FAILED:${endpoint}:${reason}`);
        };
        const output=[];
        let completedClasses=0,lastProgressAt=0;
        const finishClass=async block=>{
          completedClasses++;
          if(completedClasses===classes.length||completedClasses%6===0||Date.now()-lastProgressAt>15000){
            lastProgressAt=Date.now();
            await onProgress("正在读取CRM班级与课次数据…",`已完成 ${completedClasses}/${classes.length} 个班级`);
          }
          return block;
        };
        const compactKeys=["class_id","class_name","live_course","user_id","course_id","course_number","unlock_time","nickname","child_name","phone_number","bind_phone_number","is_open","course_open_time","is_finish","course_finish_time","watch_time","watch_process","day_of_week","class_time"];
        const compactItem=item=>Object.fromEntries(compactKeys.filter(key=>item[key]!==undefined&&item[key]!==null).map(key=>[key,item[key]]));
        const compactInfo=info=>Object.fromEntries(["teacherName","className","termName","classId","termId"].filter(key=>info[key]!==undefined&&info[key]!==null).map(key=>[key,info[key]]));
        const mapLimit=async(values,limit,worker)=>{
          const results=new Array(values.length);
          let cursor=0;
          const runners=Array.from({length:Math.min(limit,values.length)},async()=>{
            while(true){
              const index=cursor++;
              if(index>=values.length)return;
              results[index]=await worker(values[index],index);
            }
          });
          await Promise.all(runners);
          return results;
        };
        const nowSec=Date.now()/1000;
        const shanghai=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));
        const weekday=(shanghai.getDay()+6)%7;
        const monday=new Date(shanghai);monday.setHours(0,0,0,0);monday.setDate(monday.getDate()-weekday);
        // Keep two prior weeks: before this week's first class the dashboard
        // falls back to last week and still needs the week-before-last baseline.
        let windowStart=monday.getTime()/1000-14*86400;
        const windowEnd=monday.getTime()/1000+7*86400;
        const openedWeek=seconds=>Math.floor((Number(seconds)+8*3600-4*86400)/(7*86400));
        // CRM used to read all configured classes serially. With 50+ classes,
        // network latency was multiplied by every class. Four workers keep the
        // request rate conservative while reducing the wall-clock time.
        // Courses/all is scoped only by term ID; share in-flight catalogs within
        // this collection, never learner details or a previous run's business data.
        const termCatalogs=new Map();
        const getTermCatalog=termId=>{
          if(!termCatalogs.has(termId)){
            const request=api(`https://api-codecamp-crm.codemao.cn/terms/${termId}/courses/all`).catch(error=>{termCatalogs.delete(termId);throw error;});
            termCatalogs.set(termId,request);
          }
          return termCatalogs.get(termId);
        };
        const classBlocks=await mapLimit(classes,4,async pair=>{
          const classId=Number(pair[0]),hintedTermId=Number(pair[1]);
          const infoResp=await api(`https://lbk-crm-teacher-web-api.codemao.cn/term/getTermInfo?classId=${classId}`);
          const info=infoResp.data||{},termId=Number(info.termId||hintedTermId);
          if((excludedTeachers||[]).includes(String(info.teacherName||"").split("-C")[0]))return finishClass({classId,termId,info:compactInfo(info),excluded:true,reason:"teacher"});
          const all=await getTermCatalog(termId);
          const catalog=Array.isArray(all)?all:(all.data||[]);
          const lessons=catalog.filter(c=>/^\d+-/.test(String(c.course_name||""))&&!/赛考精讲课/.test(String(c.course_name||""))).sort((a,b)=>Number(a.unlock_time||0)-Number(b.unlock_time||0)||Number(a.course_number||0)-Number(b.course_number||0)).slice(0,50);
          // Select actual opened weeks so holiday gaps cannot erase the baseline.
          const opened=lessons.filter(x=>Number(x.unlock_time||0)>0&&Number(x.unlock_time||0)<=nowSec);
          const weeks=[...new Set(opened.map(x=>openedWeek(x.unlock_time)))].sort((a,b)=>b-a).slice(0,2);
          const selected=opened.filter(x=>weeks.includes(openedWeek(x.unlock_time)));
          if(selected.length)windowStart=Math.min(windowStart,...selected.map(x=>Number(x.unlock_time)));
          const courseIds=selected.map(x=>x.course_id);
          const items=[];
          // The learner-detail endpoint returns only the latest weekly pair
          // when multiple weeks are submitted together. Fetch one odd/even
          // pair at a time so the prior week's odd-course live baseline is
          // preserved for same-slot Gap comparisons.
          for(let offset=0;offset<courseIds.length;offset+=2){
            const ids=courseIds.slice(offset,offset+2),openCourseList=ids.map(courseId=>({courseId,paramValue:[0,1],isAllSelect:true}));
            let pageNo=1;
            while(true){
              const body={term_id:termId,class_id:classId,course_ids:ids,time_type:1,openCourseList,queryType:2};
              let resp;
              for(let attempt=1;attempt<=3;attempt++){try{resp=await api(`https://api-codecamp-crm.codemao.cn/annual/class/course-detail?page=${pageNo}&limit=500`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});break;}catch(error){if(attempt===3)throw error;await new Promise(r=>setTimeout(r,700*attempt));}}
              const rows=resp.items||resp.data?.items||[];items.push(...rows);
              const total=Number(resp.total??resp.data?.total??rows.length);
              if(!rows.length||pageNo*500>=total)break;
              pageNo++;
            }
          }
          const merged=new Map();
          for(const x of items){const key=`${x.user_id}|${x.course_id}`,old=merged.get(key);if(!old){merged.set(key,x);continue;}const preferred=(x.is_finish||x.is_open)?x:old;merged.set(key,{...old,...preferred,is_open:Boolean(old.is_open||x.is_open),is_finish:Boolean(old.is_finish||x.is_finish)});}
          return finishClass({classId,termId,info:compactInfo(info),lessons,items:[...merged.values()].map(compactItem)});
        });
        output.push(...classBlocks);
        // Timely participation must come from the CRM live-board API.  The
        // course-detail `live_course` flag represents total participation and
        // does not match the board's "观看人数" metric.
        const livePost=async(url,body)=>api(url,{method:"POST",headers:{"content-type":"application/json;charset=UTF-8","authorization_type":"3"},body:JSON.stringify(body)},{timeout:12000,attempts:3});
        const firstBoards=await livePost("https://lbk-crm-teacher-web-api.codemao.cn/shengwang/living/boards",{page:1,limit:100,minLivingStartTime:windowStart,maxLivingStartTime:Math.min(windowEnd,nowSec+3600),livingTypes:[0]});
        let boards=firstBoards.data?.items||[];
        const boardPages=Math.ceil(Number(firstBoards.data?.total||boards.length)/Number(firstBoards.data?.pageSize||100));
        const remainingPages=Array.from({length:Math.max(0,boardPages-1)},(_,index)=>index+2);
        const boardResponses=await mapLimit(remainingPages,4,page=>livePost("https://lbk-crm-teacher-web-api.codemao.cn/shengwang/living/boards",{page,limit:100,minLivingStartTime:windowStart,maxLivingStartTime:Math.min(windowEnd,nowSec+3600),livingTypes:[0]}));
        for(const next of boardResponses)boards.push(...(next.data?.items||[]));
        if(!boards.length)throw new Error("CRM_LIVE_BOARDS_EMPTY");
        let comparisonLookupError=null;
        if(roomLookup){try{
          const extra=await roomLookup(output,windowStart,Math.min(windowEnd,nowSec));
          const seen=new Set(boards.map(b=>b.roomUuid));
          for(const board of extra)if(!seen.has(board.roomUuid)){boards.push(board);seen.add(board.roomUuid);}
        }catch(error){comparisonLookupError=String(error.message||error);}}

        const rosterCache=new Map();
        const studentIds=(board,isParticipated)=>{
          const cacheKey=`${board.roomUuid}|${isParticipated?1:0}`;
          if(rosterCache.has(cacheKey))return rosterCache.get(cacheKey);
          const request=(async()=>{
            let pageIndex=1,ids=[],names={};
            while(true){
              // This CRM endpoint rejects values above 100 with HTTP 400.
              // Keep its verified maximum and gain speed through room-level
              // concurrency and duplicate-room caching instead.
              const requestedPageSize=100;
              const response=await livePost("https://cloud-gateway.codemao.cn/crm-common/shengwang/living/students",{roomUuid:board.roomUuid,pageIndex,pageSize:requestedPageSize,isParticipated});
              const rows=response.data?.items||[];
              for(const row of rows){const id=String(row.userId||"");if(id){ids.push(id);names[id]=String(row.studentName||row.wechatNickname||"");}}
              const actualPageSize=Number(response.data?.pageSize||rows.length||requestedPageSize);
              if(!rows.length||pageIndex*actualPageSize>=Number(response.data?.total||rows.length))break;
              pageIndex++;
            }
            return {ids,names};
          })();
          rosterCache.set(cacheKey,request);
          return request;
        };
        let matchedLiveBoards=0;
        const liveMatches=[];
        for(const board of boards){
          const match=resolveLiveBoardMatch(board,output);
          if(!match)continue;
          matchedLiveBoards+=match.targets.length;
          liveMatches.push({board,lessonNumber:match.lessonNumber,targets:match.targets});
        }
        // Keep room-level diagnostics beside the raw batch for failed matches.
        // No student names or session credentials are included.
        for(const block of output){
          if(block.excluded)continue;
          const teacher=String(block.info?.teacherName||'').split('-C')[0].trim();
          const related=boards.filter(board=>String(board.teacherName||board.teacherFullName||board.teacherNickname||board.nickname||board.teacher?.name||'').split('-C')[0].trim()===teacher);
          block.liveMatchDiagnostics={comparisonLookupError,queriedRooms:boards.length,matchedRooms:liveMatches.filter(match=>match.targets.includes(block)).length,
            teacherRooms:related.map(board=>({livingId:board.livingId,courseName:board.courseName,livingTitle:board.livingTitle,livingName:board.livingName,
              classId:board.classId,classIdList:board.classIdList,livingStartTime:board.livingStartTime,livingType:board.livingType,fields:Object.keys(board)}))};
        }
        // Fetch independent room rosters with bounded concurrency, then merge
        // them in source order so duplicate-room reconciliation stays stable.
        let completedLiveRooms=0;
        const liveResults=await mapLimit(liveMatches,6,async match=>{
          let attended,absent;try{[attended,absent]=await Promise.all([studentIds(match.board,true),studentIds(match.board,false)]);}catch(error){if(match.board.source==='superset-472-3645'){for(const block of match.targets)block.liveMatchDiagnostics.comparisonRosterError=String(error.message||error);return null;}throw error;}
          completedLiveRooms++;
          if(completedLiveRooms===liveMatches.length||completedLiveRooms%5===0){
            await onProgress("正在读取CRM直播上座名单…",`6路并行 · 已完成 ${completedLiveRooms}/${liveMatches.length} 个直播房间`);
          }
          return {...match,attended,absent};
        });
        for(const {board,lessonNumber,targets,attended,absent} of liveResults.filter(Boolean)){
          for(const block of targets){
            let classAttended=attended,classAbsent=absent;
            if(board.sharedClassroom){
              const lesson=(block.lessons||[]).find(l=>Number(l.course_number)===Number(lessonNumber));
              const members=new Set((block.items||[]).filter(x=>Number(x.course_id)===Number(lesson?.course_id)).map(x=>String(x.user_id)));
              const restrict=roster=>({ids:roster.ids.filter(id=>members.has(id)),names:Object.fromEntries(Object.entries(roster.names).filter(([id])=>members.has(id)))});
              classAttended=restrict(attended);classAbsent=restrict(absent);
              const expected=new Set([...classAttended.ids,...classAbsent.ids]);
              if(!members.size||expected.size!==Number(board.expectedByClass?.[block.classId])){block.liveMatchDiagnostics.comparisonRosterError='SHARED_ROOM_CLASS_MEMBERSHIP_UNVERIFIED';continue;}
            }
            block.liveAttendance=block.liveAttendance||{};
            const old=block.liveAttendance[lessonNumber]||{expectedIds:[],attendedIds:[],absentIds:[],names:{},boardIds:[]};
            old.expectedIds=[...new Set([...old.expectedIds,...classAttended.ids,...classAbsent.ids])];
            old.attendedIds=[...new Set([...old.attendedIds,...classAttended.ids])];
            const attendedSet=new Set(old.attendedIds);
            // A learner may be absent in an earlier/duplicate room but present
            // in another room for the same class lesson. Final absence must be
            // expected minus final attendance, never a union of absence lists.
            old.absentIds=old.expectedIds.filter(id=>!attendedSet.has(id));
            old.names={...old.names,...classAttended.names,...classAbsent.names};
            old.boardIds=[...new Set([...old.boardIds,String(board.livingId||board.roomUuid||"")])];
            block.liveAttendance[lessonNumber]=old;
          }
        }
        if(!matchedLiveBoards)throw new Error("CRM_LIVE_BOARDS_CLASS_MISMATCH");
        const brokenNames=output.filter(block=>String(block.info?.teacherName||"").includes("�"));
        if(brokenNames.length)throw new Error(`CRM_TEXT_ENCODING_INVALID:${brokenNames.map(x=>x.classId).join(",")}`);
        return JSON.stringify(output);
}

async function fetchComparisonLiveRooms(blocks,start,end){
  const tabs=await chrome.tabs.query({url:"https://bigdata-superset.codemao.cn/*"});
  const tab=tabs.find(t=>!t.discarded&&/\/dashboard\/472\//.test(t.url||''))||tabs.find(t=>!t.discarded);if(!tab)throw new Error("COMPARISON_LIVE_SUPERSET_TAB_REQUIRED");
  const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",args:[start,end],func:async(start,end)=>{try{
    const api=async(url,options={})=>{const response=await fetch(url,{credentials:"include",...options});if(!response.ok)throw new Error(`SUPERSET_LIVE_HTTP_${response.status}:${url}`);return response.json()};
    const listing=await api('/api/v1/dashboard/472/charts');const charts=listing.result||listing.charts||listing;let chart=charts.find(c=>Number(c.id||c.slice_id)===3645);
    // Dashboard listings may omit query_context. Fetch the authorized chart
    // definition before falling back to a partially rendered dashboard table.
    if(!chart?.query_context){
      const detail=await api('/api/v1/chart/3645');
      chart={...(chart||{}),...(detail.result||detail)};
    }
    if(!chart?.query_context){
      // Read only rows already rendered by the authorized dashboard. Missing
      // pages/dates remain unknown; never derive counts from rounded rates.
      const root=document.querySelector('[data-test-chart-id="3645"]')||document.getElementById('chart-id-3645');
      const columns=Array.from(root?.querySelectorAll('thead th')||[],x=>x.innerText.trim());
      const rows=Array.from(root?.querySelectorAll('tbody tr')||[]).map(tr=>Array.from(tr.querySelectorAll('td'),td=>td.innerText.trim())).filter(cells=>cells.length===columns.length).map(cells=>Object.fromEntries(columns.map((name,i)=>[name,cells[i]])));
      if(!columns.includes('课堂UUID')||!rows.length)throw new Error('SUPERSET_LIVE_DETAIL_TABLE_REQUIRED');
      return {ok:true,rows,columns,verbose:{},source:'visible-dashboard-472-3645'};
    }
    const template=JSON.parse(chart.query_context);template.form_data={...(template.form_data||{}),dashboardId:472};
    const csrf=(await api('/api/v1/security/csrf_token/')).result;
    const date=v=>new Date((v+28800)*1000).toISOString().slice(0,19);
    for(const q of template.queries||[]){q.filters=[];q.time_range=`${date(start)} : ${date(end)}`;q.row_limit=200000;q.row_offset=0;if(q.extras){q.extras.where='';q.extras.having='';}}
    template.force=true;template.result_format='json';template.result_type='full';
    const payload=await api('/api/v1/chart/data',{method:'POST',headers:{'Content-Type':'application/json','X-CSRFToken':csrf},body:JSON.stringify(template)});
    const raw=payload.result?.[0];if(!Array.isArray(raw?.data)||Number(raw.rowcount||0)>raw.data.length)throw new Error('SUPERSET_LIVE_INCOMPLETE');
    const labels={...(chart.params?JSON.parse(chart.params).label_map:{}),...(raw.label_map||{})};
    const metrics=(template.queries||[]).flatMap(q=>[...(q.columns||[]),...(q.metrics||[])]);
    const aliases={};for(const field of metrics)if(field&&typeof field==='object'){aliases[field.label]=field.sqlExpression||field.column?.column_name||field.label;}
    return {ok:true,rows:raw.data,columns:raw.colnames,aliases,verbose:chart.verbose_map||{},labels};
  }catch(e){return {ok:false,error:String(e.message||e)}}}});
  const data=result?.[0]?.result;if(!data?.ok)throw new Error(data?.error||'SUPERSET_LIVE_NO_RESPONSE');
  const columns=data.columns||Object.keys(data.rows[0]||{}),normal=v=>String(v||'').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,'').toLowerCase();
  const find=names=>columns.find(c=>names.some(n=>normal(c)===normal(n)||normal(data.verbose[c])===normal(n)));
  const uuid=find(['课堂UUID','room_uuid','roomUuid','living_uuid','classroom_uuid']),worker=find(['老师工号','worker_no']),teacher=find(['老师','teacher_name','beisen_user_fullname']),course=find(['课程id','course_id']),term=find(['课期id','term_id']),day=find(['开播时间','living_start_date','living_start_time','start_time','stat_date','dt']);
  if(!uuid||!course||!day||(!worker&&!teacher))throw new Error(`SUPERSET_LIVE_COLUMNS_MISSING:${JSON.stringify(columns)}`);
  const rooms=[];
  for(const row of data.rows){
    const date=String(row[day]).slice(0,10),id=String(row[uuid]||'');if(!id)continue;
    const targets=blocks.filter(b=>!b.excluded&&(!term||Number(b.termId)===Number(row[term]))&&((worker&&String(b.info?.teacherName||'').endsWith('-'+String(row[worker])))||(!worker&&String(b.info?.teacherName||'').split('-C')[0]===String(row[teacher]))))
      .flatMap(b=>(b.lessons||[]).filter(l=>Number(l.course_id)===Number(row[course])&&Number(l.unlock_time)<=end&&new Date((Number(l.unlock_time)+28800)*1000).toISOString().slice(0,10)===date).map(l=>({b,l})));
    if(targets.length!==1)continue;
    const {b,l}=targets[0];const expectedColumn=find(['应参播学员数']);rooms.push({roomUuid:id,livingId:id,classIdList:[b.classId],courseNumber:l.course_number,teacherName:b.info.teacherName,livingStartTime:l.unlock_time,source:'superset-472-3645',expectedByClass:{[b.classId]:Number(row[expectedColumn])}});
  }
  // Shared classrooms require class membership filtering and a verified
  // expected count before any roster can be used for one teacher.
  const sourceOwners=new Map();
  for(const row of data.rows){const id=String(row[uuid]||''),owners=sourceOwners.get(id)||new Set();owners.add(String(row[worker||teacher]||''));sourceOwners.set(id,owners);}
  const grouped=new Map();
  for(const room of rooms){
    room.sharedClassroom=sourceOwners.get(room.roomUuid)?.size>1;
    const old=grouped.get(room.roomUuid);
    if(!old)grouped.set(room.roomUuid,room);
    else if(old.courseNumber===room.courseNumber){old.classIdList=[...new Set([...old.classIdList,...room.classIdList])];Object.assign(old.expectedByClass,room.expectedByClass);}
  }
  return [...grouped.values()];
}

async function fetchInCrm(classes,excludedTeachers=["薛超"],reconnectAttempt=0,localBase=LOCAL_BASE){
  const tabs=await chrome.tabs.query({url:"https://codecamp-crm.codemao.cn/*"});
  if(!tabs.length)return {ok:false,error:"请先在当前浏览器打开并登录CRM后台；控制台不会另开页面。"};
  const tab=tabs.find(x=>x.active&&!x.discarded)||tabs.find(x=>!x.discarded)||tabs[0];
  try{
    await waitForTabReady(tab.id);
    // Run API calls in the extension service worker. Host permissions allow
    // authenticated CRM requests without depending on page-frame lifetime or
    // page CORS, which previously caused intermittent `Failed to fetch`.
    const data=await Promise.race([
      collectCrmData(classes,excludedTeachers,(message,detail)=>postLocalStatus("running",message,detail,"crm",localBase),fetchComparisonLiveRooms),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error("CRM_TOTAL_TIMEOUT")),5*60*1000)),
    ]);
    return {ok:true,data};
  }catch(error){
    const text=String(error?.message||error);
    const frameChanged=/Frame with ID \d+ was removed|No frame with id|frame was detached|Cannot find context with specified id|The tab was closed|tab was discarded/i.test(text);
    const networkFailed=/Failed to fetch|NetworkError|ERR_|CRM_REQUEST_FAILED/i.test(text);
    if((frameChanged||networkFailed)&&reconnectAttempt<1){
      const attempt=reconnectAttempt+1;
      const reason=frameChanged?"CRM页面状态发生变化":"CRM接口连接中断";
      await appendRunLog(`${reason}，自动重试`,`第 ${attempt}/1 次：${text}`,localBase);
      await postLocalStatus("running",`${reason}，正在自动恢复…`,`后台连接重试 ${attempt}/1；无需刷新CRM页面`,"crm",localBase);
      await new Promise(resolve=>setTimeout(resolve,1200*attempt));
      return fetchInCrm(classes,excludedTeachers,attempt,localBase);
    }
    const message=text.includes("CRM_LOGIN_EXPIRED")?"当前Chrome的CRM登录已失效，请重新登录后重试。":text.includes("CRM_TOTAL_TIMEOUT")||text.includes("aborted")?"CRM读取超过4分钟，已自动终止；系统将在15分钟后自动重试。":`CRM读取失败：${text}`;
    return {ok:false,error:message};
  }
}

const RENEWAL_COLUMN_NAMES={
  renew_month:"续费月份",user_id:"用户ID",user_name:"用户姓名",class_id:"分班池班级ID",worker_no:"老师工号",teacher_name:"老师姓名",
  level_5_department_name:"战区",level_6_department_name:"战队",level_7_department_name:"组",term_name:"课期名称",target_package_name:"续费前课包名称",
  package_name:"续费课包名称/商品名称",renew_state:"续费节点",is_target_user:"是否续费分母",is_current_in_class:"续费月份是否在读",
  is_exam:"是否参加期中考试",exam_score:"考试得分",is_questionnaire:"是否填写问卷",is_reserve:"是否预约直播",is_watch:"是否观看直播",
  is_visit:"是否进入页面",is_click_agree:"是否点击预约学位按钮",is_plan:"是否预约学位",is_agree:"是否认可规划",intention_type:"预约学位情况",
  is_page_click:"是否点击全款预约链接",is_page_reserve:"是否点击全款预约",is_page_apply:"是否点击进入报名",is_deposit:"是否支付订金",
  is_final:"是否支付尾款",is_total:"是否支付全款",is_renew:"是否续费",stratification_date:"分层日期",user_segmentation_label:"用户分层标签",
  student_ability_label:"学员能力标签",student_willing_label:"学员意愿标签",parent_will_label:"家长意愿标签",grade:"年级",cpp_user_label:"学员标签",
};

async function fetchRenewalInCurrentChrome(renewalMonth){
  const selectedMonth=String(renewalMonth||"");
  if(!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(selectedMonth))return {ok:false,error:"请选择有效的续费月份，不会自动改用其他月份。"};
  const tabs=await chrome.tabs.query({url:"https://bigdata-superset.codemao.cn/*"});
  if(!tabs.length)return {ok:false,error:"请先在当前谷歌浏览器打开并登录续费CRM后台；控制台不会启动新浏览器或新页面。"};
  const tab=tabs.find(x=>x.active&&!x.discarded)||tabs.find(x=>!x.discarded)||tabs[0];
  try{
    await waitForTabReady(tab.id);
    const results=await chrome.scripting.executeScript({
      target:{tabId:tab.id},world:"MAIN",args:[RENEWAL_COLUMN_NAMES,selectedMonth],
      func:async(columnNames,selectedMonth)=>{
        if(!location.href.startsWith("https://bigdata-superset.codemao.cn/"))throw new Error("CRM_LOGIN_EXPIRED");
        const chartResponse=await fetch("/api/v1/chart/5014",{credentials:"include"});
        if(chartResponse.status===401||chartResponse.redirected)throw new Error("CRM_LOGIN_EXPIRED");
        if(!chartResponse.ok)throw new Error(`CRM_CHART_HTTP_${chartResponse.status}`);
        const chart=await chartResponse.json();
        const query=JSON.parse(chart.result.query_context);
        const selectedFilters=[
          {col:"renew_month",op:"IN",val:[selectedMonth]},
          {col:"renew_state",op:"IN",val:["首续"]},
          {col:"level_6_department_name",op:"IN",val:["深圳战区"]},
        ];
        for(const item of query.queries||[]){
          item.filters=(item.filters||[]).filter(filter=>!["renew_month","renew_state","level_6_department_name"].includes(filter.col)||filter.op==="TEMPORAL_RANGE");
          item.filters.push(...selectedFilters);item.row_limit=200000;item.row_offset=0;
        }
        query.force=true;query.form_data=query.form_data||{};
        query.form_data.extra_form_data={...(query.form_data.extra_form_data||{}),filters:selectedFilters};
        let csrf="";
        try{const tokenResponse=await fetch("/api/v1/security/csrf_token/",{credentials:"include"});if(tokenResponse.ok)csrf=(await tokenResponse.json()).result||"";}catch{}
        const headers={"content-type":"application/json"};if(csrf)headers["x-csrftoken"]=csrf;
        const response=await fetch("/api/v1/chart/data",{method:"POST",credentials:"include",headers,body:JSON.stringify(query)});
        if(response.status===401||response.redirected)throw new Error("CRM_LOGIN_EXPIRED");
        if(!response.ok)throw new Error(`CRM_DATA_HTTP_${response.status}`);
        const payload=await response.json();
        const raw=payload.result?.find(item=>Array.isArray(item.data))||payload.result?.[0];
        if(!raw||!Array.isArray(raw.data))throw new Error("CRM_CHART_RESULT_INVALID");
        const clean=value=>String(value??"").replace(/\s+/g," ").trim();
        const physical=(raw.colnames||Object.keys(raw.data[0]||{})).map(clean),verbose=raw.verbose_map||{};
        const display=physical.map(column=>clean(columnNames[column]||verbose[column]||column));
        const rows=raw.data.map(row=>Object.fromEntries(physical.map((column,index)=>[display[index],row[column]??row[display[index]]??""])));
        const rowcount=Number(raw.rowcount??rows.length);
        if(rowcount>rows.length)throw new Error(`CRM_DATA_TRUNCATED:${rows.length}/${rowcount}`);
        return JSON.stringify({headers:display,rows,rowcount,renewalMonth:selectedMonth});
      }
    });
    const data=results[0]?.result;
    if(!data)return {ok:false,error:"当前谷歌浏览器中的CRM页面没有返回续费数据。"};
    return {ok:true,data,tabId:tab.id,renewalMonth:selectedMonth};
  }catch(error){
    const text=String(error?.message||error);
    return {ok:false,error:text.includes("CRM_LOGIN_EXPIRED")?"当前谷歌浏览器的CRM登录已失效，请在原页面登录后重试。":`续费CRM读取失败：${text}`};
  }
}

async function fetchNctInCurrentChrome(filters={}){
  const startDate=String(filters.startDate||""),endDate=String(filters.endDate||""),orderStatus=String(filters.orderStatus||"已完成"),productName=String(filters.productName||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(endDate)||startDate>endDate)return {ok:false,error:"NCT支付时间范围无效。"};
  if(!productName)return {ok:false,error:"NCT商品名称不能为空。"};
  const tabs=await chrome.tabs.query({url:"https://codecamp-crm.codemao.cn/*"});
  if(!tabs.length)return {ok:false,error:"请先在当前谷歌浏览器打开并登录CRM订单列表。"};
  const tab=tabs.find(x=>x.active&&!x.discarded)||tabs.find(x=>!x.discarded)||tabs[0];
  try{
    await waitForTabReady(tab.id);
    const base="https://codecamp-marketing.codemao.cn",headers={"content-type":"application/json","systemType":"1"};
    const request=async(path,body)=>{const response=await fetchWithTimeout(base+path,{method:"POST",credentials:"include",headers,body:JSON.stringify(body)},30000);if(response.status===401||response.status===403||response.redirected)throw new Error("CRM_LOGIN_EXPIRED");if(!response.ok)throw new Error(`NCT_CRM_HTTP_${response.status}:${path}`);const payload=await response.json();if(payload?.success===false||Number(payload?.code||200)!==200)throw new Error(`NCT_CRM_API:${payload?.msg||payload?.message||path}`);return payload};
    const nestedArrays=value=>{const found=[];const visit=(item,depth=0)=>{if(depth>4||item==null)return;if(Array.isArray(item)){found.push(item);for(const child of item)if(child&&typeof child==="object"&&!Array.isArray(child))visit(child,depth+1);return}if(typeof item==="object")for(const child of Object.values(item))visit(child,depth+1)};visit(value);return found};
    const parameterPayload=await request("/system/params",["bk_unified_order_status"]);
    const statusOption=nestedArrays(parameterPayload).flat().find(item=>{const name=item?.name??item?.label??item?.paramName??item?.param_name??item?.text;return String(name||"").trim()===orderStatus});
    const statusValue=statusOption?.value??statusOption?.paramValue??statusOption?.param_value??statusOption?.code??statusOption?.id;
    if(orderStatus!=="全部"&&(statusValue===undefined||statusValue===null||statusValue===""))throw new Error(`NCT_ORDER_STATUS_NOT_FOUND:${orderStatus}`);
    let businessLineLookup={};
    try{
      const businessPayload=await request("/system/params",["lbk_distribution_business_line"]);
      for(const item of nestedArrays(businessPayload).flat()){
        const value=item?.value??item?.paramValue??item?.param_value??item?.code??item?.id;
        const name=item?.name??item?.label??item?.paramName??item?.param_name??item?.text;
        if(value!==undefined&&value!==null&&String(name||"").trim())businessLineLookup[String(value)]=String(name).trim();
      }
    }catch{}
    const localEpoch=(date,end=false)=>Math.floor(new Date(`${date}T${end?"23:59:59":"00:00:00"}+08:00`).getTime()/1000).toString();
    const pageSize=200,query={page:1,limit:pageSize,paidAtFrom:localEpoch(startDate),paidAtTo:localEpoch(endDate,true),spuName:productName};
    if(orderStatus!=="全部")query.orderStatuss=[statusValue];
    const objectRows=payload=>nestedArrays(payload).filter(rows=>rows.length&&rows.every(row=>row&&typeof row==="object"&&!Array.isArray(row))).sort((a,b)=>b.length-a.length)[0]||[];
    const listPayload=await request("/unified-order/list",query);
    const totalCandidates=[listPayload?.data?.total,listPayload?.data?.count,listPayload?.result?.total,listPayload?.result?.count,listPayload?.total,listPayload?.count].map(Number).filter(Number.isFinite);
    const total=totalCandidates[0]||0;
    let rows=objectRows(listPayload);
    if(!rows.length)throw new Error("NCT_CRM_SOURCE_EMPTY");
    const expected=total||rows.length,maxPages=Math.max(1,Math.ceil(expected/pageSize));
    for(let page=2;page<=maxPages;page++){
      const pageRows=objectRows(await request("/unified-order/list",{...query,page}));
      if(!pageRows.length)break;
      rows.push(...pageRows);
    }
    const serverRows=rows.length;
    if(total&&serverRows!==total)throw new Error(`NCT_CRM_DATA_TRUNCATED:${serverRows}/${total}`);
    rows=rows.filter(row=>(orderStatus==="全部"||String(row.orderStatusStr||"").trim()===orderStatus)&&String(row.spuName||"").trim()===productName);
    if(rows.some(row=>row.orderId!==undefined))rows=[...new Map(rows.map((row,index)=>[String(row.orderId??`row-${index}`),row])).values()];
    if(!rows.length)throw new Error("NCT_CRM_SOURCE_EMPTY");
    const columns=[...new Set(rows.flatMap(row=>Object.keys(row||{})))];
    const data=JSON.stringify({headers:columns,rows,rowcount:rows.length,serverTotal:total||serverRows,serverRows,lookups:{businessLine:businessLineLookup},fetchedAt:new Date().toISOString(),filters:{startDate,endDate,orderStatus,productName}});
    return {ok:true,data,tabId:tab.id,filters};
  }catch(error){const text=String(error?.message||error);return {ok:false,error:text.includes("CRM_LOGIN_EXPIRED")?"当前谷歌浏览器的CRM登录已失效，请在订单列表页重新登录后重试。":`NCT年卡CRM读取失败：${text}`};}
}

function normalizeServiceSelection(value={}){
  const days=Array.isArray(value.days)?[...new Set(value.days.map(Number).filter(day=>Number.isInteger(day)&&day>=0&&day<=6))]:[];
  const dates=Array.isArray(value.dates)?[...new Set(value.dates.map(date=>String(date||"").trim()).filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)))].sort():[];
  const startHour=Number(value.startHour),endHour=Number(value.endHour),safeStart=Number.isInteger(startHour)&&startHour>=0&&startHour<=23?startHour:14,safeEnd=Number.isInteger(endHour)&&endHour>=safeStart&&endHour<=23?endHour:Math.max(safeStart,21);
  return {days:days.length?days:[5,6,0],dates,dateSource:dates.length?String(value.dateSource||"explicitDates"):"weekdaySelection",openedWeek:String(value.openedWeek||""),startHour:safeStart,endHour:safeEnd,hours:Array.from({length:safeEnd-safeStart+1},(_,index)=>String(safeStart+index).padStart(2,"0"))};
}

function serviceSelectedDates(selection){
  if(Array.isArray(selection.dates)&&selection.dates.length)return selection.dates;
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));
  const today=new Date(now);today.setHours(0,0,0,0);
  const weekday=(today.getDay()+6)%7,monday=new Date(today);monday.setDate(today.getDate()-weekday);
  const dates=[];
  const format=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const offsets=selection.days.map(day=>(day+6)%7).sort((a,b)=>a-b);
  for(const offset of offsets){
    const date=new Date(monday);date.setDate(monday.getDate()+offset);
    if(date<today||(date.getTime()===today.getTime()&&now.getHours()>=selection.startHour))dates.push(format(date));
  }
  // If this week's selected window has not started, use the latest complete one.
  if(!dates.length)for(const offset of offsets){const date=new Date(monday);date.setDate(monday.getDate()+offset-7);dates.push(format(date));}
  return dates;
}

function serviceTodayDate(selection){
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));
  // Daily call rankings are independent of the multi-day weekday selection.
  // Before the configured working window starts, keep the value unavailable
  // instead of reporting a misleading zero.
  if(now.getHours()<selection.startHour)return "";
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

async function fetchServiceInCurrentChrome(requestedSelection){
  const tabs=await chrome.tabs.query({url:"https://bigdata-superset.codemao.cn/*"});
  if(!tabs.length)return {ok:false,error:"请先在当前谷歌浏览器打开并登录 Superset CRM；控制台不会另开页面。"};
  const tab=tabs.find(x=>x.active&&!x.discarded)||tabs.find(x=>!x.discarded)||tabs[0];
  const serviceSelection=normalizeServiceSelection(requestedSelection),dates=serviceSelectedDates(serviceSelection),todayDate=serviceTodayDate(serviceSelection);
  try{
    await waitForTabReady(tab.id);
    const results=await Promise.race([chrome.scripting.executeScript({
      target:{tabId:tab.id},world:"MAIN",args:[dates,todayDate,serviceSelection],
      func:async(dates,todayDate,serviceSelection)=>{try{
        const normalize=value=>String(value??"").replace(/\s+/g," ").trim();
        const api=async(url,options={})=>{
          let lastError;
          for(let attempt=1;attempt<=2;attempt++){
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
            try{const response=await fetch(url,{credentials:"include",...options,signal:controller.signal});if(response.status===401||response.redirected)throw new Error("CRM_LOGIN_EXPIRED");if(!response.ok)throw new Error(`CRM_HTTP_${response.status}:${url}`);return await response.json();}
            catch(error){lastError=error;if(String(error?.message||error).includes("CRM_LOGIN_EXPIRED"))throw error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,700));}
            finally{clearTimeout(timer);}
          }
          throw new Error(`CRM_SERVICE_REQUEST_FAILED:${url}:${String(lastError?.message||lastError)}`);
        };
        const csrfResponse=await api("/api/v1/security/csrf_token/").catch(()=>({result:""}));
        const csrf=csrfResponse.result||"";
        const fetchDashboard=async(id,kind)=>{
          const [dashboard,chartsPayload]=await Promise.all([api(`/api/v1/dashboard/${id}`),api(`/api/v1/dashboard/${id}/charts`)]);
          // Definitions are shared only within this collection; business queries remain fresh.
          const chartDefinitions=new Map();
          const chartDefinition=chart=>{const chartId=chart.id||chart.slice_id;if(!chartDefinitions.has(chartId)){const request=api(`/api/v1/chart/${chartId}`).catch(error=>{chartDefinitions.delete(chartId);throw error;});chartDefinitions.set(chartId,request);}return chartDefinitions.get(chartId);};
          const result=dashboard.result||dashboard;
          let metadata={};try{metadata=JSON.parse(result.json_metadata||"{}");}catch{}
          const nativeFilters=metadata.native_filter_configuration||[];
          const filterColumn=keywords=>{const filter=nativeFilters.find(item=>keywords.some(word=>normalize(item.name).includes(word)));return filter?.targets?.[0]?.column?.name||filter?.target?.column?.name||"";};
          const columns={
            date:filterColumn(["具体发送日期","具体统计日期"]),zone:filterColumn(["战区"]),team:filterColumn(["团队"]),group:filterColumn(["小组"]),department:filterColumn(["部门"]),timeType:filterColumn(["时间类型"]),hour:filterColumn(["小时","时间区间","发送时间"]),
          };
          const charts=chartsPayload.result||chartsPayload.charts||chartsPayload||[];
          const pick=async dimension=>{
            const named=charts.filter(chart=>{const name=normalize(chart.slice_name||chart.chart_name||chart.name);const dimensionMatch=dimension==="老师"?((name.includes("老师")||name.includes("教师"))&&!name.includes("团队")&&!name.includes("小组")&&!name.includes("战区")&&!name.includes("用户")):(name.includes("-小组")||name.includes("小组数据"));return dimensionMatch&&!name.includes("趋势");}).sort((a,b)=>{const nameA=normalize(a.slice_name||a.chart_name||a.name),nameB=normalize(b.slice_name||b.chart_name||b.name),preferred=name=>Number(!(dimension==="老师"?name==="老师数据":name.includes("小组数据（聚合）")));return preferred(nameA)-preferred(nameB)||Number(nameA.includes("明细"))-Number(nameB.includes("明细"));});
            // The verified dashboards expose stable, descriptive chart names.
            // Use those candidates directly; scanning every chart definition
            // multiplied Superset requests and could leave the UI waiting.
            if(named.length||dimension!=="老师")return named;
            const structural=[];
            for(const chart of charts){
              const name=normalize(chart.slice_name||chart.chart_name||chart.name);if(name.includes("趋势")||name.includes("团队")||name.includes("小组")||name.includes("战区")||name.includes("用户")||(kind==="im"&&name.includes("明细")))continue;
              try{const detail=await chartDefinition(chart),queryText=normalize((detail.result||detail).query_context||"");if((queryText.includes("worker_no")||queryText.includes("beisen_user_fullname"))&&(kind!=="wecom"||queryText.includes("avg_2hour_reply_rate"))&&(kind!=="im"||queryText.includes("pre_teacher_3m_reply_cnt")))structural.push(chart);}catch{}
            }
            return [...structural,...named.filter(chart=>!structural.some(item=>(item.id||item.slice_id)===(chart.id||chart.slice_id)))];
          };
          const runChart=async(chart,dimension,filterDates,allowEmpty=false)=>{
            const detail=await chartDefinition(chart),chartResult=detail.result||detail;
            const queryTemplate=JSON.parse(chartResult.query_context||"{}");
            const dateColumn=columns.date||(queryTemplate.queries||[]).flatMap(query=>query.filters||[]).map(filter=>filter.col).find(column=>["send_date","statistic_date","statistics_date","stat_date"].includes(column));
            if(!dateColumn)throw new Error(`CRM_SERVICE_DATE_COLUMN_MISSING:${id}:${dimension}`);
            const baseDesired=[];
            const add=(column,value)=>{if(column&&value!=null&&(!Array.isArray(value)||value.length))baseDesired.push({col:column,op:"IN",val:Array.isArray(value)?value:[value]});};
            add(dateColumn,filterDates);add(columns.zone,"AI C++教学部");
            if(kind==="wecom")add(columns.team,"深圳战区");else add(columns.department,["探月教学中心","深空教学中心"]);
            if(dimension==="老师")add(columns.group,"屹柯组");
            const serviceHours=serviceSelection.hours;
            const headers={"content-type":"application/json"};if(csrf)headers["x-csrftoken"]=csrf;
            const execute=async extraFilters=>{const sortedDates=[...filterDates].sort(),end=new Date(`${sortedDates.at(-1)}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+1);const timeRange=`${sortedDates[0]}T00:00:00 : ${end.toISOString().slice(0,10)}T00:00:00`;const desired=[...baseDesired,...extraFilters],query=JSON.parse(JSON.stringify(queryTemplate)),targetColumns=new Set(desired.map(x=>x.col));for(const item of query.queries||[]){item.filters=(item.filters||[]).filter(filter=>!targetColumns.has(filter.col));item.filters.push(...desired);item.time_range=timeRange;item.row_limit=200000;item.row_offset=0;}query.force=true;query.form_data=query.form_data||{};query.form_data.time_range=timeRange;query.form_data.extra_form_data={...(query.form_data.extra_form_data||{}),filters:desired,time_range:timeRange};const payload=await api("/api/v1/chart/data",{method:"POST",headers,body:JSON.stringify(query)});return payload.result?.find(item=>Array.isArray(item.data))||payload.result?.[0];};
            let raw;
            if(kind==="wecom"&&!columns.hour&&columns.timeType){
              const variants=[["工作时间"],["工作时段"],serviceHours,serviceHours.map(x=>`${x}时`),serviceHours.map(x=>`${x}点`),serviceHours.map(x=>`${x}:00`),serviceHours.map(x=>`${x}:00-${x}:59`),serviceHours.map(x=>Number(x))];
              for(const values of variants){const candidate=await execute([{col:columns.timeType,op:"IN",val:values}]);if(candidate?.data?.length){raw=candidate;break;}}
              if(!raw){
                // Superset occasionally changes the display values of the
                // work_time_type filter. Keep the valid summary returned by
                // the chart instead of failing the whole combined update.
                const diagnostic=await execute([]),keys=(diagnostic?.colnames||Object.keys(diagnostic?.data?.[0]||{})).map(normalize);
                if(diagnostic?.data?.length)raw=diagnostic;
                else throw new Error(`CRM_SERVICE_HOUR_VALUES_NOT_MATCHED:${id}:${dimension}:timeColumn=${columns.timeType}:unfiltered=${keys.join("|")}`);
              }
            }else{
              const extra=[];if(kind==="wecom"&&columns.timeType)extra.push({col:columns.timeType,op:"IN",val:["总计"]});if(columns.hour)extra.push({col:columns.hour,op:"IN",val:serviceHours});raw=await execute(extra);
            }
            if(!raw||!Array.isArray(raw.data))throw new Error(`CRM_SERVICE_TABLE_INVALID:${id}:${dimension}`);
            if(raw.rowcount!=null&&Number(raw.rowcount)>raw.data.length)throw new Error(`CRM_SERVICE_ROWS_TRUNCATED:${id}:${dimension}:${raw.data.length}/${raw.rowcount}`);
            if(!raw.data.length&&allowEmpty)return {chartId:chart.id||chart.slice_id,rows:[],headers:[],granular:false,aggregation:"summary-chart",empty:true};
            if(!raw.data.length)throw new Error(`CRM_SERVICE_NO_ROWS:${id}:${dimension}:dates=${filterDates.join(",")}`);
            const verbose=raw.verbose_map||{},rawColumns=raw.colnames||Object.keys(raw.data[0]||{}),physical=rawColumns.map(normalize);
            // Superset has returned verbose_map in both directions over time
            // (physical -> display name and display name -> physical).  Resolve
            // both forms and never assume normalized column text is the exact
            // property key used by a data row.
            const verboseEntries=Object.entries(verbose),columnTokens=column=>{
              const normalized=normalize(column),tokens=[normalized,normalize(verbose[column])];
              for(const [left,right] of verboseEntries){if(normalize(left)===normalized)tokens.push(normalize(right));if(normalize(right)===normalized)tokens.push(normalize(left));}
              return [...new Set(tokens.filter(Boolean))];
            };
            const label=column=>columnTokens(column).join(" "),read=(row,column)=>{if(!column)return undefined;if(Object.prototype.hasOwnProperty.call(row,column))return row[column];const rawKey=Object.keys(row).find(key=>normalize(key)===normalize(column));return rawKey?row[rawKey]:undefined;};
            const findColumn=(aliases,exclude=[])=>{const wantedAliases=aliases.map(alias=>alias.toLowerCase()),blocked=column=>exclude.some(alias=>label(column).toLowerCase().includes(alias.toLowerCase())),exact=physical.find(column=>!blocked(column)&&columnTokens(column).some(token=>wantedAliases.includes(token.toLowerCase())));return exact||physical.find(column=>{const value=label(column).toLowerCase();return wantedAliases.some(alias=>value.includes(alias))&&!blocked(column);})||"";};
            const workerColumn=findColumn(["worker_no","老师工号"]),teacherColumn=findColumn(["beisen_user_fullname","老师姓名","老师"],["工号"]),groupColumn=findColumn(["level_7_department_name","小组"]);
            const wanted=kind==="im"
              ? ["worker_no","beisen_user_fullname","level_7_department_name","send_date","msg_send_hour","pre_teacher_3m_reply_cnt"]
              : ["worker_no","beisen_user_fullname","level_7_department_name","statistics_date","stat_date","avg_2hour_reply_rate"];
            const metricColumn=findColumn(kind==="im"?["pre_teacher_3m_reply_cnt","3分钟回复率"]:["avg_2hour_reply_rate","2小时回复率","2h回复率"]);
            if(!metricColumn)throw new Error(`CRM_SERVICE_METRIC_NOT_FOUND:${id}:${dimension}:${physical.map(column=>`${column}=${label(column)}`).join("|")}`);
            if(dimension==="老师"&&!workerColumn&&!teacherColumn)throw new Error(`CRM_SERVICE_TEACHER_COLUMNS_NOT_FOUND:${id}:${physical.map(column=>`${column}=${label(column)}`).join("|")}`);
            if(dimension==="小组"&&!groupColumn)throw new Error(`CRM_SERVICE_GROUP_COLUMN_NOT_FOUND:${id}:${physical.map(column=>`${column}=${label(column)}`).join("|")}`);
            const selected=physical.filter(column=>wanted.includes(column));
            const resultHeaders=selected.length?selected:physical;
            const percent=value=>{const text=normalize(value);if(!text)return null;const number=Number(text.replace("%",""));if(!Number.isFinite(number))return null;return text.includes("%")?number:(Math.abs(number)<=1?number*100:number);};
            const number=value=>{if(value==null||normalize(value)==="")return null;const parsed=Number(normalize(value).replace(/,/g,""));return Number.isFinite(parsed)?parsed:null;};
            const countColumns=kind==="im"?{
              imQuestions:findColumn(["sum_user_msg_cnt","学生消息数","im_question_count"]),imAnswered:findColumn(["sum_teacher_3m_reply_cnt","3分钟消息回复数","3分钟内回复数","im_answered_3m_count"]),imUsers:findColumn(["im_user_cnt","发送信息学员人数","im_user_count"]),imEligible:findColumn(["arrive_im_user_cnt","有IM且到课学员量","有im且到课学员量","im_eligible_student_count"]),imUsage:findColumn(["im_used_rate","学生IM使用率","im_usage_rate"]),
              callUsers:findColumn(["call_success_cnt","语音通话人数","通话人数","callUsers"],["video","视频"]),callCoverage:findColumn(["call_success_cover_rate","语音通话覆盖率","通话覆盖率","callCoverage"],["video","视频"]),voiceDialCount:findColumn(["sum_call_cnt","语音通话拨打次数","语音拨打次数","voiceDialCount"]),voiceConnectedCount:findColumn(["语音通话接通次数","语音接通次数","voiceConnectedCount"]),voiceCallRate:findColumn(["call_rate","语音通话率","voiceCallRate"],["success","used","接通","使用"]),voiceConnectRate:findColumn(["call_success_rate","语音通话接通率","语音接通率","voiceConnectRate"]),voiceUsageRate:findColumn(["call_used_rate","all_used_call_rate","语音通话使用率","voiceUsageRate"]),
              videoCallUsers:findColumn(["video_succuess_cnt","video_success_cnt","视频通话人数","videoCallUsers"]),videoCallCoverage:findColumn(["video_succuess_cover_rate","video_success_cover_rate","视频通话覆盖率","videoCallCoverage"]),videoDialCount:findColumn(["sum_video_call_cnt","视频通话拨打次数","视频拨打次数","videoDialCount"]),videoConnectedCount:findColumn(["视频通话接通次数","视频接通次数","videoConnectedCount"]),videoCallRate:findColumn(["video_call_rate","视频通话率","videoCallRate"],["success","user","接通","使用","覆盖"]),videoConnectRate:findColumn(["video_call_success_rate","视频通话接通率","视频接通率","videoConnectRate"]),videoUsageRate:findColumn(["video_call_user_rate","视频通话使用率","videoUsageRate"]),videoAverageMinutes:findColumn(["avg_video_call_success_dur","视频平均通话时长","videoAverageMinutes"])
            }:{wecomAnswered:findColumn(["2小时内回答人数","两小时内回答人数","2小时消息回复数","2h消息回复数","wecom_answered_2h_count","回答人数"]),wecomQuestions:findColumn(["user_uncontiue_msg_cnt_sum","用户提问消息数","提问消息数","提问人数","咨询人数","wecom_question_count"])};
            if(kind==="im"&&(!countColumns.voiceDialCount||!countColumns.videoDialCount))throw new Error(`CRM_SERVICE_CALL_COLUMNS_MISSING:${dimension}`);
            const grouped=new Map();
            for(const sourceRow of raw.data){
              const rowDate=read(sourceRow,dateColumn);
              if(rowDate!=null&&!filterDates.includes(String(rowDate).slice(0,10)))throw new Error(`CRM_SERVICE_DATE_MISMATCH:${id}:${dimension}:${rowDate}`);
              const name=normalize(read(sourceRow,teacherColumn)),worker=normalize(read(sourceRow,workerColumn)),group=normalize(read(sourceRow,groupColumn));
              const key=dimension==="老师"?(worker||name):group,value=percent(read(sourceRow,metricColumn));
              if(!key||(value==null&&kind!=="im"))continue;
              if(!grouped.has(key))grouped.set(key,{worker_no:worker,beisen_user_fullname:name,level_7_department_name:group,rates:[],counts:{},percentages:{}});
              const item=grouped.get(key);if(value!=null)item.rates.push(value);
              for(const [field,column] of Object.entries(countColumns)){if(!column)continue;const isRate=field.endsWith("Rate")||field.endsWith("Coverage")||field==="imUsage";if(isRate){const parsed=percent(read(sourceRow,column));if(parsed!=null)(item.percentages[field]??=[]).push(parsed);}else{const parsed=number(read(sourceRow,column));if(parsed!=null)item.counts[field]=(item.counts[field]||0)+parsed;}}
              // Recover missing connected counts within each source row. Averaging
              // hourly rates before applying them to total attempts changes counts.
              if(kind==="im")for(const type of ["voice","video"]){
                const countField=`${type}ConnectedCount`,dialField=`${type}DialCount`,rateField=`${type}ConnectRate`;
                if(number(read(sourceRow,countColumns[countField]))!=null)continue;
                const dial=number(read(sourceRow,countColumns[dialField])),rate=percent(read(sourceRow,countColumns[rateField]));
                if(dial===0)item.counts[countField]=item.counts[countField]||0;
                else if(dial!=null&&rate!=null&&rate>=0&&rate<=100)item.counts[countField]=(item.counts[countField]||0)+Math.round(dial*rate/100);
                else throw new Error(`CRM_SERVICE_CALL_VALUE_MISSING:${worker||name}:${dialField}`);
              }
              if(kind==="wecom"&&!countColumns.wecomAnswered&&value!=null&&countColumns.wecomQuestions){const questions=number(read(sourceRow,countColumns.wecomQuestions));if(questions!=null)item.counts.wecomAnswered=(item.counts.wecomAnswered||0)+Math.round(questions*value/100);}
            }
            const rows=[...grouped.values()].map(item=>{
              const base={worker_no:item.worker_no,beisen_user_fullname:item.beisen_user_fullname,level_7_department_name:item.level_7_department_name,[kind==="im"?"pre_teacher_3m_reply_cnt":"avg_2hour_reply_rate"]:item.rates.length?`${item.rates.reduce((sum,x)=>sum+x,0)/item.rates.length}%`:null};
              if(kind==="im"){const c=item.counts,p=item.percentages;base.im_question_count=c.imQuestions??null;base.im_answered_3m_count=c.imAnswered??null;base.im_user_count=c.imUsers??null;base.im_eligible_student_count=c.imEligible??null;base.im_usage_rate=c.imEligible?c.imUsers/c.imEligible*100:(p.imUsage?.[0]??null);for(const field of ["callUsers","voiceDialCount","voiceConnectedCount","videoCallUsers","videoDialCount","videoConnectedCount"]){if(c[field]!=null)base[field]=c[field];}for(const field of ["callCoverage","voiceCallRate","voiceConnectRate","voiceUsageRate","videoCallCoverage","videoCallRate","videoConnectRate","videoUsageRate","videoAverageMinutes"]){if(p[field]?.length)base[field]=p[field].reduce((sum,x)=>sum+x,0)/p[field].length;}if(base.voiceConnectedCount==null&&base.voiceDialCount!=null&&base.voiceConnectRate!=null)base.voiceConnectedCount=Math.round(base.voiceDialCount*base.voiceConnectRate/100);if(base.videoConnectedCount==null&&base.videoDialCount!=null&&base.videoConnectRate!=null)base.videoConnectedCount=Math.round(base.videoDialCount*base.videoConnectRate/100);}
              else{const c=item.counts;base.wecom_answered_2h_count=c.wecomAnswered??null;base.wecom_question_count=c.wecomQuestions??null;}
              return base;
            });
            if(!rows.length)throw new Error(`CRM_SERVICE_EMPTY_AFTER_FILTERS:${id}:${dimension}:${chart.slice_name||chart.chart_name||""}`);
            if(kind==="im")for(const row of rows)for(const type of ["voice","video"]){const dial=row[`${type}DialCount`],connected=row[`${type}ConnectedCount`];if(dial>0&&connected!=null)row[`${type}ConnectRate`]=connected/dial*100;}
            const countHeaders=kind==="im"?["pre_teacher_3m_reply_cnt","im_answered_3m_count","im_question_count","im_user_count","im_eligible_student_count","im_usage_rate","callUsers","callCoverage","voiceDialCount","voiceConnectedCount","voiceCallRate","voiceConnectRate","voiceUsageRate","videoCallUsers","videoCallCoverage","videoDialCount","videoConnectedCount","videoCallRate","videoConnectRate","videoUsageRate","videoAverageMinutes"]:["avg_2hour_reply_rate","wecom_answered_2h_count","wecom_question_count"];
            return {chartId:chart.id||chart.slice_id,chartName:chart.slice_name||chart.chart_name||"",headers:[...resultHeaders,...countHeaders],rows,rowcount:Number(raw.rowcount??rows.length),filterColumns:columns,resolvedColumns:{workerColumn,teacherColumn,groupColumn,metricColumn,...countColumns},availableColumns:physical.map(column=>({column,label:label(column)})),countsDerived:kind==="wecom"&&!countColumns.wecomAnswered,granular:false,aggregation:"summary-chart",callDiagnostics:kind==="im"?{dates:filterDates,hours:columns.hour?serviceHours:null,sourceRows:raw.data.length,queryFilters:(queryTemplate.queries||[]).map(q=>({filters:q.filters,extras:q.extras,metrics:q.metrics,columns:q.columns,groupby:q.groupby})),rawRows:raw.data.map(row=>({worker:read(row,workerColumn),teacher:read(row,teacherColumn),group:read(row,groupColumn),date:read(row,dateColumn),hour:read(row,columns.hour),...Object.fromEntries(Object.entries(countColumns).filter(([field])=>field.includes("Call")||field.includes("Dial")||field.includes("Connected")||field.includes("Connect")||field==="callUsers").map(([field,column])=>[field,read(row,column)]))})),teachers:rows.map(row=>({worker_no:row.worker_no,beisen_user_fullname:row.beisen_user_fullname,voiceDialCount:row.voiceDialCount,voiceConnectedCount:row.voiceConnectedCount,videoDialCount:row.videoDialCount,videoConnectedCount:row.videoConnectedCount,callUsers:row.callUsers,videoCallUsers:row.videoCallUsers}))}:undefined};
          };
          const fetchDimension=async(dimension,filterDates)=>{const candidates=await pick(dimension),attempts=[];for(const chart of candidates){try{const table=await runChart(chart,dimension,filterDates);if(table.rows.length){
              if(kind==="im"&&dimension==="老师"){
                // Compare independent CRM teacher-summary and hourly-detail queries.
                // The teacher-summary chart is the one displayed in dashboard 382.
                const summary=Number(table.chartId)===2458?table:await runChart({id:2458,slice_name:"老师数据"},dimension,filterDates);
                const detail=Number(table.chartId)===2458?await runChart({id:3114,slice_name:"老师数据-明细"},dimension,filterDates):table;
                const callFields=["voiceDialCount","voiceConnectedCount","videoDialCount","videoConnectedCount"],byId=new Map(summary.rows.map(row=>[row.worker_no||row.beisen_user_fullname,row]));
                const mismatches=[];
                for(const row of detail.rows){const key=row.worker_no||row.beisen_user_fullname,other=byId.get(key);if(!other){mismatches.push(`${key}:老师缺失`);continue;}for(const field of callFields)if(row[field]!==other[field])mismatches.push(`${key}:${field}:${row[field]}!=${other[field]}`);byId.delete(key);}
                for(const key of byId.keys())mismatches.push(`${key}:明细缺失`);
                if(mismatches.length)throw new Error(`CRM_SERVICE_CALL_RECONCILIATION_FAILED:${mismatches.join("|")}`);
                const callValidation={status:"matched",teacherCount:summary.rows.length,summaryChartId:2458,detailChartId:detail.chartId,fields:callFields,checkedAt:new Date().toISOString()};
                return {...summary,candidateAttempts:attempts,callValidation,detailCallDiagnostics:detail.callDiagnostics};
              }
              return {...table,candidateAttempts:attempts};
            }}catch(error){attempts.push(`${chart.id||chart.slice_id}:${normalize(chart.slice_name||chart.chart_name||chart.name)}=>${String(error?.message||error)}`);}}throw new Error(attempts.length?`CRM_SERVICE_CANDIDATES_FAILED:${id}:${dimension}:${attempts.join(" || ")}`:`CRM_SERVICE_CHART_NOT_FOUND:${id}:${dimension}`);};
          const fetchRange=async filterDates=>{const [teacher,group]=await Promise.all([fetchDimension("老师",filterDates),fetchDimension("小组",filterDates)]);return {teacher,group};};
          const fetchDaily=async date=>{
            const dimensions=["老师","小组"],keys=["teacher","group"];
            const results=await Promise.allSettled(dimensions.map(async dimension=>{
              try{return await fetchDimension(dimension,[date]);}
              catch(error){
                // Only two independently successful, empty IM teacher queries
                // may represent not-yet-available today data. Never fabricate zero.
                if(kind!=="im"||!String(error?.message||error).includes("CRM_SERVICE_NO_ROWS"))throw error;
                if(dimension==="小组"){
                  const candidates=await pick(dimension);
                  if(!candidates.length)throw error;
                  const tables=await Promise.all(candidates.map(chart=>runChart(chart,dimension,[date],true)));
                  if(tables.some(table=>!table.empty))return await fetchDimension(dimension,[date]);
                  return {...tables[0],availability:"pending",emptyValidation:{status:"empty-confirmed",chartIds:tables.map(table=>table.chartId),checkedAt:new Date().toISOString()}};
                }
                const [summary,detail]=await Promise.all([runChart({id:2458},dimension,[date],true),runChart({id:3114},dimension,[date],true)]);
                // A chart can finish refreshing between the first query and the
                // confirmation. Re-run reconciliation, never accept one side alone.
                if(!summary.empty||!detail.empty)return await fetchDimension(dimension,[date]);
                return {...summary,availability:"pending",callValidation:{status:"empty-confirmed",summaryChartId:2458,detailChartId:3114,checkedAt:new Date().toISOString()}};
              }
            }));
            const daily={errors:{}};
            results.forEach((result,index)=>{if(result.status==="fulfilled")daily[keys[index]]=result.value;else daily.errors[keys[index]]=String(result.reason?.message||result.reason);});
            return daily;
          };
          return {fetchRange,fetchDaily};
        };
        const [imDashboard,wecomDashboard]=await Promise.all([fetchDashboard(382,"im"),fetchDashboard(337,"wecom")]);
        const [im,wecom]=await Promise.all([imDashboard.fetchRange(dates),wecomDashboard.fetchRange(dates)]);
        let today=null;
        if(todayDate){
          const [todayIm,todayWecom]=await Promise.all([imDashboard.fetchDaily(todayDate),wecomDashboard.fetchDaily(todayDate)]);
          const errors={};for(const [kind,value] of [["im",todayIm],["wecom",todayWecom]])for(const [dimension,error] of Object.entries(value.errors))errors[`${kind}.${dimension}`]=error;
          today={dates:[todayDate],im:todayIm,wecom:todayWecom,errors,status:Object.keys(errors).length?"partial":"ok"};
        }
        return JSON.stringify({dates,im,wecom,today,serviceSelection});
      }catch(error){return JSON.stringify({__serviceError:String(error?.message||error)});}
      }
    }),new Promise((_,reject)=>setTimeout(()=>reject(new Error("CRM_SERVICE_TOTAL_TIMEOUT")),240000))]);
    const data=results[0]?.result;if(!data)return {ok:false,error:`当前 CRM 页面没有返回教学服务数据（诊断：tab=${tab.id}，results=${JSON.stringify(results)}）。`};
    try{const parsed=JSON.parse(data);if(parsed.__serviceError)return {ok:false,error:`CRM页面内读取失败：${parsed.__serviceError}`};}catch{}
    return {ok:true,data};
  }catch(error){const text=String(error?.message||error);return {ok:false,error:text.includes("CRM_LOGIN_EXPIRED")?"当前谷歌浏览器的 Superset 登录已失效，请在原页面登录后重试。":text.includes("CRM_SERVICE_TOTAL_TIMEOUT")?"教学服务CRM读取超过4分钟，已自动终止，请确认Superset页面正常后重试。":`教学服务数据读取失败：${text}`};}
}

function nextWeeklyTime(day,value){
  const [hour,minute]=String(value||"09:00").split(":").map(Number);
  const next=new Date();next.setHours(hour,minute,0,0);
  let add=(Number(day)-next.getDay()+7)%7;
  if(add===0&&next.getTime()<=Date.now())add=7;
  next.setDate(next.getDate()+add);
  return next.getTime();
}

function nextHalfHourTime(){
  const next=new Date();
  const minute=next.getMinutes()<30?30:60;
  next.setMinutes(minute,0,0);
  return next.getTime();
}

function nextHalfHourSlotKey(prefix,now=new Date()){
  const slot=new Date(now);
  slot.setMinutes(slot.getMinutes()<30?30:60,0,0);
  const date=`${slot.getFullYear()}-${String(slot.getMonth()+1).padStart(2,"0")}-${String(slot.getDate()).padStart(2,"0")}`;
  const hhmm=`${String(slot.getHours()).padStart(2,"0")}${String(slot.getMinutes()).padStart(2,"0")}`;
  return `${prefix}-half-hour-${slot.getDay()}-${hhmm}|${date}`;
}

function halfHourSlotKey(prefix,now=new Date()){
  const slot=new Date(now);
  slot.setMinutes(slot.getMinutes()<30?0:30,0,0);
  const date=`${slot.getFullYear()}-${String(slot.getMonth()+1).padStart(2,"0")}-${String(slot.getDate()).padStart(2,"0")}`;
  const hhmm=`${String(slot.getHours()).padStart(2,"0")}${String(slot.getMinutes()).padStart(2,"0")}`;
  return {key:`${prefix}-half-hour-${slot.getDay()}-${hhmm}|${date}`, slot};
}

async function rebuildScheduleAlarms(schedule,localBase=LOCAL_BASE){
  const prefix=instanceAlarmPrefix(localBase),watchdog=`${prefix}-watchdog`;
  const alarms=await chrome.alarms.getAll();
  await Promise.all(alarms.filter(x=>x.name.startsWith(`${prefix}-`)||x.name===watchdog||(prefix==="codemao-update"&&x.name==="codemao-watchdog")).map(x=>chrome.alarms.clear(x.name)));
  if(!schedule.enabled)return;
  if(schedule.mode==="half-hour"||Number(schedule.intervalMinutes)===30){
    chrome.alarms.create(`${prefix}-half-hour`,{when:nextHalfHourTime(),periodInMinutes:30});
  }else{
    for(const day of schedule.days)for(const time of schedule.times){
      const name=`${prefix}-${day}-${time.replace(":","")}`;
      chrome.alarms.create(name,{when:nextWeeklyTime(day,time),periodInMinutes:7*24*60});
    }
  }
  chrome.alarms.create(watchdog,{delayInMinutes:1,periodInMinutes:1});
}

async function setSchedule(schedule,localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const scheduleKey=instanceStorageKey("autoSchedule",localBase);
  const old=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||{};
  const enabled=Boolean(schedule?.enabled);
  const intervalMode=schedule?.mode==="half-hour"||Number(schedule?.intervalMinutes)===30;
  const days=[...new Set((schedule?.days||[1,2,3,4,5,6,0]).map(Number).filter(x=>x>=0&&x<=6))];
  const times=intervalMode?[]:[...new Set((schedule?.times||[schedule?.time||"09:00"]).filter(x=>/^\d{2}:\d{2}$/.test(x)))].sort();
  const saved={enabled,mode:intervalMode?"half-hour":"times",intervalMinutes:intervalMode?30:0,days,times,lastRun:old.lastRun||"",lastResult:old.lastResult||"",lastSuccessKey:old.lastSuccessKey||"",lastSuccessAt:old.lastSuccessAt||"",lastAttemptKey:old.lastAttemptKey||"",lastAttemptAt:Number(old.lastAttemptAt||0)};
  await chrome.storage.local.set({[scheduleKey]:saved});
  await rebuildScheduleAlarms(saved,localBase);
  setTimeout(()=>checkMissedSchedules(localBase),250);
  return saved;
}

function utf8Base64(text){
  const bytes=new TextEncoder().encode(text);let binary="";
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
}

async function runComparisonUpdate(localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);

  const key=instanceStorageKey('updateRuntime',localBase),now=Date.now();
  const lock=(await chrome.storage.local.get(key))[key]||{};
  const status=await (await fetchWithTimeout(`${localBase}/status`,{},10000)).json();
  if(lock.runningSince||status.state==='running')throw new Error('当前有更新正在执行，请完成后再单独更新其他组老师');
  await chrome.storage.local.set({[key]:{runningSince:now,slotKey:'comparison-manual'}});
  const stop=startMcpRelay(localBase);
  try{
    await postLocalStatus('running','正在独立更新其他组老师…','组内老师数据保持不变','crm',localBase);
    const input=await (await fetchWithTimeout(`${localBase}/comparison-input`,{},20000)).json();
    const names=new Set(input.comparisonTeachers||[]),blocks=input.blocks||[];
    const selected=blocks.filter(b=>names.has(String(b.info?.teacherName||'').split('-C')[0]));
    if(!selected.length)throw new Error('未找到配置中的其他组老师班级，请先完成一次组内教学数据更新');
    const crm=await fetchInCrm(selected.map(b=>[b.classId,b.termId]),[],0,localBase);
    if(!crm.ok)throw new Error(crm.error);
    const updated=JSON.parse(crm.data);
    if(!updated.some(b=>Object.values(b.liveAttendance||{}).some(r=>r.expectedIds?.length)))throw new Error('没有读到可核实的跨组直播名单，请在直播数据页打开明细并查询对应日期');
    const byId=new Map(updated.map(b=>[Number(b.classId),b]));
    const merged=blocks.map(b=>byId.get(Number(b.classId))||b);
    await postLocalStatus('running','其他组老师已采集，正在写入看板…','只替换其他组老师的班级数据','local',localBase);
    await uploadCrmData(JSON.stringify(merged),localBase);
    await waitForLocalCompletion(now,10*60*1000,localBase);
    return {ok:true};
  }catch(error){await postLocalStatus('error','其他组老师更新失败',String(error.message||error),'comparison',localBase);throw error;}
  finally{stop();await chrome.storage.local.remove(key);}
}

async function uploadCrmData(data,localBase=LOCAL_BASE){
  const encoded=utf8Base64(data),chunkSize=256*1024,total=Math.ceil(encoded.length/chunkSize);
  const uploadId=`crm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const send=async(url,body,timeout=20000)=>{
    let lastError;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        const response=await fetchWithTimeout(`${localBase}${url}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},timeout);
        if(response.ok)return response;
        lastError=new Error(`本地服务返回 ${response.status}`);
      }catch(error){lastError=error;}
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,400*attempt));
    }
    throw new Error(`本地数据分片传输失败：${String(lastError?.message||lastError||"连接中断")}`);
  };
  for(let index=0;index<total;index++){
    await send("/extension-data-chunk",{uploadId,index,total,data:encoded.slice(index*chunkSize,(index+1)*chunkSize)});
  }
  return send("/extension-data-commit",{uploadId,total},30000);
}

async function postLocalJson(path,body,timeout=20000,localBase=LOCAL_BASE){
  const response=await fetchWithTimeout(`${normalizeLocalBase(localBase)}${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},timeout);
  if(response.ok)return response;
  let detail=`本地服务返回 ${response.status}`;
  try{detail=(await response.json()).message||detail;}catch{}
  throw new Error(detail);
}

function shanghaiDateParts(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false}).formatToParts(date);
  const get=type=>Number(parts.find(part=>part.type===type)?.value||0);
  return {year:get("year"),month:get("month"),day:get("day"),hour:get("hour")};
}

function ymdFromDate(date){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

async function buildScheduledServiceSelection(localBase=LOCAL_BASE){
  const days=[5,6,0],startHour=14,endHour=21,selection={days,startHour,endHour,label:"14:00–21:00",dayLabel:"周五、周六、周日"};
  try{
    const response=await fetchWithTimeout(`${normalizeLocalBase(localBase)}/service-teaching-dates`,{cache:"no-store"},15000);
    if(!response.ok)throw new Error(`本地服务返回 ${response.status}`);
    const opened=await response.json();
    const parts=shanghaiDateParts();
    const today=`${parts.year}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")}`;
    const weekStart=new Date(parts.year,parts.month-1,parts.day);
    weekStart.setHours(0,0,0,0);
    weekStart.setDate(weekStart.getDate()-((weekStart.getDay()+6)%7));
    let dates=(opened.dates||[]).map(String).filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    const latest=dates[dates.length-1],daysAfterLatest=latest?(Date.parse(today)-Date.parse(latest))/86400000:null;
    if(opened.week===ymdFromDate(weekStart)&&parts.hour>=startHour&&daysAfterLatest>0&&daysAfterLatest<=1&&!dates.includes(today))dates=[...dates,today].sort();
    if(dates.length)return {...selection,dates,dateSource:"openedTeachingDays",openedWeek:opened.week||"",dayLabel:`已开课日 ${dates.join("、")}`};
  }catch(error){
    return {...selection,dateSource:"weekdayFallback",dateSourceError:String(error?.message||error)};
  }
  return selection;
}

async function waitForServiceCompletion(startedAt,timeout=9*60*1000,localBase=LOCAL_BASE,expectedRunId=""){
  localBase=normalizeLocalBase(localBase);
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,2500));
    try{
      const response=await fetchWithTimeout(`${localBase}/service-status`,{cache:"no-store"},5000);
      if(!response.ok)continue;
      const status=await response.json();
      if(expectedRunId&&String(status.runId||"")!==expectedRunId)continue;
      const statusTime=Date.parse(String(status.time||"").replace(" ","T"));
      if(Number.isFinite(statusTime)&&statusTime+1000<startedAt)continue;
      if(status.state==="success")return status;
      if(status.state==="error")throw new Error(`SERVICE_UPDATE_ERROR:${status.detail||status.message||"教学服务更新失败"}`);
    }catch(error){
      const message=String(error?.message||error);
      if(message.startsWith("SERVICE_UPDATE_ERROR:"))throw new Error(message.slice(21));
    }
  }
  throw new Error("教学服务写入超过9分钟，已停止等待；请查看教学服务状态。");
}

async function runScheduledServiceUpdate(slotKey="manual",localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const runId=`service-auto-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt=Date.now();
  const serviceSelection=await buildScheduledServiceSelection(localBase);
  const detail=serviceSelection.dates?.length?`自动同步：统计 ${serviceSelection.dates.join("、")} 已开课日，每日 ${serviceSelection.label}`:`自动同步：统计 ${serviceSelection.dayLabel}，每日 ${serviceSelection.label}`;
  await postLocalJson("/service-client-status",{state:"running",runId,message:"自动更新正在读取当前Chrome中的IM与企微看板…",detail},5000,localBase);
  await appendRunLog("开始同步教学服务数据",`${slotKey} · ${detail}`,localBase);
  const crm=await fetchServiceInCurrentChrome(serviceSelection);
  if(!crm?.ok||!crm?.data){
    const message=crm?.error||"CRM没有返回教学服务数据。";
    await postLocalJson("/service-client-status",{state:"error",runId,detail:message},5000,localBase).catch(()=>null);
    throw new Error(message);
  }
  await postLocalJson("/service-extension-data",{runId,data:utf8Base64(crm.data)},30000,localBase);
  const completed=await waitForServiceCompletion(startedAt,9*60*1000,localBase,runId);
  await appendRunLog("教学服务数据同步成功",completed.detail||completed.message||slotKey,localBase);
  return completed;
}

async function waitForLocalCompletion(startedAt,timeout=10*60*1000,localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,2500));
    try{
      const response=await fetchWithTimeout(`${localBase}/status`,{cache:"no-store"},5000);
      const status=await response.json();
      const statusTime=Date.parse(String(status.time||"").replace(" ","T"));
      if(Number.isFinite(statusTime)&&statusTime+1000<startedAt)continue;
      if(status.state==="success")return status;
      if(status.state==="error")throw new Error(`LOCAL_UPDATE_ERROR:${status.detail||status.message||"本地更新失败"}`);
    }catch(error){if(String(error?.message||error).startsWith("LOCAL_UPDATE_ERROR:"))throw new Error(String(error.message).slice(19));}
  }
  throw new Error("本地计算或钉钉同步超过10分钟，已停止等待；请查看控制台状态。 ");
}

async function waitForLocalRunner(startedAt,timeout=20*1000,localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,2000));
    try{
      const response=await fetchWithTimeout(`${localBase}/status`,{cache:"no-store"},5000);
      if(!response.ok)continue;
      const status=await response.json();
      const statusTime=Date.parse(String(status.time||"").replace(" ","T"));
      if(Number.isFinite(statusTime)&&statusTime+1000<startedAt)continue;
      const message=String(status.message||"");
      if(status.state!=="running"||status.phase!=="local"||!message.includes("启动本地计算"))return true;
    }catch{}
  }
  return false;
}

async function runScheduledUpdate(slotKey="manual",localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const runtimeKey=instanceStorageKey("updateRuntime",localBase),scheduleKey=instanceStorageKey("autoSchedule",localBase);
  await reconcileUpdateRuntime(localBase);
  const now=Date.now();
  let stage="crm";
  let stopMcpRelay=null;
  const lock=(await chrome.storage.local.get(runtimeKey))[runtimeKey]||{};
  if(Number(lock.runningSince||0)&&now-Number(lock.runningSince)<32*60*1000)return {ok:false,error:"当前工作台已有更新正在运行，请等待本轮完成"};
  if(activeUpdateRuns.has(localBase))return {ok:false,error:"当前工作台已有更新正在运行"};
  activeUpdateRuns.add(localBase);
  let schedule={};
  try{
  await chrome.storage.local.set({[runtimeKey]:{runningSince:now,slotKey}});
  const stored=await chrome.storage.local.get(scheduleKey);
  schedule=stored[scheduleKey]||{};
  const startedText=new Date().toLocaleString("zh-CN",{hour12:false});
  await chrome.storage.local.set({[scheduleKey]:{...schedule,lastRun:startedText,lastResult:"正在读取CRM数据",lastAttemptKey:slotKey,lastAttemptAt:now}});
  await appendRunLog("开始更新",slotKey,localBase);
    // Class configuration is read through the same DingTalk MCP channel as
    // the later workbook writes. Start the browser relay before preparation,
    // otherwise a blocked Node/PowerShell direct connection can deadlock the
    // task before CRM loading even begins.
    stopMcpRelay=startMcpRelay(localBase);
    const payload=await waitForLocalPreparation(slotKey,2*60*1000,localBase);
    if(payload.alreadyRunning){
      await appendRunLog("并入正在运行的任务",slotKey,localBase);
      const completed=await waitForLocalCompletion(0,10*60*1000,localBase);
      // Local completion is only the teaching stage; service must still run.
      payload.joinedCompletion=completed;
    }
    if(payload.alreadyCompleted){
      const successAt=String(payload.lastSuccessTime||new Date().toLocaleString("zh-CN",{hour12:false}));
      const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
      await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:successAt,lastResult:"同一时段已由另一连接器完成",lastSuccessKey:slotKey,lastSuccessAt:successAt,lastFailureKey:"",lastFailureAt:0,failureCount:0}});
      await appendRunLog("跳过重复任务",`${slotKey} 已由另一连接器完成`,localBase);
      return {ok:true,skipped:true};
    }
    if(!payload.joinedCompletion){
    await postLocalStatus("running","正在读取CRM班级、课程和直播数据…","最长5分钟，超时会自动结束并允许重试","crm",localBase);
    const crm=await fetchInCrm(payload.classes||[],payload.excludedTeachers||["薛超"],0,localBase);
    if(!crm.ok)throw new Error(crm.error||"CRM读取失败");
    stage="local";
    await postLocalStatus("running","CRM数据读取完成，正在启动本地计算…","","local",localBase);
    const synced=await uploadCrmData(crm.data,localBase);
    if(!synced.ok)throw new Error("本地更新脚本启动失败");
    if(!await waitForLocalRunner(now,20*1000,localBase)){
      await appendRunLog("本地脚本未进入计算阶段，自动重试启动",slotKey,localBase);
      const retried=await uploadCrmData(crm.data,localBase);
      if(!retried.ok)throw new Error("本地更新脚本自动重试启动失败");
    }
    payload.joinedCompletion=await waitForLocalCompletion(now,10*60*1000,localBase);
    }
    const completed=payload.joinedCompletion;
    stage="service";
    await postLocalStatus("running","教学数据已完成，正在同步教学服务数据…","正在读取IM与企微看板并写入教学服务子表","service",localBase);
    await appendRunLog("教学数据更新成功，开始同步教学服务数据",completed.message||slotKey,localBase);
    let serviceError=null;
    for(let serviceAttempt=1;serviceAttempt<=2;serviceAttempt++){
      try{await runScheduledServiceUpdate(slotKey,localBase);serviceError=null;break}
      catch(error){serviceError=error;if(serviceAttempt<2){await appendRunLog("教学服务阶段自动重试",String(error?.message||error),localBase);await new Promise(resolve=>setTimeout(resolve,3000));}}
    }
    if(serviceError)throw serviceError;
    await postLocalStatus("success","教学数据和教学服务数据更新完成","已同步教学看板与教学服务子表","service",localBase);
    const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
    const successAt=new Date().toLocaleString("zh-CN",{hour12:false});
    await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:successAt,lastResult:"教学数据和教学服务数据更新成功",lastSuccessKey:slotKey,lastSuccessAt:successAt,lastFailureKey:"",lastFailureAt:0,failureCount:0}});
    await appendRunLog("教学数据和教学服务数据更新成功",completed.message||slotKey,localBase);
    return {ok:true};
  }catch(error){
    const message=String(error?.message||error).replace(/^SCHEDULE_COOLDOWN:/,"");
    const waitingForCrm=/请先在当前浏览器打开并登录CRM后台|请先在当前谷歌浏览器打开并登录续费CRM后台|CRM_LOGIN_EXPIRED|当前浏览器.*登录CRM|Superset登录已失效/i.test(message);
    const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
    const sameFailure=String(latest.lastFailureKey||"")===String(slotKey);
    const failureCount=sameFailure?Number(latest.failureCount||0)+1:1;
    await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:new Date().toLocaleString("zh-CN",{hour12:false}),lastResult:message,lastFailureKey:slotKey,lastFailureAt:Date.now(),failureCount}});
    await appendRunLog("更新失败",message,localBase);
    await postLocalStatus(waitingForCrm?"waiting":"error",waitingForCrm?"自动更新等待 CRM 登录":"自动更新失败",waitingForCrm?`${message}；本时段会继续自动重试。`:message,stage,localBase);
    return {ok:false,error:message};
  }finally{
    if(stopMcpRelay)stopMcpRelay();
    try{await chrome.storage.local.remove(runtimeKey);}
    finally{activeUpdateRuns.delete(localBase);}
  }
}

async function checkMissedSchedules(localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const scheduleKey=instanceStorageKey("autoSchedule",localBase);
  await reconcileUpdateRuntime(localBase);
  const schedule=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||{};
  if(!schedule.enabled||!(schedule.days||[]).includes(new Date().getDay()))return;
  const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  if(schedule.mode==="half-hour"||Number(schedule.intervalMinutes)===30){
    const prefix=instanceAlarmPrefix(localBase),slot=halfHourSlotKey(prefix,now),successText=String(schedule.lastSuccessAt||""),lastSuccessAt=Date.parse(successText)||Date.parse(successText.replace(" ","T"));
    if(schedule.lastSuccessKey===slot.key)return;
    if(Number.isFinite(lastSuccessAt)&&lastSuccessAt>=slot.slot.getTime())return;
    if(schedule.lastFailureKey===slot.key){
      const failureCount=Number(schedule.failureCount||0),lastFailureAt=Number(schedule.lastFailureAt||0),waitingForCrm=/请先在当前浏览器|请先在当前谷歌浏览器|CRM_LOGIN_EXPIRED|登录CRM|Superset登录已失效/i.test(String(schedule.lastResult||""));
      if(failureCount>=(waitingForCrm?6:3))return;
      if(Date.now()-lastFailureAt<(waitingForCrm?5:10)*60*1000)return;
    }
    if(schedule.lastAttemptKey===slot.key&&Date.now()-Number(schedule.lastAttemptAt||0)<2*60*1000)return;
    await appendRunLog("检测到半小时自动更新并补跑",slot.key,localBase);
    return runScheduledUpdate(slot.key,localBase);
  }
  const due=(schedule.times||[]).filter(value=>{const [h,m]=value.split(":").map(Number);return h*60+m<=now.getHours()*60+now.getMinutes();}).sort();
  if(!due.length)return;
  const time=due[due.length-1],key=`codemao-update-${now.getDay()}-${time.replace(":","")}|${today}`;
  if(schedule.lastSuccessKey===key)return;
  const [dueHour,dueMinute]=time.split(":").map(Number);
  const dueAt=new Date(now);dueAt.setHours(dueHour,dueMinute,0,0);
  const successText=String(schedule.lastSuccessAt||"");
  const lastSuccessAt=Date.parse(successText)||Date.parse(successText.replace(" ","T"));
  if(Number.isFinite(lastSuccessAt)&&lastSuccessAt>=dueAt.getTime())return;
  const legacyFailedAttempt=schedule.lastAttemptKey===key&&schedule.lastSuccessKey!==key&&String(schedule.lastResult||"")&&String(schedule.lastResult||"")!=="正在读取CRM数据"&&!String(schedule.lastResult||"").includes("更新成功");
  if(legacyFailedAttempt&&Date.now()-Number(schedule.lastAttemptAt||0)<10*60*1000)return;
  if(schedule.lastFailureKey===key){
    const failureCount=Number(schedule.failureCount||0),lastFailureAt=Number(schedule.lastFailureAt||0);
    if(failureCount>=3)return;
    if(Date.now()-lastFailureAt<10*60*1000)return;
  }
  if(schedule.lastAttemptKey===key&&Date.now()-Number(schedule.lastAttemptAt||0)<2*60*1000)return;
  await appendRunLog("检测到漏跑并补跑",`${today} ${time}`,localBase);
  return runScheduledUpdate(key,localBase);
}

async function ensureScheduleHealth(force=false,localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const scheduleKey=instanceStorageKey("autoSchedule",localBase),prefix=instanceAlarmPrefix(localBase);
  await reconcileUpdateRuntime(localBase);
  const schedule=(await chrome.storage.local.get(scheduleKey))[scheduleKey];
  if(schedule?.enabled){
    const expected=schedule.mode==="half-hour"||Number(schedule.intervalMinutes)===30?[`${prefix}-watchdog`,`${prefix}-half-hour`]:[`${prefix}-watchdog`,...schedule.days.flatMap(day=>schedule.times.map(time=>`${prefix}-${day}-${time.replace(":","")}`))];
    const existing=new Set((await chrome.alarms.getAll()).map(x=>x.name));
    if(force||expected.some(name=>!existing.has(name)))await rebuildScheduleAlarms(schedule,localBase);
    await checkMissedSchedules(localBase);
  }
}

chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name==="codemao-update-watchdog")return checkMissedSchedules("http://127.0.0.1:8765");
  if(alarm.name==="codemao-test-update-watchdog")return checkMissedSchedules("http://127.0.0.1:8766");
  if(alarm.name==="codemao-update-half-hour"||alarm.name==="codemao-test-update-half-hour"){
    const localBase=alarm.name.startsWith("codemao-test-update-")?"http://127.0.0.1:8766":"http://127.0.0.1:8765",prefix=instanceAlarmPrefix(localBase);
    const scheduleKey=instanceStorageKey("autoSchedule",localBase),stored=await chrome.storage.local.get(scheduleKey),schedule=stored[scheduleKey]||{};
    if(!schedule.enabled)return;
    const slot=halfHourSlotKey(prefix);
    await chrome.storage.local.set({[scheduleKey]:{...schedule,lastAlarmAt:new Date().toLocaleString("zh-CN",{hour12:false}),lastAlarmSlot:slot.key}});
    return runScheduledUpdate(slot.key,localBase);
  }
  if(alarm.name.startsWith("codemao-update-")||alarm.name.startsWith("codemao-test-update-")){
    const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    const localBase=alarm.name.startsWith("codemao-test-update-")?"http://127.0.0.1:8766":"http://127.0.0.1:8765";
    return runScheduledUpdate(`${alarm.name}|${today}`,localBase);
  }
});
chrome.runtime.onStartup.addListener(()=>{injectDashboardBridge();ensureScheduleHealth(true,"http://127.0.0.1:8765");return ensureScheduleHealth(true,"http://127.0.0.1:8766")});
chrome.runtime.onInstalled.addListener(()=>{injectDashboardBridge();ensureScheduleHealth(true,"http://127.0.0.1:8765");return ensureScheduleHealth(true,"http://127.0.0.1:8766")});
injectDashboardBridge();
ensureScheduleHealth(false,"http://127.0.0.1:8765");
ensureScheduleHealth(false,"http://127.0.0.1:8766");

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.source!=="codemao-dashboard")return;
  if(message.type==="ping"){leaseMcpRelay(normalizeLocalBase(message.localBase));sendResponse({ok:true,version:chrome.runtime.getManifest().version,build:"half-hour-schedule-43-live-class-source"});return;}
  if(message.type==="reload-extension"){sendResponse({ok:true,reloading:true});setTimeout(()=>chrome.runtime.reload(),150);return;}
  if(message.type==='update-comparison'){
    runComparisonUpdate(message.localBase).then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error.message||error)}));return true;
  }
  if(message.type==="fetch-crm"){fetchInCrm(message.classes||[],message.excludedTeachers||["薛超"],0,normalizeLocalBase(message.localBase)).then(sendResponse);return true;}
  if(message.type==="prepare-cohort-classes"){
    leaseMcpRelay(normalizeLocalBase(message.localBase));
    waitForLocalPreparation("manual",2*60*1000,normalizeLocalBase(message.localBase),"prepare-cohort-exception").then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));return true;
  }
  if(message.type==="fetch-renewal"){leaseMcpRelay(normalizeLocalBase(message.localBase));fetchRenewalInCurrentChrome(message.renewalMonth).then(sendResponse);return true;}
  if(message.type==="fetch-nct"){fetchNctInCurrentChrome(message.filters||{}).then(sendResponse);return true;}
  if(message.type==="fetch-service"){
    // Manual service updates also hand data to a local writer which may need
    // DingTalk MCP. Keep the relay alive through that asynchronous write.
    leaseMcpRelay(normalizeLocalBase(message.localBase));
    fetchServiceInCurrentChrome(message.serviceSelection)
      .then(result=>sendResponse(result||{ok:false,error:"教学服务采集没有返回结果，请重试。"}))
      .catch(error=>sendResponse({ok:false,error:`教学服务数据读取失败：${String(error?.message||error)}`}));
    return true;
  }
  if(message.type==="get-schedule"){const localBase=normalizeLocalBase(message.localBase);const key=instanceStorageKey("autoSchedule",localBase);reconcileUpdateRuntime(localBase).then(()=>chrome.storage.local.get(key)).then(x=>sendResponse({ok:true,version:chrome.runtime.getManifest().version,schedule:x[key]||{enabled:false,mode:"half-hour",intervalMinutes:30,days:[1,2,3,4,5,6,0],times:[],lastRun:"",lastResult:""}}));return true;}
  if(message.type==="set-schedule"){const localBase=normalizeLocalBase(message.localBase);setSchedule(message.schedule||{},localBase).then(schedule=>sendResponse({ok:true,schedule}));return true;}
  if(message.type==="run-scheduled-now"){
    const localBase=/^http:\/\/(127\.0\.0\.1|localhost):876[56]$/.test(String(message.localBase||""))?String(message.localBase):LOCAL_BASE;
    const prefix=instanceAlarmPrefix(localBase);
    chrome.alarms.create(`${prefix}-manual-${Date.now()}`,{when:Date.now()+250}).then(()=>sendResponse({ok:true,started:true}));
    return true;
  }
});
