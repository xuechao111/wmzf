import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const main=new URL('../../hyperframes-dashboard/index.html',import.meta.url);
const pages={main:fs.existsSync(main)?main:new URL('./fixtures/main-cover.html',import.meta.url),replica:new URL('../index.html',import.meta.url)};
function load(instance,store=new Map(),blocked=false){
 const html=fs.readFileSync(pages[instance],'utf8');
 const element=id=>({id,dataset:{},listeners:{},attributes:{},hidden:false,src:'',alt:'',textContent:'',addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(k,v){this.attributes[k]=v;}});
 const ids=['coverCompanion','coverThemeDialog','coverCharacterImage','coverCharacterTitle','coverCharacterNote','coverCharacterStatus','coverCharacterChange'];
 const elements=Object.fromEntries(ids.map(id=>[id,element(id)]));
 const options=['champion','gift','reader','graduate','celebrate','none'].map(key=>Object.assign(element(key),{dataset:{coverCharacter:key}}));
 const thumbs=options.slice(0,5).map(option=>Object.assign(element('thumb'),{dataset:{characterThumb:option.dataset.coverCharacter}}));
 elements.coverThemeDialog.querySelectorAll=selector=>selector==='[data-character-thumb]'?thumbs:options;
 const localStorage={getItem:key=>{if(blocked)throw Error('blocked');return store.get(key)??null;},setItem:(key,value)=>{if(blocked)throw Error('blocked');store.set(key,value);}};
 const code=html.match(/<script id="cover-character-controls">([\s\S]*?)<\/script>/)[1];
 const styles={},root={dataset:{},style:{setProperty:(key,value)=>styles[key]=value}};
 vm.runInNewContext(code,{document:{getElementById:id=>elements[id],documentElement:root,querySelectorAll:()=>[]},localStorage});
 return {elements,thumbs,options,code,root,styles,select:key=>options.find(o=>o.dataset.coverCharacter===key).listeners.click()};
}
test('five local images can be chosen and the sixth option hides the character',()=>{
 for(const instance of Object.keys(pages)){
  const h=load(instance);assert.equal(h.thumbs.length,5);
  for(const key of ['champion','gift','reader','graduate','celebrate']){
   h.select(key);assert.equal(h.elements.coverCompanion.hidden,false);
   assert.ok(h.elements.coverCharacterImage.src.startsWith('data:image/jpeg;base64,'));
   assert.ok(h.elements.coverCharacterTitle.textContent);assert.ok(h.elements.coverCharacterImage.alt);
  }
  assert.equal(new Set(h.thumbs.map(t=>t.src)).size,5);
  h.select('none');assert.equal(h.elements.coverCompanion.hidden,true);
 }
});
test('main and replica character selections persist independently of color theme',()=>{
 const store=new Map([['codemaoCoverTheme:main:8765','sand']]);
 load('main',store).select('graduate');load('replica',store).select('reader');
 assert.equal(load('main',store).elements.coverCharacterImage.alt,'毕业伙伴');
 assert.equal(load('replica',store).elements.coverCharacterImage.alt,'阅读伙伴');
 load('replica',store).select('none');assert.equal(load('replica',store).elements.coverCompanion.hidden,true);
 assert.equal(load('main',store).elements.coverCharacterImage.alt,'毕业伙伴');
 assert.equal(store.get('codemaoCoverTheme:main:8765'),'sand');
});
test('invalid preferences, disabled storage and failed images do not break the dashboard',()=>{
 const store=new Map([['codemaoCoverCharacter:replica:8766','malicious-value']]);
 assert.equal(load('replica',store).elements.coverCharacterImage.alt,'冠军伙伴');
 const h=load('main',new Map(),true);h.select('gift');assert.equal(h.elements.coverCharacterImage.alt,'惊喜伙伴');
 h.elements.coverCharacterImage.listeners.error();assert.equal(h.elements.coverCompanion.hidden,true);
 assert.match(h.elements.coverCharacterStatus.textContent,/暂不可用/);
});
test('character changes never request CRM, document writes, or another instance',()=>{
 for(const instance of Object.keys(pages))assert.doesNotMatch(load(instance).code,/fetch\(|extensionRequest|postMessage|https?:\/\/|\/config/);
});
test('all pages share the selected character and hiding removes decorations everywhere',()=>{
 for(const instance of Object.keys(pages)){
  const h=load(instance);assert.equal(h.root.dataset.workspaceCharacter,'on');
  h.select('graduate');assert.equal(h.styles['--workspace-character-image'],'url("'+h.elements.coverCharacterImage.src+'")');
  h.select('none');assert.equal(h.root.dataset.workspaceCharacter,'off');assert.equal(h.styles['--workspace-character-image'],'none');
  h.select('reader');assert.equal(h.root.dataset.workspaceCharacter,'on');
  h.elements.coverCharacterImage.listeners.error();assert.equal(h.root.dataset.workspaceCharacter,'off');
 }
});
test('visual changes preserve every existing data and workflow script',()=>{
 // Decorative hooks must not target data cells, change sort order or install data observers.
 for(const instance of Object.keys(pages))assert.doesNotMatch(load(instance).code,/\.team-table|tbody|MutationObserver|setInterval|\.sort\(/);
});
