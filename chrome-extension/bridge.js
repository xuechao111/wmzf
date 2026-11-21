// Dedicated bridge also understands old replica pages, but never runs on8765.
if(/^http:\/\/(127\.0\.0\.1|localhost):8766$/.test(location.origin)){
  const key="__codemaoReplicaBridgeInstalled",version="1.6.81";
  const previous=globalThis[key];
  if(!previous||previous.version!==version||previous.extensionId!==chrome.runtime.id){
    if(previous?.listener)window.removeEventListener("message",previous.listener);
    const listener=event=>{
      const input=event.data;
      if(event.source!==window||!input?.id||!["codemao-replica-dashboard","codemao-dashboard"].includes(input.source))return;
      if(input.connectorId&&input.connectorId!==chrome.runtime.id)return;
      const message={...input,source:"codemao-replica-dashboard",localBase:location.origin};
      const replySource=input.source==="codemao-dashboard"?"codemao-crm-extension":"codemao-replica-extension";
      const relay=(attempt=0)=>{
        try{chrome.runtime.sendMessage(message,response=>{
          const runtimeError=chrome.runtime.lastError?.message;
          if(runtimeError&&attempt<2){setTimeout(()=>relay(attempt+1),600*(attempt+1));return;}
          window.postMessage({source:replySource,id:message.id,...(response||{ok:false,error:runtimeError||"副本连接器服务暂时不可用，请刷新页面后重试"})},"*");
        });}catch{window.postMessage({source:replySource,id:message.id,ok:false,error:"副本连接器已重新加载，请按Ctrl+F5刷新此页"},"*");}
      };
      relay();
    };
    globalThis[key]={version,extensionId:chrome.runtime.id,listener};
    window.addEventListener("message",listener);
    window.postMessage({source:"codemao-replica-extension",type:"ready"},"*");
  }
}
