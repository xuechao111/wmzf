import fs from "node:fs";

const port = Number(process.argv[2] || 9223);
const classFile = process.argv[3];
const outFile = process.argv[4];
if (!classFile || !outFile) throw new Error("Usage: fetch_group_via_extension.mjs <port> <classes.json> <output.json>");

const classes = JSON.parse(fs.readFileSync(classFile, "utf8"));
const listTargets = async () => await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function selectWorker(targets){
  const matches=[];
  for(const target of targets.filter(t=>t.type==="service_worker"&&/^chrome-extension:\/\//.test(t.url||""))){
    let probe;
    try{
      probe=new WebSocket(target.webSocketDebuggerUrl);
      const identity=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error("connector identity timeout")),3000);
        probe.addEventListener("open",()=>probe.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression:"JSON.stringify(chrome.runtime.getManifest())",returnByValue:true}})),{once:true});
        probe.addEventListener("message",event=>{const msg=JSON.parse(event.data);if(msg.id===1){clearTimeout(timer);resolve(JSON.parse(msg.result?.result?.value||"{}"));}});
        probe.addEventListener("error",()=>{clearTimeout(timer);reject(Error("connector unavailable"));},{once:true});
      });
      if(identity.name==="编程猫副本工作台连接器"&&identity.host_permissions?.some(p=>p.includes(":8766/"))&&!identity.host_permissions.some(p=>p.includes(":8765/")))matches.push(target);
    }catch{}finally{probe?.close();}
  }
  if(matches.length>1)throw Error("多个同类连接器，请仅保留一个当前工作台专用连接器");
  return matches[0];
}

let targets = await listTargets();
let worker = await selectWorker(targets);
if (!worker) {
  const localPage = targets.find(target => target.type === "page" && /^http:\/\/(127\.0\.0\.1|localhost):8766\//.test(String(target.url || "")));
  if (localPage?.webSocketDebuggerUrl) {
    const wakeSocket = new WebSocket(localPage.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      wakeSocket.addEventListener("open", resolve, { once: true });
      wakeSocket.addEventListener("error", event => reject(event.error || new Error("Local dashboard connection failed")), { once: true });
    });
    wakeSocket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `window.postMessage({source:"codemao-replica-dashboard",id:"wake-${Date.now()}",type:"ping"},"*")` } }));
    await new Promise(resolve => setTimeout(resolve, 1200));
    wakeSocket.close();
    targets = await listTargets();
    worker = await selectWorker(targets);
  }
}
if (!worker?.webSocketDebuggerUrl) throw new Error("CRM connector service worker not found on debug port");

const socket = new WebSocket(worker.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Connector service worker connection timed out")), 10000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", event => { clearTimeout(timer); reject(event.error || new Error("Connector service worker connection failed")); }, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const item = pending.get(message.id);
  pending.delete(message.id);
  message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
});
function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const expression = `(async()=>{
  if(typeof fetchInCrm!=="function")return {ok:false,error:"Installed connector does not expose fetchInCrm"};
  return await fetchInCrm(${JSON.stringify(classes)},["薛超"],0,"http://127.0.0.1:8766");
})()`;
const evaluated = await Promise.race([
  send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("CRM connector fetch exceeded 6 minutes")), 360000)),
]);
socket.close();
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "Connector evaluation failed");
const result = evaluated.result?.value;
if (!result?.ok || !result.data) throw new Error(result?.error || "CRM connector returned empty data");
const blocks = JSON.parse(result.data);
const liveBlocks = blocks.filter(block => Object.keys(block.liveAttendance || {}).length > 0).length;
// Empty live-room data is valid before broadcast; the snapshot marks it pending.
if (blocks.some(block => String(block.info?.teacherName || "").includes("�"))) throw new Error("CRM connector returned invalid Chinese text");
fs.writeFileSync(outFile, result.data, "utf8");
console.log(JSON.stringify({ blocks: blocks.length, liveBlocks, output: outFile }));
