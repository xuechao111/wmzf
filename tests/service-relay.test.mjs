import assert from "node:assert/strict";
import {decodeMcpResult} from "../sync-service-data.mjs";

const sheets=[{sheetId:"existing-sheet",name:"teaching-service"}];
assert.deepEqual(decodeMcpResult({result:{content:[{type:"text",text:JSON.stringify(sheets)}]}}),sheets);
assert.deepEqual(decodeMcpResult({result:{sheetId:"created-sheet"}}),{sheetId:"created-sheet"});
assert.throws(()=>decodeMcpResult({error:{code:-1,message:"denied"}}),/DINGTALK_MCP_ERROR/);
assert.throws(()=>decodeMcpResult({result:{content:[{type:"text",text:'{"success":false,"errorMsg":"denied"}'}]}}),/DINGTALK_TOOL_ERROR:denied/);
assert.throws(()=>decodeMcpResult({result:{isError:true,content:[{type:"text",text:'{"message":"failed"}'}]}}),/DINGTALK_TOOL_ERROR/);
console.log("SERVICE_RELAY_OK");
