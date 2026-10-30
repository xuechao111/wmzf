import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {buildServiceViews} from '../sync-service-data.mjs';

const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const start=source.indexOf('func:async(dates,todayDate,serviceSelection)=>');
const end=source.indexOf('\n    }),new Promise',start);
const callback=source.slice(start+5,end).trim();
const today='2026-10-12',multi=['2026-10-06','2026-10-10'];

async function query({failWecom=false,wrongDate=false,missingDate=false,callRows=false,callMismatch=false,missingCalls=false,truncated=false,missingRate=false,emptyToday=false,transientEmpty=false}={}){
  const requests=[],definitionRequests=[];
  const fetch=async(url,options={})=>{
    let payload;
    if(url.includes('csrf_token'))payload={result:''};
    else if(/dashboard\/\d+\/charts$/.test(url)){
      const id=Number(url.match(/dashboard\/(\d+)/)[1]);
      payload={result:[{id:id*10,slice_name:'老师数据'},{id:id*10+1,slice_name:'小组数据（聚合）'}]};
    }else if(/dashboard\/\d+$/.test(url)){
      const dateColumn=url.endsWith('382')?'send_date':'statistic_date';
      payload={result:{json_metadata:JSON.stringify({native_filter_configuration:missingDate?[]:[{name:'具体发送日期',targets:[{column:{name:dateColumn}}]},{name:'小时',targets:[{column:{name:'msg_send_hour'}}]}]})}};
    }else if(/chart\/\d+$/.test(url)){
      const id=Number(url.match(/chart\/(\d+)/)[1]);
      definitionRequests.push(id);
      payload={result:{query_context:JSON.stringify({datasource:{id},queries:[{filters:[],time_range:'2026-09-01 : 2026-09-02'}],form_data:{}})}};
    }else if(url==='/api/v1/chart/data'){
      const body=JSON.parse(options.body),im=body.datasource.id>=3820||body.datasource.id===2458||body.datasource.id===3114;
      const dates=body.queries[0].filters.find(filter=>filter.col===(im?'send_date':'statistic_date')).val;
      requests.push(body);
      if(failWecom&&!im&&dates[0]===today)return {ok:true,json:async()=>({result:[{data:[]}]})};
      const row={...(im?{sum_call_cnt:0,sum_video_call_cnt:0}:{}),worker_no:'T1',beisen_user_fullname:'Teacher',level_7_department_name:'Group',
        [im?'pre_teacher_3m_reply_cnt':'avg_2hour_reply_rate']:dates[0]===today?'80%':'50%',
        [im?'sum_user_msg_cnt':'wecom_question_count']:10,
        [im?'sum_teacher_3m_reply_cnt':'wecom_answered_2h_count']:dates[0]===today?8:5};
      if(wrongDate&&dates[0]===today)row[im?'send_date':'statistic_date']='2026-10-10';
      if(im&&missingRate)row.sum_call_cnt=2;
      if(im&&missingCalls){delete row.sum_call_cnt;delete row.sum_video_call_cnt;}
      if(im&&callMismatch&&body.datasource.id===2458){row.sum_call_cnt=1;row.call_success_rate='100%';}
      const firstDaily=transientEmpty&&im&&body.datasource.id>=3820&&dates[0]===today&&requests.filter(request=>request.datasource.id===body.datasource.id&&request.queries[0].time_range.startsWith(today)).length===1;
      payload={result:[{...(im&&truncated?{rowcount:2}:{}),data:im&&(emptyToday||firstDaily)&&dates[0]===today?[]:im&&callRows?[
        {...row,sum_call_cnt:1,call_success_rate:'100%',sum_video_call_cnt:1,video_call_success_rate:'0%'},
        {...row,sum_call_cnt:9,call_success_rate:'0%',sum_video_call_cnt:9,video_call_success_rate:'100%'}
      ]:[row]}]};
    }else throw new Error(`Unexpected URL ${url}`);
    return {ok:true,status:200,json:async()=>payload};
  };
  const func=vm.runInNewContext(`(${callback})`,{fetch,AbortController,setTimeout,clearTimeout});
  return {data:JSON.parse(await func(multi,today,{hours:['14','15'],startHour:14,endHour:21})),requests,definitionRequests};
}

test('daily IM and WeCom use today, overriding historical chart ranges',async()=>{
  const {data,requests}=await query();
  assert.equal(data.today.status,'ok');
  const daily=buildServiceViews(data.today),aggregate=buildServiceViews(data);
  assert.equal(daily.teachers[0].im,80);
  assert.equal(daily.teachers[0].wecom,80);
  assert.equal(aggregate.teachers[0].im,50);
  const dailyRequests=requests.filter(body=>body.queries[0].time_range.startsWith(today));
  assert.equal(dailyRequests.length,5);
  for(const body of dailyRequests){
    assert.equal(body.queries[0].time_range,'2026-10-12T00:00:00 : 2026-10-13T00:00:00');
    assert.deepEqual(body.queries[0].filters.find(filter=>filter.col==='msg_send_hour').val,['14','15']);
    assert.equal(body.form_data.extra_form_data.time_range,body.queries[0].time_range);
  }
});

test('daily WeCom failure preserves valid IM and exposes errors',async()=>{
  const {data}=await query({failWecom:true});
  assert.equal(data.today.status,'partial');
  assert.match(data.today.errors['wecom.teacher'],/NO_ROWS/);
  assert.equal(buildServiceViews(data.today).teachers[0].im,80);
  assert.equal(buildServiceViews(data.today).teachers[0].wecom,null);
});

test('out-of-date rows cannot become today data',async()=>{
  const {data}=await query({wrongDate:true});
  assert.match(data.today.errors['im.teacher'],/DATE_MISMATCH/);
  assert.equal(buildServiceViews(data.today).teachers.length,0);
});

test('missing date constraint is rejected instead of querying all dates',async()=>{
  const {data,requests}=await query({missingDate:true});
  assert.match(data.__serviceError,/DATE_COLUMN_MISSING/);
  assert.equal(requests.length,0);
});

test('hourly call counts use weighted attempts instead of averaging rates',async()=>{
  const {data}=await query({callRows:true});
  const row=buildServiceViews(data.today).teachers[0];
  assert.equal(row.voiceDialCount,10);
  assert.equal(row.voiceConnectedCount,1);
  assert.equal(row.voiceConnectRate,10);
  assert.equal(row.videoDialCount,10);
  assert.equal(row.videoConnectedCount,9);
  assert.equal(row.videoConnectRate,90);
  assert.equal(row.callConnectedCount,10);
  assert.equal(data.today.im.teacher.callDiagnostics.sourceRows,2);
});

test('a missing phone column cannot become a successful zero-call refresh',async()=>{
  const {data}=await query({missingCalls:true});
  assert.match(data.__serviceError,/CALL_COLUMNS_MISSING/);
});
test('teacher summary and detail disagreement blocks the refresh',async()=>{
  const {data}=await query({callMismatch:true});
  assert.match(data.__serviceError,/CALL_RECONCILIATION_FAILED/);
});
test('truncated source data cannot become a successful partial refresh',async()=>{
  const {data}=await query({truncated:true});
  assert.match(data.__serviceError,/ROWS_TRUNCATED/);
});
test('zero attempts have zero connected calls instead of missing values',async()=>{
  const {data}=await query();
  const row=buildServiceViews(data.today).teachers[0];
  assert.equal(row.voiceConnectedCount,0);
  assert.equal(row.videoConnectedCount,0);
  assert.equal(data.today.im.teacher.callValidation.status,'matched');
});

test('positive attempts without a connection rate cannot become zero connected calls',async()=>{
  const {data}=await query({missingRate:true});
  assert.match(data.__serviceError,/CALL_VALUE_MISSING/);
});

 test('chart definitions are reused within a run without caching business data',async()=>{
  const {data,requests,definitionRequests}=await query();
  assert.equal(data.today.status,'ok');
  assert.equal(definitionRequests.length,new Set(definitionRequests).size);
  assert.ok(requests.some(body=>body.queries[0].time_range.startsWith(today)));
  assert.ok(requests.some(body=>!body.queries[0].time_range.startsWith(today)));
  assert.ok(requests.every(body=>body.force===true));
});

test('two successful empty teacher tables leave today pending rather than fabricate zero',async()=>{
 const {data}=await query({emptyToday:true});
 assert.equal(data.today.im.teacher.availability,'pending');
 assert.equal(data.today.im.teacher.callValidation.status,'empty-confirmed');
 assert.equal(data.today.im.teacher.rows.length,0);
 assert.equal(data.today.errors['im.teacher'],undefined);
 assert.equal(data.today.errors['im.group'],undefined);
 assert.equal(data.today.im.group.availability,'pending');
 assert.equal(data.today.status,'ok');
 assert.ok(data.im.teacher.rows.length>0);
 const daily=buildServiceViews(data.today);
 assert.ok(daily.teachers.every(row=>row.voiceDialCount==null&&row.videoDialCount==null));
});

test('temporary empty daily results are queried again and reconciled before acceptance',async()=>{
 const {data}=await query({transientEmpty:true});
 assert.equal(data.today.errors['im.teacher'],undefined);
 assert.equal(data.today.errors['im.group'],undefined);
 assert.equal(data.today.im.teacher.callValidation.status,'matched');
 assert.ok(data.today.im.teacher.rows.length>0);
});
