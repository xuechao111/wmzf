import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('  function liveMetricsPending('),source.indexOf('  function liveSlotBreakdown('));
const overview=source.slice(source.indexOf('  function overviewSortValue('),source.indexOf('  function addTimeInput('));
const team=source.slice(source.indexOf('  function renderTeamBoard('),source.indexOf('  let overviewTeachers='));
const analysis=source.slice(source.lastIndexOf('  function renderAnalysis('),source.indexOf('  function overviewList('));
const metrics=(pending=false)=>({livePending:pending,liveExpected:100,liveAttend:pending?50:0,liveRate:pending?null:0,replayRate:pending?null:0,evenExpected:100,evenDone:90,finishRate:.9,incompleteStudents:10,arrivalExpected:100,arrivalAttend:95,arrivalRate:.95,liveAbsentStudents:pending?50:100,replayStudents:0,arrivedIncompleteStudents:5});
function runtime(pending=true){
 const elements=new Map(), $=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',scrollTo(){}});return elements.get(id)},pct=v=>(Number(v||0)*100).toFixed(1)+'%',optionalPct=v=>v==null?'—':pct(v);
 const row={teacher:'Teacher A',cohort:'W1',coursePackage:'进阶',current:metrics(pending),previous:metrics(false),service:{groupName:'G'},dailyMakeup:{count:0,students:[]},timelyLiveComparison:{livePending:pending,hasBaseline:!pending,previousExpected:100,previousAttend:0,currentAttend:50,currentExpected:100,gap:pending?null:0}};
 const context={$, $$:()=>[],pct,optionalPct,gapPct:v=>v==null?'—':pct(v),gapTone:()=>'',esc:v=>String(v??''),analysisData:{rows:[row],classes:[{...row,classId:1,slot:'周五晚',className:'C1'}],weeks:{current:'W1',previous:'W0'},cohorts:['W1'],summary:{teachers:1,classes:1,finishRate:.9,liveRate:null,replayRate:null},groupDaily:{date:'2026-10-30'}},overviewPackage:'进阶',overviewCohort:'all',overviewTeachers:null,overviewSortKey:'liveRate',overviewSortDirection:'desc',overviewSortFields:[],teacherGroupName:()=> 'G',teacherPicker:()=>'',bindTeacherPicker:()=>{},teamCohort:'all',teamTeachers:null,teamSortKey:'liveCurrent',teamSortDirection:'desc',teamSortFields:[],compareTeamRows:()=>0,analysisCohort:'all',analysisMode:'live',analysisRisk:()=>[],openTeacher:'',copyIds(){}};
 vm.createContext(context);vm.runInContext(helpers+overview+team+analysis,context);return {context,html:()=>$('#tableWrap').innerHTML};
}
test('pending live data renders as pending while completion and arrival still render',()=>{
 const {context,html}=runtime();context.renderOverview();assert.match(html(),/待更新/);assert.match(html(),/90\.0%/);assert.match(html(),/95\.0%/);assert.doesNotMatch(html(),/50 \/ 100 人次/);
 context.renderTeamBoard();assert.match(html(),/直播记录待更新/);assert.match(html(),/team-metric-finish[^]*?90\.0%/);assert.doesNotMatch(html(),/50\/100 人次/);
 context.renderAnalysis();assert.match(html(),/待更新/);assert.match(html(),/90\.0%/);
});
test('verified zero live attendance remains a genuine zero, not pending',()=>{
 const {context,html}=runtime(false);context.renderOverview();assert.match(html(),/0\.0%/);assert.doesNotMatch(html(),/待更新/);assert.match(html(),/0 \/ 100 人次/);
});
test('missing room and unverified fallback flags also suppress live rates and sorting',()=>{
 const {context}=runtime(false);for(const flag of ['missingLiveBoards','detailLiveFallbacks','livePending']){const row={current:{liveRate:.99,[flag]:1}};assert.equal(context.livePercent(row.current),'待更新');assert.equal(context.overviewSortValue(row,'liveRate'),null)}
});
