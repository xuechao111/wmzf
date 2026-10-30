import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const weekFunction=source.match(/const openedWeek=seconds=>[^;]+;/)[0];
const selection=source.slice(source.indexOf('const opened=lessons.filter'),source.indexOf('const courseIds=selected.map'));
const lesson=(date,id)=>({unlock_time:Date.parse(`${date}T19:20:00+08:00`)/1000,course_id:id});
function select(now,lessons){
  const context={lessons,nowSec:Date.parse(now)/1000,windowStart:Infinity};
  return vm.runInNewContext(`${weekFunction}\n${selection}\nselected.map(x=>x.course_id).join(',')`,context);
}
const lessons=[lesson('2026-09-26',1),lesson('2026-10-10',2),lesson('2026-10-17',3)];
assert.equal(select('2026-10-12T12:00:00+08:00',lessons),'1,2');
assert.equal(select('2026-10-18T12:00:00+08:00',lessons),'2,3');
assert.equal(select('2026-10-11T23:00:00+08:00',lessons),'1,2');
console.log('OPENED_WEEKS_OK (holiday, new week, Sunday)');
