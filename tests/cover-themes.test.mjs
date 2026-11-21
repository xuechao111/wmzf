import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sibling=new URL('../../hyperframes-dashboard/index.html',import.meta.url);
const pages={main:fs.existsSync(sibling)?sibling:new URL('./fixtures/main-cover.html',import.meta.url),replica:new URL('../index.html',import.meta.url)};
function load(instance,store=new Map(),blocked=false){
 const html=fs.readFileSync(pages[instance],'utf8'),events={};
 const element=id=>({id,dataset:{},textContent:'',attributes:{},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(k,v){this.attributes[k]=v;},focus(){events.focus=id;}});
 const elements=Object.fromEntries(['coverThemeToggle','coverThemeDialog','coverThemeClose','coverThemeCurrent'].map(id=>[id,element(id)]));
 const options=['calm','sand','mist','original'].map(choice=>Object.assign(element(choice),{dataset:{coverChoice:choice}}));
 const dialog=elements.coverThemeDialog;
 dialog.querySelectorAll=()=>options;dialog.showModal=()=>events.open=true;dialog.close=()=>{events.open=false;dialog.listeners.close();};
 const document={documentElement:{dataset:{}},getElementById:id=>elements[id]};
 const localStorage={getItem:key=>{if(blocked)throw Error('disabled');return store.get(key)??null;},setItem:(key,value)=>{if(blocked)throw Error('disabled');store.set(key,value);}};
 const context=vm.createContext({document,localStorage});
 for(const id of ['cover-theme-init','cover-theme-controls']){
  const match=html.match(new RegExp('<script id="'+id+'">([\\s\\S]*?)</script>'));
  assert.ok(match);vm.runInContext(match[1],context);
 }
 return {html,document,elements,events,select:choice=>options.find(o=>o.dataset.coverChoice===choice).listeners.click(),options};
}

test('both covers default to the approved calm theme and expose four choices',()=>{
 for(const instance of Object.keys(pages)){
  const h=load(instance);assert.equal(h.document.documentElement.dataset.cover,'calm');assert.equal(h.options.length,4);
  h.elements.coverThemeToggle.listeners.click();assert.equal(h.events.open,true);
  h.elements.coverThemeClose.listeners.click();assert.equal(h.events.open,false);assert.equal(h.events.focus,'coverThemeToggle');
 }
});
test('themes persist per instance without touching other instance preferences',()=>{
 const store=new Map(),main=load('main',store),replica=load('replica',store);
 main.select('sand');replica.select('mist');
 assert.deepEqual([...store.keys()].sort(),['codemaoCoverTheme:main:8765','codemaoCoverTheme:replica:8766']);
 assert.equal(load('main',store).document.documentElement.dataset.cover,'sand');
 assert.equal(load('replica',store).document.documentElement.dataset.cover,'mist');
 replica.select('original');assert.equal(load('main',store).document.documentElement.dataset.cover,'sand');
 assert.equal(load('replica',store).document.documentElement.dataset.cover,'original');
});
test('previous main rollback selection migrates only to main',()=>{
 const store=new Map([['codemaoMainCoverTheme','original']]);
 assert.equal(load('main',store).document.documentElement.dataset.cover,'original');
 assert.equal(load('replica',store).document.documentElement.dataset.cover,'calm');
});
test('invalid saved themes and unavailable storage remain usable',()=>{
 const store=new Map([['codemaoCoverTheme:main:8765','bad-theme']]);
 assert.equal(load('main',store).document.documentElement.dataset.cover,'calm');
 const h=load('replica',new Map(),true);h.select('sand');assert.equal(h.document.documentElement.dataset.cover,'sand');
});
test('theme code has no network or cross-instance configuration side effects',()=>{
 for(const instance of Object.keys(pages)){
  const html=load(instance).html;
  const theme=html.match(/<script id="cover-theme-controls">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(theme,/fetch\(|extensionRequest|\/config|postMessage|876[56]\//);
 }
});
