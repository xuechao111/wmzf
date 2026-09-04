import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const DASHBOARD_CONFIG=path.join(process.env.HF_DASHBOARD_ROOT||path.dirname(fileURLToPath(import.meta.url)),"dashboard-config.json");
const DASHBOARD_SETTINGS=(()=>{try{return JSON.parse(fs.readFileSync(DASHBOARD_CONFIG,"utf8"))}catch{return {}}})();
const WORKBOOK = DASHBOARD_SETTINGS.renewalWorkbookUrl || "";
const CONFIGURED_SHEET_ID = DASHBOARD_SETTINGS.renewalSheetId || "";
const TARGET_SHEET_NAME = "\u5956\u5b66\u91d1\u660e\u7ec6";
const TARGET_END_COLUMN = "AM";
const EXPECTED_COLUMN_COUNT = 39;
const FILTERS = {"续费月份":"2026-08-01","续费节点":"首续","战队":"深圳战区"};
const REQUIRED_COLUMNS = ["续费月份","用户ID","用户姓名","战区","战队","续费节点"];
const CREDENTIAL_FILES = [
  process.env.CODEMAO_SCHOLARSHIP_CREDENTIALS_FILE,
  "C:/Users/user/Desktop/Documents/编程猫管理skill/codemao-student-profile-extracted/codemao-course-data/sync.py",
].filter(Boolean);

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g," ").trim();
}

function normalizeDate(value) {
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value ?? "").trim())) {
    const number = Number(value), milliseconds = number < 100000000000 ? number * 1000 : number;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0,10);
  }
  const text = normalizeText(value).replace(/\//g,"-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2,"0")}-${match[3].padStart(2,"0")}` : text;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g,'""')}"` : text;
}

function matrixToCsv(matrix) {
  return matrix.map(row => row.map(csvEscape).join(",")).join("\r\n");
}

function validateSource(headers,rows) {
  const missing = REQUIRED_COLUMNS.filter(column => !headers.includes(column));
  if (missing.length) throw new Error(`CRM_MISSING_REQUIRED_COLUMNS:${missing.join("|")}`);
  if (!rows.length) throw new Error("CRM_SOURCE_EMPTY");
  for (const row of rows) {
    if (normalizeDate(row["续费月份"]) !== FILTERS["续费月份"]) throw new Error(`CRM_FILTER_MISMATCH:续费月份:${row["续费月份"]}`);
    if (normalizeText(row["续费节点"]) !== FILTERS["续费节点"]) throw new Error(`CRM_FILTER_MISMATCH:续费节点:${row["续费节点"]}`);
    if (normalizeText(row["战队"]) !== FILTERS["战队"]) throw new Error(`CRM_FILTER_MISMATCH:战队:${row["战队"]}`);
    if (!normalizeText(row["用户ID"])) throw new Error("CRM_USER_ID_EMPTY");
  }
  const fingerprints = rows.map(row => JSON.stringify(headers.map(header => row[header] ?? "")));
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("CRM_EXACT_ROW_DUPLICATED");
}

function readMcpCredentials() {
  if (DASHBOARD_SETTINGS.dingtalkConnectionUrl) {
    return {url:DASHBOARD_SETTINGS.dingtalkConnectionUrl,token:DASHBOARD_SETTINGS.dingtalkAccessKey || ""};
  }
  const file = CREDENTIAL_FILES.find(candidate => fs.existsSync(candidate));
  if (!file) throw new Error("DINGTALK_MCP_CONFIG_NOT_FOUND");
  const text = fs.readFileSync(file,"utf8");
  const url = text.match(/MCP_URL\s*=\s*["']([^"']+)["']/)?.[1];
  const token = text.match(/ACCESS_TOKEN\s*=\s*["']([^"']+)["']/)?.[1];
  if (!url) throw new Error("DINGTALK_MCP_CONFIG_INVALID");
  return {url,token:token || ""};
}

async function mcpCall(name,args,timeoutMs=180000) {
  const {url,token} = readMcpCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),timeoutMs);
  try {
    const headers = {"content-type":"application/json","accept":"application/json"};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",method:"tools/call",params:{name,arguments:args},id:1}),signal:controller.signal});
    if (!response.ok) throw new Error(`DINGTALK_MCP_HTTP_${response.status}`);
    const envelope = await response.json();
    if (envelope.error) throw new Error(`DINGTALK_MCP_ERROR:${JSON.stringify(envelope.error)}`);
    const text = envelope.result?.content?.find(item => item.type === "text")?.text;
    const result = text ? JSON.parse(text) : envelope.result;
    if (result?.success === false) throw new Error(`DINGTALK_TOOL_ERROR:${result.errorMsg || JSON.stringify(result)}`);
    return result;
  } finally { clearTimeout(timer); }
}

function findRows(value) {
  if (Array.isArray(value) && (!value.length || Array.isArray(value[0]))) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["values","data","rows","displayValues"]) if (Array.isArray(value[key]) && (!value[key].length || Array.isArray(value[key][0]))) return value[key];
  for (const child of Object.values(value)) { const rows=findRows(child); if (rows) return rows; }
  return null;
}

async function writeAndVerify(source) {
  const sheetId = await resolveTargetSheetId();
  const headerResult = await mcpCall("get_range",{nodeId:WORKBOOK,sheetId,range:`A1:${TARGET_END_COLUMN}1`});
  const targetHeaders = (findRows(headerResult)?.[0] || []).map(normalizeText);
  if (targetHeaders.length !== EXPECTED_COLUMN_COUNT || targetHeaders.some(header => !header)) throw new Error(`DINGTALK_HEADER_INVALID:${targetHeaders.length}`);
  const missing = targetHeaders.filter(header => !source.headers.includes(header));
  if (missing.length) throw new Error(`CRM_MISSING_TARGET_COLUMNS:${missing.join("|")}`);
  const tableRows = source.rows.map(row => Object.fromEntries(targetHeaders.map(header => [header,row[header] ?? ""])));
  validateSource(targetHeaders,tableRows);
  const infoBefore = await mcpCall("get_sheet",{nodeId:WORKBOOK,sheetId});
  const previousLastRow = Number(infoBefore.nonEmptyRange?.lastRow || (Number(infoBefore.lastNonEmptyRow)+1) || 1);
  const matrix = [targetHeaders,...tableRows.map(row => targetHeaders.map(header => row[header] ?? ""))];
  for (let start=0;start<matrix.length;start+=600) {
    const chunk=matrix.slice(start,start+600);
    await mcpCall("set_range_from_csv",{nodeId:WORKBOOK,sheetId,startCell:`A${start+1}`,csv:matrixToCsv(chunk),allowOverwrite:true});
  }
  const newLastRow=tableRows.length+1;
  if (previousLastRow>newLastRow) await mcpCall("clear_range",{nodeId:WORKBOOK,sheetId,range:`A${newLastRow+1}:${TARGET_END_COLUMN}${previousLastRow}`,type:"content"});
  const infoAfter=await mcpCall("get_sheet",{nodeId:WORKBOOK,sheetId});
  const verify=await Promise.all([
    mcpCall("get_range",{nodeId:WORKBOOK,sheetId,range:`A1:${TARGET_END_COLUMN}2`}),
    mcpCall("get_range",{nodeId:WORKBOOK,sheetId,range:`A${newLastRow}:${TARGET_END_COLUMN}${newLastRow}`}),
  ]);
  const top=findRows(verify[0])||[],bottom=findRows(verify[1])||[];
  if (JSON.stringify((top[0]||[]).map(normalizeText))!==JSON.stringify(targetHeaders)) throw new Error("VERIFY_HEADER_MISMATCH");
  const idIndex=targetHeaders.indexOf("用户ID");
  if (normalizeText(top[1]?.[idIndex])!==normalizeText(tableRows[0]["用户ID"])) throw new Error("VERIFY_FIRST_USER_MISMATCH");
  if (normalizeText(bottom[0]?.[idIndex])!==normalizeText(tableRows.at(-1)["用户ID"])) throw new Error("VERIFY_LAST_USER_MISMATCH");
  const actualLast=Number(infoAfter.nonEmptyRange?.lastRow || (Number(infoAfter.lastNonEmptyRow)+1) || 0);
  if (actualLast!==newLastRow) throw new Error(`VERIFY_ROW_COUNT_MISMATCH:${actualLast}/${newLastRow}`);
  return {rows:tableRows.length,lastRow:actualLast};
}

async function resolveTargetSheetId() {
  if (CONFIGURED_SHEET_ID) return CONFIGURED_SHEET_ID;
  const listing=await mcpCall("get_all_sheets",{nodeId:WORKBOOK});
  const sheets=Array.isArray(listing)?listing:(listing?.sheets||listing?.data?.sheets||[]);
  const target=sheets.find(sheet=>normalizeText(sheet?.name)===TARGET_SHEET_NAME);
  if (!target) throw new Error(`DINGTALK_RENEWAL_DETAIL_SHEET_NOT_FOUND:${TARGET_SHEET_NAME}`);
  return target.sheetId||target.name;
}

async function updateDashboardTimestamp() {
  const listing=await mcpCall("get_all_sheets",{nodeId:WORKBOOK});
  const sheets=Array.isArray(listing)?listing:(listing?.sheets||listing?.data?.sheets||[]);
  const dashboard=sheets.find(sheet=>normalizeText(sheet?.name)==="续费看板");
  if (!dashboard) throw new Error("DINGTALK_RENEWAL_DASHBOARD_NOT_FOUND");
  const sheetId=dashboard.sheetId||dashboard.name;
  const timestamp=new Date().toLocaleString("sv-SE",{timeZone:"Asia/Shanghai",hour12:false});
  const value=`最新更新时间：${timestamp}`;
  const mergedRange="A1:H1";
  await mcpCall("unmerge_range",{nodeId:WORKBOOK,sheetId,rangeAddress:mergedRange});
  let writeError=null;
  try {
    await mcpCall("set_cell_range",{nodeId:WORKBOOK,sheetId,rangeAddress:"A1",cells:[[{type:"text",text:value}]]});
  } catch (error) {
    writeError=error;
  } finally {
    await mcpCall("merge_cells",{nodeId:WORKBOOK,sheetId,rangeAddress:mergedRange,mergeType:"mergeAll"});
  }
  if (writeError) throw writeError;
  const verification=await mcpCall("get_range",{nodeId:WORKBOOK,sheetId,range:"A1"});
  const actual=normalizeText(findRows(verification)?.[0]?.[0]);
  if (actual!==value) throw new Error(`VERIFY_DASHBOARD_TIMESTAMP_MISMATCH:${actual}`);
  return timestamp;
}

async function main() {
  if (!WORKBOOK) throw new Error("请先在工作台配置面板填写续费数据钉钉文档链接");
  const inputFile=process.argv[2];
  if (!inputFile || !fs.existsSync(inputFile)) throw new Error("CRM_INPUT_FILE_NOT_FOUND");
  const source=JSON.parse(fs.readFileSync(inputFile,"utf8").replace(/^\uFEFF/,""));
  if (!Array.isArray(source.headers) || !Array.isArray(source.rows)) throw new Error("CRM_INPUT_INVALID");
  const selectedMonth=String(source.renewalMonth||"");
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(selectedMonth)) throw new Error("CRM_RENEWAL_MONTH_INVALID");
  FILTERS["续费月份"]=selectedMonth;
  source.headers=source.headers.map(normalizeText);
  validateSource(source.headers,source.rows);
  console.log(`CRM_OK rows=${source.rows.length} columns=${source.headers.length}`);
  const verification=await writeAndVerify(source);
  const dashboardTimestamp=await updateDashboardTimestamp();
  console.log(`SYNC_OK rows=${verification.rows} lastRow=${verification.lastRow}`);
  console.log(`DASHBOARD_TIMESTAMP_OK time=${dashboardTimestamp}`);
}

const task=process.argv.includes("--timestamp-only")
  ? updateDashboardTimestamp().then(timestamp=>console.log(`DASHBOARD_TIMESTAMP_OK time=${timestamp}`))
  : main();
task.catch(error=>{
  console.error(String(error?.message||error));
  process.exitCode=1;
});
