import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('        const termCatalogs=new Map();'),source.indexOf('        const classBlocks=await mapLimit'));
const create=api=>vm.runInNewContext(`(()=>{${code};return getTermCatalog;})()`,{api});
test('catalog requests share only the same term within one collection',async()=>{
 const calls=[];const api=async url=>{calls.push(url);return {data:[{course_id:calls.length}]};};
 const first=create(api);
 const [a,b,c]=await Promise.all([first(1),first(1),first(2)]);
 assert.strictEqual(a,b);assert.notStrictEqual(a,c);assert.equal(calls.length,2);
 await create(api)(1);assert.equal(calls.length,3);
});
test('failed catalog requests are evicted and can be retried',async()=>{
 let count=0;const fetch=create(async()=>{if(++count===1)throw Error('transient');return {data:[]};});
 await assert.rejects(fetch(1),/transient/);await fetch(1);assert.equal(count,2);
});
