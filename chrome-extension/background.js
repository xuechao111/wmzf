let LOCAL_BASE="http://127.0.0.1:8765";
const CRM_RUNTIME_TIMEOUT_MS=6*60*1000;
const LOCAL_RUNTIME_TIMEOUT_MS=45*60*1000;
const LOCAL_HEARTBEAT_TIMEOUT_MS=8*60*1000;

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

async function waitForLocalPreparation(slotKey="manual",timeout=2*60*1000,localBase=LOCAL_BASE){
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
      const response=await fetchWithTimeout(`${localBase}/prepare-extension`,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({slotKey})},60000);
      if(response.status===409)throw new Error("已有更新正在运行");
      if(response.status===429){let detail="同一自动更新时段正在冷却";try{detail=(await response.json()).message||detail}catch{}throw new Error(`SCHEDULE_COOLDOWN:${detail}`);}
      if(response.ok)return await response.json();
      lastError=`本地控制台返回 ${response.status}`;
    }catch(error){
      const message=String(error?.message||error);
      if(message==="已有更新正在运行")throw error;
      if(message.startsWith("SCHEDULE_COOLDOWN:"))throw error;
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

async function reconcileUpdateRuntime(localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const runtimeKey=instanceStorageKey("updateRuntime",localBase),scheduleKey=instanceStorageKey("autoSchedule",localBase);
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
      const timeout=phase==="local"?LOCAL_RUNTIME_TIMEOUT_MS:CRM_RUNTIME_TIMEOUT_MS;
      const statusTime=Date.parse(String(status.time||"").replace(" ","T"));
      const heartbeatFresh=phase==="local"&&Number.isFinite(statusTime)&&Date.now()-statusTime<=LOCAL_HEARTBEAT_TIMEOUT_MS;
      if(heartbeatFresh||Date.now()-runningSince<=timeout)return;
      const detail=phase==="local"
        ?"本地计算或钉钉同步连续8分钟没有进度心跳，已自动解除任务锁；旧数据保持不变。"
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
    const success=status.state==="success";
    await chrome.storage.local.set({[scheduleKey]:{
      ...schedule,
      lastRun:String(status.time||new Date().toLocaleString("zh-CN",{hour12:false})),
      lastResult:success?"更新成功":String(status.detail||status.message||"更新失败"),
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

async function collectCrmData(classes,excludedTeachers=["薛超"],onProgress=async()=>{}){
        const deadline=Date.now()+4*60*1000;
        const api=async(url,options)=>{
          let lastError;
          for(let attempt=1;attempt<=3;attempt++){
            if(Date.now()>=deadline)throw new Error("CRM_TOTAL_TIMEOUT");
            const controller=new AbortController();
            const timer=setTimeout(()=>controller.abort(),20000);
            try{
              const r=await fetch(url,{credentials:"include",...(options||{}),signal:controller.signal});
              const bytes=await r.arrayBuffer();
              let text;
              try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
              catch{text=new TextDecoder("gb18030",{fatal:true}).decode(bytes);}
              if(r.status===401)throw new Error("CRM_LOGIN_EXPIRED");
              if(!r.ok)throw new Error(`CRM_HTTP_${r.status}`);
              const parsed=JSON.parse(text);
              if(parsed?.code&&Number(parsed.code)!==200)throw new Error(`CRM_API_${parsed.code}`);
              return parsed;
            }catch(error){
              lastError=error;
              if(String(error?.message||error).includes("CRM_LOGIN_EXPIRED"))throw error;
              if(attempt<3)await new Promise(r=>setTimeout(r,900*attempt));
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
        const compactKeys=["class_id","class_name","live_course","user_id","course_id","course_number","unlock_time","nickname","child_name","is_open","course_open_time","is_finish","course_finish_time","watch_time","watch_process","day_of_week","class_time"];
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
        const windowStart=monday.getTime()/1000-14*86400,windowEnd=monday.getTime()/1000+7*86400;
        // CRM used to read all configured classes serially. With 50+ classes,
        // network latency was multiplied by every class. Four workers keep the
        // request rate conservative while reducing the wall-clock time.
        const classBlocks=await mapLimit(classes,4,async pair=>{
          const classId=Number(pair[0]),hintedTermId=Number(pair[1]);
          const infoResp=await api(`https://lbk-crm-teacher-web-api.codemao.cn/term/getTermInfo?classId=${classId}`);
          const info=infoResp.data||{},termId=Number(info.termId||hintedTermId);
          if((excludedTeachers||[]).includes(String(info.teacherName||"").split("-C")[0]))return finishClass({classId,termId,info:compactInfo(info),excluded:true,reason:"teacher"});
          const all=await api(`https://api-codecamp-crm.codemao.cn/terms/${termId}/courses/all`);
          const catalog=Array.isArray(all)?all:(all.data||[]);
          const lessons=catalog.filter(c=>/^\d+-/.test(String(c.course_name||""))&&!/赛考精讲课/.test(String(c.course_name||""))).sort((a,b)=>Number(a.unlock_time||0)-Number(b.unlock_time||0)||Number(a.course_number||0)-Number(b.course_number||0)).slice(0,50);
          const courseIds=lessons.filter(x=>Number(x.unlock_time||0)>=windowStart&&Number(x.unlock_time||0)<windowEnd&&Number(x.unlock_time||0)<=nowSec).map(x=>x.course_id);
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
        const livePost=async(url,body)=>api(url,{method:"POST",headers:{"content-type":"application/json;charset=UTF-8","authorization_type":"3"},body:JSON.stringify(body)});
        const firstBoards=await livePost("https://lbk-crm-teacher-web-api.codemao.cn/shengwang/living/boards",{page:1,limit:100,minLivingStartTime:windowStart,maxLivingStartTime:Math.min(windowEnd,nowSec+3600),livingTypes:[0]});
        let boards=firstBoards.data?.items||[];
        const boardPages=Math.ceil(Number(firstBoards.data?.total||boards.length)/Number(firstBoards.data?.pageSize||100));
        const remainingPages=Array.from({length:Math.max(0,boardPages-1)},(_,index)=>index+2);
        const boardResponses=await mapLimit(remainingPages,4,page=>livePost("https://lbk-crm-teacher-web-api.codemao.cn/shengwang/living/boards",{page,limit:100,minLivingStartTime:windowStart,maxLivingStartTime:Math.min(windowEnd,nowSec+3600),livingTypes:[0]}));
        for(const next of boardResponses)boards.push(...(next.data?.items||[]));
        if(!boards.length)throw new Error("CRM_LIVE_BOARDS_EMPTY");
        const studentIds=async(board,isParticipated)=>{
          let pageIndex=1,ids=[],names={};
          while(true){
            const response=await livePost("https://cloud-gateway.codemao.cn/crm-common/shengwang/living/students",{roomUuid:board.roomUuid,pageIndex,pageSize:100,isParticipated});
            const rows=response.data?.items||[];
            for(const row of rows){const id=String(row.userId||"");if(id){ids.push(id);names[id]=String(row.studentName||row.wechatNickname||"");}}
            if(pageIndex*100>=Number(response.data?.total||rows.length))break;
            pageIndex++;
          }
          return {ids,names};
        };
        let matchedLiveBoards=0;
        const liveMatches=[];
        const collectClassIds=value=>{
          const found=[];
          const visit=(node,key="")=>{
            if(node==null)return;
            if(Array.isArray(node)){for(const item of node)visit(item,key);return;}
            if(typeof node==="object"){
              for(const [childKey,child] of Object.entries(node))visit(child,childKey);
              return;
            }
            if(/class.*id|id.*class/i.test(key)){
              const id=Number(node);
              if(Number.isInteger(id)&&id>0)found.push(id);
            }
          };
          visit(value);
          return [...new Set(found)];
        };
        for(const board of boards){
          const lessonNumber=Number(String(board.courseName||"").match(/^(\d+)-/)?.[1]||0);
          // Course numbers are not reliably odd/even after inserted lessons.
          // A CRM live-board record plus an exact class match is authoritative.
          if(!lessonNumber)continue;
          // CRM live rooms use multiple schemas. Read only values carried by
          // class/id-labelled keys, including nested class lists.
          const classIds=[...new Set([...(board.classIdList||[]).map(Number),...collectClassIds(board)])];
          // Each Friday/Saturday slot has its own CRM class ID. Always bind a
          // room to that exact ID first; merging sibling IDs would inflate the
          // numerator and denominator by combining several teaching slots.
          let targets=output.filter(block=>classIds.includes(Number(block.classId)));
          if(!targets.length){
            // Some CRM rooms omit or retain an outdated classIdList after a
            // teacher/class transfer. Fall back only to a strict triple match
            // so a room can never leak into another class or schedule slot.
            const boardTeacher=String(board.teacherName||board.teacherFullName||board.nickname||"").split("-C")[0].trim();
            let boardStart=Number(board.livingStartTime||board.startTime||board.livingBeginTime||0);
            if(boardStart>1e12)boardStart=Math.floor(boardStart/1000);
            const candidates=output.filter(block=>{
              const blockTeacher=String(block.info?.teacherName||"").split("-C")[0].trim();
              return boardTeacher&&blockTeacher===boardTeacher&&(block.lessons||[]).some(lesson=>Number(lesson.course_number)===lessonNumber&&(!boardStart||Math.abs(Number(lesson.unlock_time||0)-boardStart)<=7200));
            });
            if(boardStart||candidates.length===1)targets=candidates;
          }
          if(!targets.length)continue;
          matchedLiveBoards+=targets.length;
          liveMatches.push({board,lessonNumber,targets});
        }
        // Fetch independent room rosters with bounded concurrency, then merge
        // them in source order so duplicate-room reconciliation stays stable.
        let completedLiveRooms=0;
        const liveResults=await mapLimit(liveMatches,3,async match=>{
          const [attended,absent]=await Promise.all([studentIds(match.board,true),studentIds(match.board,false)]);
          completedLiveRooms++;
          if(completedLiveRooms===liveMatches.length||completedLiveRooms%10===0){
            await onProgress("正在读取CRM直播上座名单…",`已完成 ${completedLiveRooms}/${liveMatches.length} 个直播房间`);
          }
          return {...match,attended,absent};
        });
        for(const {board,lessonNumber,targets,attended,absent} of liveResults){
          for(const block of targets){
            block.liveAttendance=block.liveAttendance||{};
            const old=block.liveAttendance[lessonNumber]||{expectedIds:[],attendedIds:[],absentIds:[],names:{},boardIds:[]};
            old.expectedIds=[...new Set([...old.expectedIds,...attended.ids,...absent.ids])];
            old.attendedIds=[...new Set([...old.attendedIds,...attended.ids])];
            const attendedSet=new Set(old.attendedIds);
            // A learner may be absent in an earlier/duplicate room but present
            // in another room for the same class lesson. Final absence must be
            // expected minus final attendance, never a union of absence lists.
            old.absentIds=old.expectedIds.filter(id=>!attendedSet.has(id));
            old.names={...old.names,...attended.names,...absent.names};
            old.boardIds=[...new Set([...old.boardIds,String(board.livingId||board.roomUuid||"")])];
            block.liveAttendance[lessonNumber]=old;
          }
        }
        if(!matchedLiveBoards)throw new Error("CRM_LIVE_BOARDS_CLASS_MISMATCH");
        const brokenNames=output.filter(block=>String(block.info?.teacherName||"").includes("�"));
        if(brokenNames.length)throw new Error(`CRM_TEXT_ENCODING_INVALID:${brokenNames.map(x=>x.classId).join(",")}`);
        return JSON.stringify(output);
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
      collectCrmData(classes,excludedTeachers,(message,detail)=>postLocalStatus("running",message,detail,"crm",localBase)),
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
  const selectedMonth=/^\d{4}-(0[1-9]|1[0-2])-01$/.test(String(renewalMonth||""))?String(renewalMonth):"2026-08-01";
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

function serviceWeekendDates(){
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));
  const today=new Date(now);today.setHours(0,0,0,0);
  const weekday=(today.getDay()+6)%7,monday=new Date(today);monday.setDate(today.getDate()-weekday);
  const dates=[];
  const format=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  for(const offset of [4,5,6]){
    const date=new Date(monday);date.setDate(monday.getDate()+offset);
    if(date<today||(date.getTime()===today.getTime()&&now.getHours()>=14))dates.push(format(date));
  }
  // Monday-Friday before the 14:00 service window has no current-week rows.
  // Keep the board usable by selecting the latest complete Fri-Sun window.
  if(!dates.length)for(const offset of [4,5,6]){const date=new Date(monday);date.setDate(monday.getDate()+offset-7);dates.push(format(date));}
  return dates;
}

function serviceTodayDate(){
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}));
  if(now.getHours()<14)return "";
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

async function fetchServiceInCurrentChrome(){
  const tabs=await chrome.tabs.query({url:"https://bigdata-superset.codemao.cn/*"});
  if(!tabs.length)return {ok:false,error:"请先在当前谷歌浏览器打开并登录 Superset CRM；控制台不会另开页面。"};
  const tab=tabs.find(x=>x.active&&!x.discarded)||tabs.find(x=>!x.discarded)||tabs[0];
  const dates=serviceWeekendDates(),todayDate=serviceTodayDate();
  try{
    await waitForTabReady(tab.id);
    const results=await Promise.race([chrome.scripting.executeScript({
      target:{tabId:tab.id},world:"MAIN",args:[dates,todayDate],
      func:async(dates,todayDate)=>{try{
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
          const dashboard=await api(`/api/v1/dashboard/${id}`),chartsPayload=await api(`/api/v1/dashboard/${id}/charts`);
          const result=dashboard.result||dashboard;
          let metadata={};try{metadata=JSON.parse(result.json_metadata||"{}");}catch{}
          const nativeFilters=metadata.native_filter_configuration||[];
          const filterColumn=keywords=>{const filter=nativeFilters.find(item=>keywords.some(word=>normalize(item.name).includes(word)));return filter?.targets?.[0]?.column?.name||filter?.target?.column?.name||"";};
          const columns={
            date:filterColumn(["具体发送日期","具体统计日期"]),zone:filterColumn(["战区"]),team:filterColumn(["团队"]),group:filterColumn(["小组"]),department:filterColumn(["部门"]),timeType:filterColumn(["时间类型"]),hour:filterColumn(["小时","时间区间","发送时间"]),
          };
          const charts=chartsPayload.result||chartsPayload.charts||chartsPayload||[];
          const pick=async dimension=>{
            const named=charts.filter(chart=>{const name=normalize(chart.slice_name||chart.chart_name||chart.name);const dimensionMatch=dimension==="老师"?((name.includes("老师")||name.includes("教师"))&&!name.includes("团队")&&!name.includes("小组")&&!name.includes("战区")&&!name.includes("用户")):(name.includes("-小组")||name.includes("小组数据"));return dimensionMatch&&!name.includes("趋势");}).sort((a,b)=>Number(normalize(b.slice_name||b.chart_name||b.name).includes("明细"))-Number(normalize(a.slice_name||a.chart_name||a.name).includes("明细")));
            // The verified dashboards expose stable, descriptive chart names.
            // Use those candidates directly; scanning every chart definition
            // multiplied Superset requests and could leave the UI waiting.
            if(named.length||dimension!=="老师")return named;
            const structural=[];
            for(const chart of charts){
              const name=normalize(chart.slice_name||chart.chart_name||chart.name);if(name.includes("趋势")||name.includes("团队")||name.includes("小组")||name.includes("战区")||name.includes("用户"))continue;
              try{const detail=await api(`/api/v1/chart/${chart.id||chart.slice_id}`),queryText=normalize((detail.result||detail).query_context||"");if((queryText.includes("worker_no")||queryText.includes("beisen_user_fullname"))&&(kind!=="wecom"||queryText.includes("avg_2hour_reply_rate"))&&(kind!=="im"||queryText.includes("pre_teacher_3m_reply_cnt")))structural.push(chart);}catch{}
            }
            return [...structural,...named.filter(chart=>!structural.some(item=>(item.id||item.slice_id)===(chart.id||chart.slice_id)))];
          };
          const runChart=async(chart,dimension,filterDates)=>{
            const detail=await api(`/api/v1/chart/${chart.id||chart.slice_id}`),chartResult=detail.result||detail;
            const queryTemplate=JSON.parse(chartResult.query_context||"{}");
            const baseDesired=[];
            const add=(column,value)=>{if(column&&value!=null&&(!Array.isArray(value)||value.length))baseDesired.push({col:column,op:"IN",val:Array.isArray(value)?value:[value]});};
            add(columns.date,filterDates);add(columns.zone,"AI C++教学部");
            if(kind==="wecom")add(columns.team,"深圳战区");else add(columns.department,["探月教学中心","深空教学中心"]);
            if(dimension==="老师")add(columns.group,"屹柯组");
            const serviceHours=["14","15","16","17","18","19","20","21"];
            const headers={"content-type":"application/json"};if(csrf)headers["x-csrftoken"]=csrf;
            const execute=async extraFilters=>{const desired=[...baseDesired,...extraFilters],query=JSON.parse(JSON.stringify(queryTemplate)),targetColumns=new Set(desired.map(x=>x.col));for(const item of query.queries||[]){item.filters=(item.filters||[]).filter(filter=>!targetColumns.has(filter.col)||filter.op==="TEMPORAL_RANGE");item.filters.push(...desired);item.row_limit=200000;item.row_offset=0;}query.force=true;query.form_data=query.form_data||{};query.form_data.extra_form_data={...(query.form_data.extra_form_data||{}),filters:desired};const payload=await api("/api/v1/chart/data",{method:"POST",headers,body:JSON.stringify(query)});return payload.result?.find(item=>Array.isArray(item.data))||payload.result?.[0];};
            let raw;
            if(kind==="wecom"&&!columns.hour&&columns.timeType){
              const variants=[["工作时间"],["工作时段"],serviceHours,serviceHours.map(x=>`${x}时`),serviceHours.map(x=>`${x}点`),serviceHours.map(x=>`${x}:00`),serviceHours.map(x=>`${x}:00-${x}:59`),serviceHours.map(x=>Number(x))];
              for(const values of variants){const candidate=await execute([{col:columns.timeType,op:"IN",val:values}]);if(candidate?.data?.length){raw=candidate;break;}}
              if(!raw){const diagnostic=await execute([]),keys=(diagnostic?.colnames||Object.keys(diagnostic?.data?.[0]||{})).map(normalize);throw new Error(`CRM_SERVICE_HOUR_VALUES_NOT_MATCHED:${id}:${dimension}:timeColumn=${columns.timeType}:unfiltered=${keys.join("|")}`);}
            }else{
              const extra=[];if(kind==="wecom"&&columns.timeType)extra.push({col:columns.timeType,op:"IN",val:["总计"]});if(columns.hour)extra.push({col:columns.hour,op:"IN",val:serviceHours});raw=await execute(extra);
            }
            if(!raw||!Array.isArray(raw.data))throw new Error(`CRM_SERVICE_TABLE_INVALID:${id}:${dimension}`);
            if(!raw.data.length)throw new Error(`CRM_SERVICE_NO_ROWS:${id}:${dimension}:dates=${filterDates.join(",")}`);
            const verbose=raw.verbose_map||{},physical=(raw.colnames||Object.keys(raw.data[0]||{})).map(normalize);
            const wanted=kind==="im"
              ? ["worker_no","beisen_user_fullname","level_7_department_name","send_date","msg_send_hour","pre_teacher_3m_reply_cnt"]
              : ["worker_no","beisen_user_fullname","level_7_department_name","statistics_date","stat_date","avg_2hour_reply_rate"];
            if(!physical.includes(kind==="im"?"pre_teacher_3m_reply_cnt":"avg_2hour_reply_rate"))throw new Error(`CRM_SERVICE_METRIC_NOT_FOUND:${id}:${dimension}:${physical.join("|")}`);
            if(dimension==="老师"&&!physical.some(column=>column==="worker_no"||column==="beisen_user_fullname"))throw new Error(`CRM_SERVICE_TEACHER_COLUMNS_NOT_FOUND:${id}:${physical.join("|")}`);
            if(dimension==="小组"&&!physical.includes("level_7_department_name"))throw new Error(`CRM_SERVICE_GROUP_COLUMN_NOT_FOUND:${id}:${physical.join("|")}`);
            const selected=physical.filter(column=>wanted.includes(column));
            const resultHeaders=selected.length?selected:physical;
            const metricColumn=kind==="im"?"pre_teacher_3m_reply_cnt":"avg_2hour_reply_rate";
            const percent=value=>{const text=normalize(value);if(!text)return null;const number=Number(text.replace("%",""));if(!Number.isFinite(number))return null;return text.includes("%")?number:(Math.abs(number)<=1?number*100:number);};
            const grouped=new Map();
            for(const sourceRow of raw.data){
              const name=normalize(sourceRow.beisen_user_fullname),worker=normalize(sourceRow.worker_no),group=normalize(sourceRow.level_7_department_name);
              const key=dimension==="老师"?(worker||name):group,value=percent(sourceRow[metricColumn]);
              if(!key||value==null)continue;
              if(!grouped.has(key))grouped.set(key,{worker_no:worker,beisen_user_fullname:name,level_7_department_name:group,sum:0,count:0});
              const item=grouped.get(key);item.sum+=value;item.count+=1;
            }
            const granular=raw.data.length>grouped.size;
            const rows=[...grouped.values()].map(item=>{
              const base={worker_no:item.worker_no,beisen_user_fullname:item.beisen_user_fullname,level_7_department_name:item.level_7_department_name,[metricColumn]:`${item.sum/item.count}%`};
              // A detail table returns one valid question record per source row;
              // its metric is the within-threshold answer flag (IM 3m / WeCom 2h).
              // Only publish counts when the result is actually granular; this
              // prevents an already-aggregated group chart from inventing counts.
              if(granular){
                const questionKey=kind==="im"?"im_question_count":"wecom_question_count",answerKey=kind==="im"?"im_answered_3m_count":"wecom_answered_2h_count";
                base[questionKey]=item.count;base[answerKey]=Math.round(item.sum/100);base[metricColumn]=`${base[questionKey]?base[answerKey]/base[questionKey]*100:0}%`;
              }
              return base;
            });
            if(!rows.length)throw new Error(`CRM_SERVICE_EMPTY_AFTER_FILTERS:${id}:${dimension}:${chart.slice_name||chart.chart_name||""}`);
            const countHeaders=!granular?[]:(kind==="im"?["im_answered_3m_count","im_question_count"]:["wecom_answered_2h_count","wecom_question_count"]);
            return {chartId:chart.id||chart.slice_id,chartName:chart.slice_name||chart.chart_name||"",headers:[...resultHeaders,...countHeaders],rows,rowcount:Number(raw.rowcount??rows.length),filterColumns:columns,granular};
          };
          const fetchDimension=async(dimension,filterDates)=>{const candidates=await pick(dimension),attempts=[];for(const chart of candidates){try{const table=await runChart(chart,dimension,filterDates);if(table.rows.length)return table;}catch(error){attempts.push(`${chart.id||chart.slice_id}:${normalize(chart.slice_name||chart.chart_name||chart.name)}=>${String(error?.message||error)}`);}}throw new Error(attempts.length?`CRM_SERVICE_CANDIDATES_FAILED:${id}:${dimension}:${attempts.join(" || ")}`:`CRM_SERVICE_CHART_NOT_FOUND:${id}:${dimension}`);};
          const fetchRange=async filterDates=>{const [teacher,group]=await Promise.all([fetchDimension("老师",filterDates),fetchDimension("小组",filterDates)]);return {teacher,group};};
          return {fetchRange};
        };
        const [imDashboard,wecomDashboard]=await Promise.all([fetchDashboard(382,"im"),fetchDashboard(337,"wecom")]);
        const [im,wecom]=await Promise.all([imDashboard.fetchRange(dates),wecomDashboard.fetchRange(dates)]);
        let today=null;
        if(todayDate){try{const [todayIm,todayWecom]=await Promise.all([imDashboard.fetchRange([todayDate]),wecomDashboard.fetchRange([todayDate])]);today={dates:[todayDate],im:todayIm,wecom:todayWecom};}catch(error){today={dates:[todayDate],teachers:[],groups:[],error:String(error?.message||error)};}}
        return JSON.stringify({dates,im,wecom,today});
      }catch(error){return JSON.stringify({__serviceError:String(error?.stack||error?.message||error)});}
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

async function rebuildScheduleAlarms(schedule,localBase=LOCAL_BASE){
  const prefix=instanceAlarmPrefix(localBase),watchdog=`${prefix}-watchdog`;
  const alarms=await chrome.alarms.getAll();
  await Promise.all(alarms.filter(x=>x.name.startsWith(`${prefix}-`)||x.name===watchdog||(prefix==="codemao-update"&&x.name==="codemao-watchdog")).map(x=>chrome.alarms.clear(x.name)));
  if(!schedule.enabled)return;
  for(const day of schedule.days)for(const time of schedule.times){
    const name=`${prefix}-${day}-${time.replace(":","")}`;
    chrome.alarms.create(name,{when:nextWeeklyTime(day,time),periodInMinutes:7*24*60});
  }
  chrome.alarms.create(watchdog,{delayInMinutes:1,periodInMinutes:1});
}

async function setSchedule(schedule,localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const scheduleKey=instanceStorageKey("autoSchedule",localBase);
  const old=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||{};
  const enabled=Boolean(schedule?.enabled);
  const days=[...new Set((schedule?.days||[1,2,3,4,5,6,0]).map(Number).filter(x=>x>=0&&x<=6))];
  const times=[...new Set((schedule?.times||[schedule?.time||"09:00"]).filter(x=>/^\d{2}:\d{2}$/.test(x)))].sort();
  const saved={enabled,days,times,lastRun:old.lastRun||"",lastResult:old.lastResult||"",lastSuccessKey:old.lastSuccessKey||"",lastSuccessAt:old.lastSuccessAt||"",lastAttemptKey:old.lastAttemptKey||"",lastAttemptAt:Number(old.lastAttemptAt||0)};
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
  const lock=(await chrome.storage.local.get(runtimeKey))[runtimeKey]||{};
  if(Number(lock.runningSince||0)&&now-Number(lock.runningSince)<18*60*1000)return {ok:false,error:"当前工作台已有更新正在运行，请等待本轮完成"};
  await chrome.storage.local.set({[runtimeKey]:{runningSince:now,slotKey}});
  const stored=await chrome.storage.local.get(scheduleKey);
  const schedule=stored[scheduleKey]||{};
  const startedText=new Date().toLocaleString("zh-CN",{hour12:false});
  await chrome.storage.local.set({[scheduleKey]:{...schedule,lastRun:startedText,lastResult:"正在读取CRM数据",lastAttemptKey:slotKey,lastAttemptAt:now}});
  await appendRunLog("开始更新",slotKey,localBase);
  try{
    const payload=await waitForLocalPreparation(slotKey,2*60*1000,localBase);
    if(payload.alreadyRunning){
      await appendRunLog("并入正在运行的任务",slotKey,localBase);
      const completed=await waitForLocalCompletion(0,10*60*1000,localBase);
      const successAt=String(completed.lastSuccessTime||completed.time||new Date().toLocaleString("zh-CN",{hour12:false}));
      const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
      await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:successAt,lastResult:"更新成功（已并入同一任务）",lastSuccessKey:slotKey,lastSuccessAt:successAt,lastFailureKey:"",lastFailureAt:0,failureCount:0}});
      return {ok:true,joined:true};
    }
    if(payload.alreadyCompleted){
      const successAt=String(payload.lastSuccessTime||new Date().toLocaleString("zh-CN",{hour12:false}));
      const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
      await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:successAt,lastResult:"同一时段已由另一连接器完成",lastSuccessKey:slotKey,lastSuccessAt:successAt,lastFailureKey:"",lastFailureAt:0,failureCount:0}});
      await appendRunLog("跳过重复任务",`${slotKey} 已由另一连接器完成`,localBase);
      return {ok:true,skipped:true};
    }
    await postLocalStatus("running","正在读取CRM班级、课程和直播数据…","最长5分钟，超时会自动结束并允许重试","crm",localBase);
    const crm=await fetchInCrm(payload.classes||[],payload.excludedTeachers||["薛超"],0,localBase);
    if(!crm.ok)throw new Error(crm.error||"CRM读取失败");
    await postLocalStatus("running","CRM数据读取完成，正在启动本地计算…","","local",localBase);
    const synced=await uploadCrmData(crm.data,localBase);
    if(!synced.ok)throw new Error("本地更新脚本启动失败");
    if(!await waitForLocalRunner(now,20*1000,localBase)){
      await appendRunLog("本地脚本未进入计算阶段，自动重试启动",slotKey,localBase);
      const retried=await uploadCrmData(crm.data,localBase);
      if(!retried.ok)throw new Error("本地更新脚本自动重试启动失败");
    }
    const completed=await waitForLocalCompletion(now,10*60*1000,localBase);
    const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
    const successAt=new Date().toLocaleString("zh-CN",{hour12:false});
    await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:successAt,lastResult:"更新成功",lastSuccessKey:slotKey,lastSuccessAt:successAt,lastFailureKey:"",lastFailureAt:0,failureCount:0}});
    await appendRunLog("更新成功",completed.message||slotKey,localBase);
    return {ok:true};
  }catch(error){
    const message=String(error?.message||error).replace(/^SCHEDULE_COOLDOWN:/,"");
    const latest=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||schedule;
    const sameFailure=String(latest.lastFailureKey||"")===String(slotKey);
    const failureCount=sameFailure?Number(latest.failureCount||0)+1:1;
    await chrome.storage.local.set({[scheduleKey]:{...latest,lastRun:new Date().toLocaleString("zh-CN",{hour12:false}),lastResult:message,lastFailureKey:slotKey,lastFailureAt:Date.now(),failureCount}});
    await appendRunLog("更新失败",message,localBase);
    await postLocalStatus("error","自动更新失败",message,"crm",localBase);
    return {ok:false,error:message};
  }finally{
    await chrome.storage.local.remove(runtimeKey);
  }
}

async function checkMissedSchedules(localBase=LOCAL_BASE){
  localBase=normalizeLocalBase(localBase);
  const scheduleKey=instanceStorageKey("autoSchedule",localBase);
  await reconcileUpdateRuntime(localBase);
  const schedule=(await chrome.storage.local.get(scheduleKey))[scheduleKey]||{};
  if(!schedule.enabled||!(schedule.days||[]).includes(new Date().getDay()))return;
  const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
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
    const expected=[`${prefix}-watchdog`,...schedule.days.flatMap(day=>schedule.times.map(time=>`${prefix}-${day}-${time.replace(":","")}`))];
    const existing=new Set((await chrome.alarms.getAll()).map(x=>x.name));
    if(force||expected.some(name=>!existing.has(name)))await rebuildScheduleAlarms(schedule,localBase);
    await checkMissedSchedules(localBase);
  }
}

chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name==="codemao-update-watchdog")return checkMissedSchedules("http://127.0.0.1:8765");
  if(alarm.name==="codemao-test-update-watchdog")return checkMissedSchedules("http://127.0.0.1:8766");
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
  if(message.type==="ping"){sendResponse({ok:true,version:chrome.runtime.getManifest().version,build:"service-people-metrics-20"});return;}
  if(message.type==="reload-extension"){sendResponse({ok:true,reloading:true});setTimeout(()=>chrome.runtime.reload(),150);return;}
  if(message.type==="fetch-crm"){fetchInCrm(message.classes||[],message.excludedTeachers||["薛超"]).then(sendResponse);return true;}
  if(message.type==="fetch-renewal"){fetchRenewalInCurrentChrome(message.renewalMonth).then(sendResponse);return true;}
  if(message.type==="fetch-service"){
    fetchServiceInCurrentChrome()
      .then(result=>sendResponse(result||{ok:false,error:"教学服务采集没有返回结果，请重试。"}))
      .catch(error=>sendResponse({ok:false,error:`教学服务数据读取失败：${String(error?.message||error)}`}));
    return true;
  }
  if(message.type==="get-schedule"){const localBase=normalizeLocalBase(message.localBase);const key=instanceStorageKey("autoSchedule",localBase);reconcileUpdateRuntime(localBase).then(()=>chrome.storage.local.get(key)).then(x=>sendResponse({ok:true,version:chrome.runtime.getManifest().version,schedule:x[key]||{enabled:false,days:[1,2,3,4,5],times:["09:00"],lastRun:"",lastResult:""}}));return true;}
  if(message.type==="set-schedule"){const localBase=normalizeLocalBase(message.localBase);setSchedule(message.schedule||{},localBase).then(schedule=>sendResponse({ok:true,schedule}));return true;}
  if(message.type==="run-scheduled-now"){
    const localBase=/^http:\/\/(127\.0\.0\.1|localhost):876[56]$/.test(String(message.localBase||""))?String(message.localBase):LOCAL_BASE;
    const prefix=instanceAlarmPrefix(localBase);
    chrome.alarms.create(`${prefix}-manual-${Date.now()}`,{when:Date.now()+250}).then(()=>sendResponse({ok:true,started:true}));
    return true;
  }
});
