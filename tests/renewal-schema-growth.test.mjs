import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const text=fs.readFileSync(new URL('../sync-renewal-table.mjs',import.meta.url),'utf8');
const code=text.slice(text.indexOf('function normalizeText('),text.indexOf('function normalizeWorkbookUrl('));
const scope={};vm.createContext(scope);vm.runInContext(code,scope);
test('40-column source projects by name onto existing 39-column workbook, ignoring extra CRM field',()=>{
 const headers=Array.from({length:39},(_,i)=>`column${i}`);
 const row=Object.fromEntries(headers.map((h,i)=>[h,i]));
 const source=scope.normalizeSourceHeaders({headers:[...headers.slice(0,28),'is_page_get_coupon',...headers.slice(28)],rows:[{...row,is_page_get_coupon:1}]});
 const rows=scope.projectTargetRows(source,[...headers].reverse());
 assert.equal(Object.keys(rows[0]).length,39);
 for(const h of headers)assert.equal(rows[0][h],row[h]);
 assert.equal(rows[0].is_page_get_coupon,undefined);
});
test('additional future source fields do not invalidate populated target layout',()=>{
 const source=scope.normalizeSourceHeaders({headers:['用户ID','续费月份','future'],rows:[{'用户ID':17,'续费月份':'2027-01-01',future:'extra'}]});
 assert.equal(scope.projectTargetRows(source,['续费月份','用户ID'])[0]['用户ID'],17);
});
test('missing target columns still stop instead of shifting data or inventing blanks',()=>{
 assert.throws(()=>scope.projectTargetRows({headers:['用户ID'],rows:[{'用户ID':17}]},['用户ID','续费月份']),/CRM_MISSING_TARGET_COLUMNS:续费月份/);
});

test('missing-column diagnostic contains exact headers without learner values',()=>{
 let error;
 try { scope.projectTargetRows({headers:['用户ID'],rows:[{'用户ID':'private-learner'}]},['用户ID','自定义字段']); }
 catch (caught) { error=caught; }
 assert.deepEqual(JSON.parse(JSON.stringify(error.schema)),{
  sourceHeaders:['用户ID'],targetHeaders:['用户ID','自定义字段'],missingTargetHeaders:['自定义字段'],
 });
 assert.ok(!JSON.stringify(error.schema).includes('private-learner'));
});
test('empty and duplicate source names remain rejected',()=>{
 for(const headers of [[],['用户ID',''],['用户ID',' 用户ID ']])assert.throws(()=>scope.normalizeSourceHeaders({headers,rows:[]}),/CRM_HEADERS_INVALID/);
});
