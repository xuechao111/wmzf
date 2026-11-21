import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=name=>fs.readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const source=read('chrome-extension/background.js');
function listenerHarness(){
 let listener;const calls=[];
 const ctx={chrome:{runtime:{id:'replica-id',getManifest:()=>({version:'1.6.81'}),onMessage:{addListener:f=>listener=f}}},
   runScheduledUpdate:async(...args)=>calls.push(args),Date};
 vm.runInNewContext(source.slice(source.indexOf('chrome.runtime.onMessage.addListener(')),ctx);
 return {calls,send:(message,sender={})=>{let reply;listener(message,sender,r=>reply=r);return reply}};
}
test('dedicated connector does not claim main port permissions or content scripts',()=>{
 const manifest=JSON.parse(read('chrome-extension/manifest.json'));
 assert.ok(manifest.host_permissions.every(p=>!p.includes(':8765/')));
 assert.ok(manifest.content_scripts.every(s=>s.matches.every(p=>!p.includes(':8765/'))));
});
test('main and legacy messages cannot start a replica task',()=>{
 const h=listenerHarness();
 h.send({source:'codemao-dashboard',type:'run-scheduled-now',localBase:'http://127.0.0.1:8766'});
 const reply=h.send({source:'codemao-replica-dashboard',type:'run-scheduled-now',localBase:'http://127.0.0.1:8765'});
 assert.equal(reply.ok,false);assert.equal(h.calls.length,0);
});
test('forged origin and another connector identity cannot start a task',()=>{
 const h=listenerHarness(),message={source:'codemao-replica-dashboard',type:'run-scheduled-now',localBase:'http://127.0.0.1:8766'};
 assert.equal(h.send(message,{url:'http://127.0.0.1:8765/'}).ok,false);
 assert.equal(h.send({...message,connectorId:'another-id'}),undefined);
 assert.equal(h.calls.length,0);
});
test('selected dedicated connector starts exactly one manual task',()=>{
 const h=listenerHarness();
 const reply=h.send({source:'codemao-replica-dashboard',type:'run-scheduled-now',localBase:'http://127.0.0.1:8766',connectorId:'replica-id'},{url:'http://127.0.0.1:8766/'});
 assert.equal(reply.ok,true);assert.equal(h.calls.length,1);assert.match(h.calls[0][0],/^manual-/);
});
test('ping reports actual replica identity without starting work or leasing a relay',()=>{
 const h=listenerHarness(),reply=h.send({source:'codemao-replica-dashboard',type:'ping',localBase:'http://127.0.0.1:8766'});
 assert.equal(reply.instance,'replica');assert.equal(reply.port,8766);assert.equal(reply.extensionId,'replica-id');assert.equal(reply.version,'1.6.81');assert.equal(h.calls.length,0);
});
test('legacy alarms are cleared without starting a background update',async()=>{
 const code=source.slice(source.indexOf('chrome.alarms.onAlarm.addListener('),source.indexOf('chrome.runtime.onStartup'));
 let listener;const cleared=[];
 vm.runInNewContext(code,{chrome:{alarms:{onAlarm:{addListener:f=>listener=f},clear:async name=>cleared.push(name)}}});
 for(const name of ['codemao-update-half-hour','codemao-test-update-half-hour','unrelated'])await listener({name});
 assert.deepEqual(cleared,['codemao-update-half-hour','codemao-test-update-half-hour']);
});
test('bridge translates old replica pages and ignores unselected connector messages',()=>{
 const calls=[],events=[];let listener;
 const window={postMessage:message=>events.push(message),addEventListener:(_,f)=>listener=f};
 const chrome={runtime:{id:'selected',sendMessage:(message,callback)=>{calls.push(message);callback({ok:true})}}};
 vm.runInNewContext(read('chrome-extension/bridge.js'),{window,chrome,location:{origin:'http://127.0.0.1:8766'}});
 for(const data of [{source:'codemao-dashboard',id:'1'},{source:'codemao-replica-dashboard',id:'2',connectorId:'other'},{source:'codemao-replica-dashboard',id:'3',connectorId:'selected'}])listener({source:window,data});
 assert.equal(calls.length,2);assert.equal(calls[0].source,'codemao-replica-dashboard');assert.equal(calls[1].id,'3');assert.equal(calls[0].localBase,'http://127.0.0.1:8766');
 assert.equal(events.at(-1).source,'codemao-replica-extension');
});
test('reinjecting the bridge replaces stale listeners without duplicating requests',()=>{
 const listeners=new Set(),calls=[];const old=()=>{throw Error('stale listener must be removed')};listeners.add(old);
 const window={postMessage(){},addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f)};
 const ctx=vm.createContext({window,location:{origin:'http://127.0.0.1:8766'},chrome:{runtime:{id:'id',sendMessage:(message,cb)=>{calls.push(message);cb({ok:true})}}},__codemaoReplicaBridgeInstalled:{version:'old',listener:old,extensionId:'id'}});
 vm.runInContext(read('chrome-extension/bridge.js'),ctx);vm.runInContext(read('chrome-extension/bridge.js'),ctx);
 assert.equal(listeners.size,1);
 for(const listener of listeners)listener({source:window,data:{source:'codemao-replica-dashboard',id:'single'}});
 assert.equal(calls.length,1);
});
test('bridge never installs on main8765 even for legacy page compatibility',()=>{
 let installed=false;
 vm.runInNewContext(read('chrome-extension/bridge.js'),{location:{origin:'http://127.0.0.1:8765'},window:{addEventListener(){installed=true}}});
 assert.equal(installed,false);
});
test('invalidated extension context returns an actionable response instead of timing out',()=>{
 let listener,reply;
 const window={postMessage:r=>reply=r,addEventListener:(_,f)=>listener=f};
 vm.runInNewContext(read('chrome-extension/bridge.js'),{location:{origin:'http://127.0.0.1:8766'},window,chrome:{runtime:{id:'id',sendMessage(){throw Error('Extension context invalidated')}}}});
 listener({source:window,data:{source:'codemao-replica-dashboard',id:'request'}});
 assert.equal(reply.ok,false);assert.match(reply.error,/Ctrl\+F5/);assert.equal(reply.id,'request');
});
