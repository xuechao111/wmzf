import fs from "node:fs";

const port = Number(process.argv[2] || 9222);
const classFile = process.argv[3];
const outFile = process.argv[4];
if (!classFile || !outFile) throw new Error("Usage: fetch_group_via_extension.mjs <port> <classes.json> <output.json>");

const classes = JSON.parse(fs.readFileSync(classFile, "utf8"));
const listTargets = async () => await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let targets = await listTargets();
let worker = targets.find(target => target.type === "service_worker" && /^chrome-extension:\/\//.test(String(target.url || "")));
if (!worker) {
  const localPage = targets.find(target => target.type === "page" && /^http:\/\/(127\.0\.0\.1|localhost):876[56]\//.test(String(target.url || "")));
  if (localPage?.webSocketDebuggerUrl) {
    const wakeSocket = new WebSocket(localPage.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      wakeSocket.addEventListener("open", resolve, { once: true });
      wakeSocket.addEventListener("error", event => reject(event.error || new Error("Local dashboard connection failed")), { once: true });
    });
    wakeSocket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `window.postMessage({source:"codemao-dashboard",id:"wake-${Date.now()}",type:"ping"},"*")` } }));
    await new Promise(resolve => setTimeout(resolve, 1200));
    wakeSocket.close();
    targets = await listTargets();
    worker = targets.find(target => target.type === "service_worker" && /^chrome-extension:\/\//.test(String(target.url || "")));
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
  return await fetchInCrm(${JSON.stringify(classes)},["薛超"],0,"http://127.0.0.1:8765");
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
if (!liveBlocks) throw new Error("CRM connector returned no live attendance boards");
if (blocks.some(block => String(block.info?.teacherName || "").includes("�"))) throw new Error("CRM connector returned invalid Chinese text");
fs.writeFileSync(outFile, result.data, "utf8");
console.log(JSON.stringify({ blocks: blocks.length, liveBlocks, output: outFile }));
