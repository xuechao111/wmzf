import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const file of ['chrome-extension/background.js', 'scripts/fetch_group_lessons.mjs']) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g,'\n');
  const start = source.indexOf('let pageNo=1,pairItemCount=0;');
  const end = source.indexOf('\n          }\n          const merged=', start);
  const fallbackEnd = source.indexOf('\n  }\n  const merged=', start);
  assert.ok(start >= 0);
  const loop = source.slice(start, end >= 0 ? end : fallbackEnd);
  const run = api => vm.runInNewContext(`(async()=>{${loop};return items;})()`, {
    api, items: [], ids: [1,2], openCourseList: [], termId: 1, classId: 2,
    pageSize: 100, offset: 0, console: {log(){}}, setTimeout,
  });

  for (const [total, actualSize] of [[250,100],[250,80],[100,100],[0,100]]) {
    test(`${file}: collects all ${total} rows with ${actualSize} returned per page`, async()=>{
      const pages=[];
      const rows=await run(async url=>{
        const u=new URL(url),page=Number(u.searchParams.get('page'));
        assert.equal(Number(u.searchParams.get('limit')),100);
        pages.push(page);
        return {data:{total,items:Array.from({length:Math.max(0,Math.min(actualSize,total-(page-1)*actualSize))},(_,i)=>({id:(page-1)*actualSize+i}))}};
      });
      assert.equal(rows.length,total);
      assert.equal(new Set(rows.map(r=>r.id)).size,total);
      assert.equal(pages.length,Math.max(1,Math.ceil(total/actualSize)));
    });
  }
  test(`${file}: rejects an empty page before reaching the reported total`, async()=>{
    await assert.rejects(run(async()=>({data:{total:250,items:[]}})),/CRM_DETAIL_INCOMPLETE/);
  });
  test(`${file}: rejects malformed results`, async()=>{
    await assert.rejects(run(async()=>({data:{total:'invalid',items:[]}})),/CRM_DETAIL_INVALID/);
  });
}
