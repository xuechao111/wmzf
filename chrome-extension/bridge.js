if(!globalThis.__codemaoDashboardBridgeInstalled){
  globalThis.__codemaoDashboardBridgeInstalled=true;
  window.postMessage({source:"codemao-crm-extension",type:"ready"},"*");
  window.addEventListener("message",event=>{
    const message=event.data;
    if(event.source!==window||message?.source!=="codemao-dashboard"||!message.id)return;
    const relay=(attempt=0)=>chrome.runtime.sendMessage(message,response=>{
      const runtimeError=chrome.runtime.lastError?.message;
      if(runtimeError&&attempt<2){setTimeout(()=>relay(attempt+1),600*(attempt+1));return;}
      window.postMessage({source:"codemao-crm-extension",id:message.id,...(response||{ok:false,error:runtimeError||"连接器服务暂时不可用，请稍后重试"})},"*");
    });
    relay();
  });
}
