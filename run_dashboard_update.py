from __future__ import annotations

import json
import msvcrt
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("HF_DASHBOARD_ROOT") or SOURCE_ROOT)
DATA = ROOT / "run-data"
CONFIG = ROOT / "dashboard-config.json"
STATUS = ROOT / "status.json"
UPDATE_LOCK = ROOT / "update.lock"
SKILL = SOURCE_ROOT
LEGACY_SYNC = Path(r"C:\Users\user\Desktop\Documents\编程猫管理skill\codemao-student-profile-extracted\codemao-course-data\sync.py")
NODE = Path(shutil.which("node") or r"C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
WORKBOOK = ""
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CRM_PROFILE = ROOT / "crm-browser-profile"
CRM_URL = "https://codecamp-crm.codemao.cn/layout/my-class"
CURRENT_WEEK_ONLY_SHEETS = {"未准时参播学员", "推荐话术"}
CURRENT_WEEK_CLEAR_LIMIT = 6000
DISABLED_SHEETS = {"\u5f02\u5e38\u5b66\u5458", "\u63a8\u8350\u8bdd\u672f"}
RUN_STARTED_AT = ""
SHEET_IDS: dict[str, str] = {}


def dashboard_config() -> dict:
    try:
        value = json.loads(CONFIG.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def configured_workbook() -> str:
    return str(dashboard_config().get("workbookUrl") or WORKBOOK).strip()


def configured_classes() -> list[list[int]]:
    pairs = dashboard_config().get("classes") or []
    result = []
    for pair in pairs:
        try:
            class_id, term_id = int(pair[0]), int(pair[1])
        except (TypeError, ValueError, IndexError):
            continue
        if class_id > 0 and term_id > 0:
            result.append([class_id, term_id])
    return [list(pair) for pair in dict.fromkeys(map(tuple, result))]


def comparison_teachers() -> set[str]:
    """Teachers shown in the local comparison board but never written to DingTalk."""
    return {
        str(name).strip()
        for name in dashboard_config().get("comparisonTeachers", [])
        if str(name).strip()
    }


def filter_comparison_rows_for_dingtalk(tables: dict[str, dict]) -> dict[str, dict]:
    """Remove configured comparison teachers from every teacher-scoped DingTalk table.

    This intentionally runs after the local snapshot is built, so comparison
    teachers remain available for cohort averages and Gap calculations in the
    console while all DingTalk outputs remain group-only.
    """
    hidden = comparison_teachers()
    if not hidden:
        return tables
    teacher_headers = {"老师", "老师姓名", "主讲老师"}
    for table in tables.values():
        columns = [str(value or "").strip() for value in table.get("columns", [])]
        teacher_index = next((index for index, name in enumerate(columns) if name in teacher_headers), None)
        if teacher_index is None:
            continue
        rows = table.get("data", [])
        table["data"] = [
            row for row in rows
            if teacher_index >= len(row) or str(row[teacher_index] or "").strip() not in hidden
        ]
        if isinstance(table.get("anomalies"), list):
            kept = [item for item in table["anomalies"] if str(item.get("teacher") or "").strip() not in hidden]
            row_by_teacher = {
                str(row[teacher_index] or "").strip(): index + 2
                for index, row in enumerate(table["data"])
                if teacher_index < len(row)
            }
            for item in kept:
                item["row"] = row_by_teacher.get(str(item.get("teacher") or "").strip(), item.get("row"))
            table["anomalies"] = kept
    return tables


WORKBOOK = configured_workbook()


def set_status(state: str, message: str, detail: str = "") -> None:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    previous = {}
    try:
        previous = json.loads(STATUS.read_text(encoding="utf-8"))
    except Exception:
        pass
    last_success = previous.get("lastSuccessTime") or (previous.get("time") if previous.get("state") == "success" else "")
    snapshot = ROOT / "dashboard-snapshot.json"
    if not last_success and snapshot.exists():
        last_success = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(snapshot.stat().st_mtime))
    if state == "success":
        last_success = now
    STATUS.write_text(json.dumps({
        "state": state,
        "message": message,
        "detail": detail,
        "time": now,
        "startedAt": RUN_STARTED_AT or now,
        "phase": "local",
        "lastSuccessTime": last_success,
    }, ensure_ascii=False), encoding="utf-8")


def crm_pages() -> list[dict]:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:9222/json/list", timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return []


def ensure_crm_ready() -> None:
    pages = crm_pages()
    if not pages:
        if not CHROME.exists():
            raise RuntimeError("未找到 Chrome，无法打开 CRM 专用登录窗口。")
        CRM_PROFILE.mkdir(exist_ok=True)
        subprocess.Popen([str(CHROME), "--remote-debugging-port=9222", f"--user-data-dir={CRM_PROFILE}", CRM_URL])
        time.sleep(4)
        pages = crm_pages()
    if not any("codecamp-crm.codemao.cn" in str(page.get("url") or "") for page in pages if page.get("type") == "page"):
        raise RuntimeError("CRM 专用窗口已打开，请完成登录后再次点击“更新全部数据”。")


def open_crm_login() -> None:
    try:
        target = "http://127.0.0.1:9222/json/new?" + urllib.parse.quote(CRM_URL, safe="")
        request = urllib.request.Request(target, method="PUT")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=3):
            pass
    except Exception:
        pass


def credentials() -> tuple[str, str]:
    configured = dashboard_config()
    configured_url = str(configured.get("dingtalkConnectionUrl") or "").strip()
    configured_token = str(configured.get("dingtalkAccessKey") or "").strip()
    if configured_url and configured_token:
        return configured_url, configured_token
    if not LEGACY_SYNC.exists():
        raise RuntimeError("请先在工作台配置面板填写钉钉连接地址和访问密钥")
    text = LEGACY_SYNC.read_text(encoding="utf-8", errors="ignore")
    url = re.search(r'MCP_URL\s*=\s*"([^"]+)"', text)
    token = re.search(r'ACCESS_TOKEN\s*=\s*"([^"]+)"', text)
    if not url or not token:
        raise RuntimeError("未找到钉钉 MCP 配置")
    return url.group(1), token.group(1)


MCP_URL, MCP_TOKEN = credentials()


def mcp_call(name: str, arguments: dict, timeout: int = 120, attempts: int = 3):
    payload = {"jsonrpc": "2.0", "method": "tools/call", "params": {"name": name, "arguments": arguments}, "id": 1}
    body = json.dumps(payload).encode("utf-8")
    result = None
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(MCP_URL, data=body, method="POST", headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + MCP_TOKEN})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            if attempt >= attempts or exc.code not in (408, 429, 500, 502, 503, 504):
                raise
            delay = 1.5 * attempt
            print(f"钉钉接口 {name} 暂时异常（HTTP {exc.code}），{delay:.1f} 秒后重试 {attempt + 1}/{attempts}…", flush=True)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt >= attempts:
                raise
            delay = 1.5 * attempt
            print(f"钉钉接口 {name} 连接波动（{exc}），{delay:.1f} 秒后重试 {attempt + 1}/{attempts}…", flush=True)
            time.sleep(delay)
    if result is None:
        raise RuntimeError(f"钉钉接口 {name} 未返回结果")
    if result.get("error"):
        raise RuntimeError(str(result["error"]))
    content = result.get("result", {}).get("content", [])
    if content and isinstance(content[0], dict):
        text = content[0].get("text", "{}")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"text": text}
    return result.get("result", {})


def load_sheet_ids(refresh: bool = False) -> dict[str, str]:
    """Read the workbook directory once per run instead of once per sheet."""
    if SHEET_IDS and not refresh:
        return SHEET_IDS
    listing = mcp_call("get_all_sheets", {"nodeId": WORKBOOK})
    sheets = listing.get("sheets", []) if isinstance(listing, dict) else []
    SHEET_IDS.clear()
    SHEET_IDS.update({str(sheet.get("name") or ""): str(sheet.get("sheetId") or sheet.get("name") or "") for sheet in sheets})
    return SHEET_IDS


def find_rows(value):
    if isinstance(value, dict):
        for key in ("values", "data", "rows", "displayValues"):
            rows = value.get(key)
            if isinstance(rows, list) and (not rows or isinstance(rows[0], list)):
                return rows
        for item in value.values():
            found = find_rows(item)
            if found is not None:
                return found
    return None


def read_classes() -> list[list[int]]:
    configured = configured_classes()
    if configured:
        return configured
    result = mcp_call("get_range", {"nodeId": WORKBOOK, "sheetId": "班级id", "range": "A:F"})
    rows = find_rows(result) or []
    if len(rows) < 2:
        raise RuntimeError("班级id 工作表没有可用数据")
    headers = [str(x or "").strip().lower() for x in rows[0]]
    class_col = next((i for i, h in enumerate(headers) if h.replace(" ", "") == "班级id"), None)
    term_col = next((i for i, h in enumerate(headers) if h.replace(" ", "") == "主课期id"), None)
    if class_col is None or term_col is None:
        raise RuntimeError("班级id 工作表缺少“班级id”或“主课期id”列")
    pairs = []
    for row in rows[1:]:
        try:
            class_id, term_id = int(float(row[class_col])), int(float(row[term_col]))
        except (ValueError, TypeError, IndexError):
            continue
        if class_id and term_id:
            pairs.append([class_id, term_id])
    pairs = list(dict.fromkeys((class_id, term_id) for class_id, term_id in pairs))
    pairs = [list(pair) for pair in pairs]
    if not pairs:
        raise RuntimeError("没有读取到有效班级 ID")
    return pairs


def col_letter(index: int) -> str:
    result = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        result = chr(65 + rem) + result
    return result


def clear_stale_rows(sheet_id: str, width: int, start_row: int, end_row: int, required: bool = False) -> None:
    """Clear old generated rows while preserving manual columns to the right."""
    if start_row > end_row:
        return
    end_col = col_letter(width - 1)
    result = mcp_call("clear_range", {
        "nodeId": WORKBOOK,
        "sheetId": sheet_id,
        "range": f"A{start_row}:{end_col}{end_row}",
        "type": "content",
    }, 180)
    if isinstance(result, dict) and result.get("success") is False:
        error = result.get("errorMsg") or result
        if required:
            raise RuntimeError(f"清理 {sheet_id} 的历史周数据失败：{error}")
        print(f"{sheet_id} 尾部旧数据清理警告：{error}", flush=True)


def verify_current_week_only(sheet_id: str, table: dict) -> None:
    """Fail if a rolling sheet has stale periods or differs from this run's dynamic row count."""
    width = len(table["columns"])
    end_col = col_letter(width - 1)
    # DingTalk limits one get_range call to 30,000 cells, so verify in chunks.
    max_rows_per_read = max(1, 30000 // width)
    rows = []
    for r1 in range(1, CURRENT_WEEK_CLEAR_LIMIT + 1, max_rows_per_read):
        r2 = min(r1 + max_rows_per_read - 1, CURRENT_WEEK_CLEAR_LIMIT)
        result = mcp_call("get_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A{r1}:{end_col}{r2}"}, 180)
        if isinstance(result, dict) and result.get("success") is False:
            raise RuntimeError(f"{sheet_id} 校验读取失败：{result.get('errorMsg') or result}")
        rows.extend(find_rows(result) or [])
    populated = [row for row in rows[1:] if any(value not in (None, "") for value in row[:width])]
    expected = table.get("data", [])
    expected_period = str(expected[0][-1]) if expected else ""
    periods = {str(row[width - 1]) for row in populated if len(row) >= width and row[width - 1] not in (None, "")}
    if len(populated) != len(expected) or periods != ({expected_period} if expected_period else set()):
        raise RuntimeError(
            f"{sheet_id} 当周数据校验失败：应为 {len(expected)} 行、周期 {expected_period or '空'}；"
            f"实际 {len(populated)} 行、周期 {sorted(periods)}"
        )


def style_overview_sheet(sheet_id: str, table: dict) -> None:
    """Apply a compact, dashboard-like visual system to the overview sheet."""
    row_count = len(table.get("data", []))
    if not row_count:
        return
    end_row = row_count + 1
    matrix = lambda rows, cols, value: [[value] * cols for _ in range(rows)]
    try:
        mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1, "frozenColumnCount": 2})
        mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": "A1:P1",
                 "backgroundColors": matrix(1, 16, "#173F5F"), "fontColors": matrix(1, 16, "#FFFFFF"),
                 "fontWeights": matrix(1, 16, "bold"), "fontSizes": matrix(1, 16, 12),
                 "horizontalAlignments": matrix(1, 16, "center"), "verticalAlignments": matrix(1, 16, "middle"), "wordWrap": "autoWrap"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A2:P{end_row}",
                 "fontColors": matrix(row_count, 16, "#233746"), "fontSizes": matrix(row_count, 16, 11),
                 "horizontalAlignments": matrix(row_count, 16, "center"), "verticalAlignments": matrix(row_count, 16, "middle"), "wordWrap": "autoWrap"})
        term_colors = ["#EAF3F8", "#EDF6E8", "#FFF1E6", "#F1EDFA"]
        terms = []
        term_backgrounds = []
        for row in table["data"]:
            term = str(row[0])
            if term not in terms:
                terms.append(term)
            color = term_colors[terms.index(term) % len(term_colors)]
            term_backgrounds.append([color, color, color])
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A2:C{end_row}",
                 "backgroundColors": term_backgrounds, "fontWeights": matrix(row_count, 3, "bold")})
        color_bands = [("D", "D", "#FFF6DF"), ("E", "G", "#E6F1F7"), ("H", "J", "#E9F4E7"),
                       ("K", "K", "#FCE8E6"), ("L", "L", "#FFF0E4"),
                       ("M", "M", "#F1EDFA"), ("N", "N", "#FFF6DF")]
        for start_col, end_col, color in color_bands:
            cols = ord(end_col) - ord(start_col) + 1
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{start_col}2:{end_col}{end_row}",
                     "backgroundColors": matrix(row_count, cols, color)})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"D2:J{end_row}", "numberFormat": "0.0%"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"C2:C{end_row}", "numberFormat": "#,##0"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"K2:N{end_row}", "numberFormat": "#,##0"})
        warning_states = [str(row[14] or "") == "正常" for row in table["data"]]
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"O2:O{end_row}",
                 "backgroundColors": [["#E8F7F2" if normal else "#FADBD8"] for normal in warning_states],
                 "fontColors": [["#116F5E" if normal else "#A3322E"] for normal in warning_states],
                 "fontWeights": matrix(row_count, 1, "bold"),
                 "horizontalAlignments": matrix(row_count, 1, "left")})
        dimensions = [("ROWS", "1", 1, 52), ("ROWS", "2", row_count, 38),
                      ("COLUMNS", "A", 1, 88), ("COLUMNS", "B", 1, 96), ("COLUMNS", "C", 1, 72),
                      ("COLUMNS", "D", 7, 98), ("COLUMNS", "K", 4, 92), ("COLUMNS", "O", 1, 320), ("COLUMNS", "P", 1, 180)]
        for dimension, start, length, size in dimensions:
            mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": dimension,
                     "startIndex": start, "length": length, "pixelSize": size})
    except Exception as exc:
        print(f"组内概览样式更新警告：{exc}", flush=True)


def style_recommended_scripts_sheet(sheet_id: str, table: dict) -> None:
    """Style the reusable weekly scripts for quick reading and copying."""
    row_count = len(table.get("data", []))
    if not row_count:
        return
    end_row = row_count + 1
    matrix = lambda rows, cols, value: [[value] * cols for _ in range(rows)]
    try:
        mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1})
        mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": "A1:E1",
                 "backgroundColors": matrix(1, 5, "#173F5F"), "fontColors": matrix(1, 5, "#FFFFFF"),
                 "fontWeights": matrix(1, 5, "bold"), "fontSizes": matrix(1, 5, 12),
                 "horizontalAlignments": matrix(1, 5, "center"), "verticalAlignments": matrix(1, 5, "middle"), "wordWrap": "autoWrap"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A2:E{end_row}",
                 "fontColors": matrix(row_count, 5, "#233746"), "fontSizes": matrix(row_count, 5, 11),
                 "verticalAlignments": matrix(row_count, 5, "middle"), "wordWrap": "autoWrap"})
        bands = [("A", "#FFF1E6"), ("B", "#EAF3F8"), ("C", "#EDF6E8"), ("D", "#F1EDFA"), ("E", "#F5F7F9")]
        for column, color in bands:
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{column}2:{column}{end_row}",
                     "backgroundColors": matrix(row_count, 1, color),
                     "horizontalAlignments": matrix(row_count, 1, "left" if column != "E" else "center"),
                     "fontWeights": matrix(row_count, 1, "bold" if column == "A" else "normal")})
        dimensions = [("ROWS", "1", 1, 52), ("ROWS", "2", row_count, 108),
                      ("COLUMNS", "A", 1, 230), ("COLUMNS", "B", 1, 460),
                      ("COLUMNS", "C", 1, 420), ("COLUMNS", "D", 1, 460), ("COLUMNS", "E", 1, 180)]
        for dimension, start, length, size in dimensions:
            mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": dimension,
                     "startIndex": start, "length": length, "pixelSize": size})
    except Exception as exc:
        print(f"推荐话术样式更新警告：{exc}", flush=True)


def style_abnormal_sheet(sheet_id: str, table: dict, layout: dict) -> None:
    """Style learner details on the left and the teacher/category summary on the right."""
    summary_rows = len(table.get("summary", {}).get("data", []))
    detail_rows = len(table.get("data", []))
    if not summary_rows and not detail_rows:
        return
    summary_start_col = layout["summary_start_col"]
    summary_end_col = layout["summary_end_col"]
    summary_end = layout["summary_end_row"]
    detail_header_row = layout["detail_header_row"]
    detail_end = detail_header_row + detail_rows
    matrix = lambda rows, cols, value: [[value] * cols for _ in range(rows)]
    try:
        mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1, "frozenColumnCount": 2, "tabColor": "#F4B183"})
        mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
        try:
            mcp_call("delete_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id})
        except Exception:
            pass
        mcp_call("create_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A{detail_header_row}:G{max(detail_header_row, detail_end)}"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": "A1:G1",
                 "backgroundColors": matrix(1, 7, "#245B83"), "fontColors": matrix(1, 7, "#FFFFFF"),
                 "fontWeights": matrix(1, 7, "bold"), "fontSizes": matrix(1, 7, 12),
                 "horizontalAlignments": matrix(1, 7, "center"), "verticalAlignments": matrix(1, 7, "middle"), "wordWrap": "autoWrap"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{summary_start_col}1:{summary_end_col}1",
                 "backgroundColors": matrix(1, 10, "#173F5F"), "fontColors": matrix(1, 10, "#FFFFFF"),
                 "fontWeights": matrix(1, 10, "bold"), "fontSizes": matrix(1, 10, 12),
                 "horizontalAlignments": matrix(1, 10, "left"), "verticalAlignments": matrix(1, 10, "middle"), "wordWrap": "autoWrap"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{summary_start_col}2:{summary_end_col}2",
                 "backgroundColors": matrix(1, 10, "#245B83"), "fontColors": matrix(1, 10, "#FFFFFF"),
                 "fontWeights": matrix(1, 10, "bold"), "fontSizes": matrix(1, 10, 10),
                 "horizontalAlignments": matrix(1, 10, "center"), "verticalAlignments": matrix(1, 10, "middle"), "wordWrap": "autoWrap"})
        if summary_rows:
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{summary_start_col}3:{summary_end_col}{summary_end}",
                     "fontColors": matrix(summary_rows, 10, "#233746"), "fontSizes": matrix(summary_rows, 10, 11),
                     "horizontalAlignments": matrix(summary_rows, 10, "center"), "verticalAlignments": matrix(summary_rows, 10, "middle"), "wordWrap": "autoWrap"})
            summary_bands = [("I", "#EAF3F8"), ("J", "#FCE8E6"), ("K", "#FCE8E6"), ("L", "#FCE8E6"), ("M", "#FCE8E6"),
                             ("N", "#FFF0E4"), ("O", "#FFF0E4"), ("P", "#FFF6DF"), ("Q", "#E6F1F7"), ("R", "#F5F7F9")]
            for column, color in summary_bands:
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{column}3:{column}{summary_end}",
                         "backgroundColors": matrix(summary_rows, 1, color),
                         "fontWeights": matrix(summary_rows, 1, "bold" if column in ("I", "Q") else "normal")})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"J3:Q{summary_end}", "numberFormat": "0"})
        if detail_rows:
            fills, fonts, weights = [], [], []
            for row in table["data"]:
                level = str(row[0] or "")
                if level.startswith("一级"):
                    fill, font, weight = "#FCE8E6", "#A3322E", "bold"
                elif level.startswith("二级"):
                    fill, font, weight = "#FFF0E4", "#A85A16", "normal"
                else:
                    fill, font, weight = "#FFF6DF", "#8A6A00", "normal"
                fills.append([fill] * 7); fonts.append([font] * 7); weights.append([weight] * 7)
            for offset in range(0, detail_rows, 900):
                chunk_rows = min(900, detail_rows - offset)
                first_row = detail_header_row + 1 + offset
                last_row = first_row + chunk_rows - 1
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A{first_row}:G{last_row}",
                         "backgroundColors": fills[offset:offset + chunk_rows], "fontColors": fonts[offset:offset + chunk_rows],
                         "fontWeights": weights[offset:offset + chunk_rows], "fontSizes": matrix(chunk_rows, 7, 10),
                         "horizontalAlignments": matrix(chunk_rows, 7, "center"),
                         "verticalAlignments": matrix(chunk_rows, 7, "middle"), "wordWrap": "autoWrap"})
        dimensions = [("ROWS", str(detail_header_row + 1), detail_rows, 30),
                      ("ROWS", "1", 1, 58), ("ROWS", "2", 1, 54), ("ROWS", "3", summary_rows, 34),
                      ("COLUMNS", "A", 1, 190), ("COLUMNS", "B", 1, 165), ("COLUMNS", "C", 1, 165),
                      ("COLUMNS", "D", 1, 145), ("COLUMNS", "E", 1, 120), ("COLUMNS", "F", 1, 220),
                      ("COLUMNS", "G", 1, 170), ("COLUMNS", "H", 1, 28),
                      ("COLUMNS", "I", 1, 110), ("COLUMNS", "J", 7, 118), ("COLUMNS", "Q", 1, 105), ("COLUMNS", "R", 1, 170)]
        for dimension, start, length, size in dimensions:
            if length:
                mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": dimension,
                         "startIndex": start, "length": length, "pixelSize": size})
    except Exception as exc:
        print(f"异常学员样式更新警告：{exc}", flush=True)


def apply_explicit_number_formats(sheet_id: str, table: dict) -> None:
    """Reset inherited spreadsheet formats after replacing generated data."""
    row_count = len(table.get("data", []))
    if not row_count:
        return
    dtypes = table.get("dtypes", {}) or {}
    formats = table.get("formats", {}) or {}
    runs = []
    active = None
    for index, column in enumerate(table.get("columns", [])):
        number_format = formats.get(column)
        if not number_format and dtypes.get(column) == "int":
            number_format = "0"
        elif not number_format and dtypes.get(column) == "float":
            number_format = "0.00"
        if not number_format:
            if active:
                runs.append(active)
                active = None
            continue
        if active and active[2] == number_format and active[1] == index - 1:
            active = (active[0], index, number_format)
        else:
            if active:
                runs.append(active)
            active = (index, index, number_format)
    if active:
        runs.append(active)
    end_row = row_count + 1
    for start, end, number_format in runs:
        mcp_call("update_range", {
            "nodeId": WORKBOOK,
            "sheetId": sheet_id,
            "rangeAddress": f"{col_letter(start)}2:{col_letter(end)}{end_row}",
            "numberFormat": number_format,
        })


def write_sheet(name: str, table: dict, updated_at: str = "") -> int:
    sheet_ids = load_sheet_ids()
    sheet_id = sheet_ids.get(name)
    if not sheet_id:
        created = mcp_call("create_sheet", {"nodeId": WORKBOOK, "name": name})
        if not created.get("success"):
            raise RuntimeError(f"创建子表失败：{name} {created}")
        sheet_id = created.get("sheetId") or name
        SHEET_IDS[name] = str(sheet_id)
    layout = {}
    if name == "异常学员" and table.get("summary"):
        summary = table["summary"]
        summary_start = 8
        width = summary_start + len(summary["columns"])
        detail_rows = [table["columns"], *table.get("data", [])]
        summary_rows_data = [[summary.get("title") or "各老师异常分类汇总"], summary["columns"], *summary.get("data", [])]
        total_rows = max(len(detail_rows), len(summary_rows_data))
        rows = []
        for index in range(total_rows):
            row = [""] * width
            if index < len(detail_rows):
                row[:len(detail_rows[index])] = detail_rows[index]
            if index < len(summary_rows_data):
                summary_row = summary_rows_data[index]
                row[summary_start:summary_start + len(summary_row)] = summary_row
            rows.append(row)
        summary_rows = len(summary.get("data", []))
        layout = {"summary_start_col": "I", "summary_end_col": "R", "summary_end_row": summary_rows + 2, "detail_header_row": 1}
    else:
        rows = [table["columns"]] + table.get("data", [])
        width = len(table["columns"])
    end_col = col_letter(width - 1)
    chunk = 80 if width > 30 else 180
    for start in range(0, len(rows), chunk):
        values = rows[start:start + chunk]
        r1, r2 = start + 1, start + len(values)
        args = {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A{r1}:{end_col}{r2}", "values": values, "format": "auto"}
        try:
            mcp_call("update_range", args, 180)
        except Exception:
            args.pop("rangeAddress")
            args["range"] = f"A{r1}:{end_col}{r2}"
            mcp_call("update_range", args, 180)
    # Rolling weekly detail sheets must fully replace the previous week. Other
    # generated sheets keep the smaller compatibility cleanup used historically.
    clear_start = len(rows) + 1
    if name in CURRENT_WEEK_ONLY_SHEETS:
        clear_stale_rows(sheet_id, width, clear_start, CURRENT_WEEK_CLEAR_LIMIT, required=True)
        verify_current_week_only(sheet_id, table)
    elif name == "异常学员":
        clear_stale_rows(sheet_id, width, clear_start, CURRENT_WEEK_CLEAR_LIMIT, required=True)
    else:
        clear_stale_rows(sheet_id, width, clear_start, clear_start + 39)
    apply_explicit_number_formats(sheet_id, table)
    if updated_at:
        stamp_col = col_letter(width)
        stamp_text = f"数据更新时间｜{updated_at}"
        try:
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{stamp_col}1",
                     "values": [[stamp_text]], "backgroundColors": [["#173F5F"]], "fontColors": [["#FFFFFF"]],
                     "fontWeights": [["bold"]], "horizontalAlignments": [["center"]], "verticalAlignments": [["middle"]]})
            mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": "COLUMNS",
                     "startIndex": stamp_col, "length": 1, "pixelSize": 230})
        except Exception as exc:
            print(f"{name} 更新时间单元格写入警告：{exc}", flush=True)
    if name == "组内概览":
        style_overview_sheet(sheet_id, table)
    elif name == "异常学员":
        style_abnormal_sheet(sheet_id, table, layout)
    elif name == "推荐话术":
        style_recommended_scripts_sheet(sheet_id, table)
    return len(table.get("data", []))


def run(from_raw: bool = False) -> None:
    global RUN_STARTED_AT
    started = time.monotonic()
    now_text = time.strftime("%Y-%m-%d %H:%M:%S")
    RUN_STARTED_AT = now_text
    if from_raw and STATUS.exists():
        try:
            previous = json.loads(STATUS.read_text(encoding="utf-8"))
            if previous.get("state") == "running" and previous.get("startedAt"):
                RUN_STARTED_AT = str(previous["startedAt"])
        except (OSError, ValueError, TypeError):
            pass
    DATA.mkdir(exist_ok=True)
    SHEET_IDS.clear()
    if not from_raw:
        set_status("running", "正在检查 CRM 登录状态…")
        ensure_crm_ready()
        set_status("running", "正在读取班级 ID…")
        pairs = read_classes()
        (DATA / "classes.json").write_text(json.dumps(pairs, ensure_ascii=False), encoding="utf-8")

        set_status("running", f"正在快速获取 {len(pairs)} 个班级的本周与对比周数据…")
        fetch_script = SKILL / "scripts" / "fetch_group_lessons.mjs"
        fetch_source = fetch_script.read_text(encoding="utf-8")
        if "windowStart=monday.getTime()/1000-14*86400" not in fetch_source:
            raise RuntimeError("教学数据采集脚本版本过旧：缺少上上周同期窗口，已停止以避免生成空 Gap。")
        fetch = subprocess.run(
            [str(NODE), str(fetch_script), "9222", str(DATA / "classes.json"), str(DATA / "group-lessons-raw.json"), "0", "0", "2"],
            cwd=SKILL / "scripts", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace"
        )
        if fetch.stdout:
            print(fetch.stdout, flush=True)
        if fetch.returncode:
            if " 401 " in fetch.stdout or "InsufficientAuthenticationException" in fetch.stdout:
                open_crm_login()
                raise RuntimeError("CRM 登录已失效，请重新登录后再次点击“快速更新”。")
            raise RuntimeError("CRM 数据获取失败，请稍后重试；旧看板数据未被覆盖。")
    else:
        set_status("running", "已从当前Chrome获取CRM数据，正在生成看板…")

    set_status("running", "正在计算完课、直播上座和同期异常…")
    subprocess.run([str(NODE), str(SKILL / "scripts" / "build_group_dashboard.mjs"), str(DATA), str(DATA / "classes.json"), "group-lessons-raw.json"], cwd=SKILL / "scripts", check=True)
    dashboard = json.loads((DATA / "group-dashboard-tables.json").read_text(encoding="utf-8"))
    snapshot_build = subprocess.run(
        [sys.executable, str(SOURCE_ROOT / "get_dashboard_snapshot.py")], cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace"
    )
    if snapshot_build.returncode:
        lines = [line.strip() for line in snapshot_build.stdout.splitlines() if line.strip()]
        message = lines[-1].removeprefix("RuntimeError: ") if lines else "教学看板完整性校验失败，已保留上一轮数据。"
        raise RuntimeError(message)
    subprocess.run([sys.executable, str(SOURCE_ROOT / "build_exception_exports.py")], cwd=ROOT, check=True)
    export = json.loads((DATA / "exception-export-tables.json").read_text(encoding="utf-8"))

    tables = dict(dashboard["sheets"])
    tables.update(export["tables"])
    # Stop syncing retired views while preserving existing workbook sheets.
    for disabled_name in DISABLED_SHEETS:
        tables.pop(disabled_name, None)
    filter_comparison_rows_for_dingtalk(tables)
    batch_updated_at = time.strftime("%Y-%m-%d %H:%M:%S")
    counts = {}
    total = len(tables)
    for index, (name, table) in enumerate(tables.items(), 1):
        elapsed = int(time.monotonic() - started)
        set_status("running", f"正在写入钉钉（{index}/{total}）：{name}…", f"本轮已运行 {elapsed // 60} 分 {elapsed % 60} 秒")
        counts[name] = write_sheet(name, table, batch_updated_at)
    detail = "；".join(f"{name} {count} 行" for name, count in counts.items())
    elapsed = int(time.monotonic() - started)
    set_status("success", f"组内教学数据更新完成（{elapsed // 60} 分 {elapsed % 60} 秒）。", detail)


def acquire_update_lock():
    """Keep one updater process active; repeated clicks reuse its visible status."""
    handle = UPDATE_LOCK.open("a+b")
    handle.seek(0)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        return None
    return handle


if __name__ == "__main__":
    lock_handle = acquire_update_lock()
    if lock_handle is None:
        print("已有一轮更新正在运行，本次重复请求已忽略。")
        raise SystemExit(0)
    try:
        run("--from-raw" in sys.argv)
    except Exception as error:
        set_status("error", "更新失败。", str(error))
        raise
    finally:
        lock_handle.close()
