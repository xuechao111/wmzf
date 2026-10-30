import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function liveSlotBreakdown('),source.indexOf('  function openLiveSlots('));
const context={};vm.runInNewContext(code,context);
test('slot grouping isolates teacher and cohort and propagates unverified sources',()=>{
 const row=(teacher,cohort,slot,a,e,f=0)=>({teacher,cohort,slot,current:{liveAttend:a,liveExpected:e,detailLiveFallbacks:f}});
 const slots=context.liveSlotBreakdown([row('A','W1','周五晚',8,10),row('A','W1','周五晚',4,5,1),row('A','W1','周六午',3,6),row('A','W2','周五晚',99,100),row('B','W1','周五晚',99,100)],'A','W1');
 assert.equal(slots.length,3);assert.equal(slots[0].attend,12);assert.equal(slots[0].expected,15);assert.equal(slots[0].unverified,true);assert.equal(slots[1].unverified,false);assert.equal(slots[2].expected,0);
});
