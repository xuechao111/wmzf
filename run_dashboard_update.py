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
NODE = next(
    (path for path in (
        SOURCE_ROOT / "runtime" / "node" / "node.exe",
        Path(shutil.which("node")) if shutil.which("node") else None,
        Path(r"C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
    ) if path is not None and path.exists()),
    SOURCE_ROOT / "runtime" / "node" / "node.exe",
)
WORKBOOK = ""
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CRM_PROFILE = ROOT / "crm-browser-profile"
CRM_URL = "https://codecamp-crm.codemao.cn/layout/my-class"
CURRENT_WEEK_ONLY_SHEETS = {"未准时参播学员", "推荐话术"}
CURRENT_WEEK_CLEAR_LIMIT = 6000
STYLE_STATE = DATA / "style-state.json"
STYLE_LAYOUT_VERSION = 2
DISABLED_SHEETS = {"\u63a8\u8350\u8bdd\u672f"}
RUN_STARTED_AT = ""
SHEET_IDS: dict[str, str] = {}
CURRENT_STATUS: dict[str, str] = {}


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


def detail_teacher_sets(tables: dict[str, dict]) -> dict[str, set[str]]:
    """Snapshot generated teachers before the DingTalk table assembly stage."""
    result: dict[str, set[str]] = {}
    teacher_headers = {"老师", "老师姓名", "主讲老师"}
    for name in ("异常学员", "未准时参播学员", "回放学员", "班级直播上座"):
        table = tables.get(name)
        if not table:
            continue
        columns = [str(value or "").strip() for value in table.get("columns", [])]
        teacher_index = next((index for index, value in enumerate(columns) if value in teacher_headers), None)
        if teacher_index is None:
            continue
        result[name] = {
            str(row[teacher_index] or "").strip()
            for row in table.get("data", [])
            if teacher_index < len(row) and str(row[teacher_index] or "").strip()
        }
    return result


def required_teachers(tables: dict[str, dict]) -> set[str]:
    """Use the verified overview as the non-excluded teacher roster."""
    table = tables.get("组内概览") or {}
    columns = [str(value or "").strip() for value in table.get("columns", [])]
    teacher_index = next((index for index, value in enumerate(columns) if value in {"老师", "老师姓名", "主讲老师"}), None)
    if teacher_index is None:
        return set()
    return {
        str(row[teacher_index] or "").strip()
        for row in table.get("data", [])
        if teacher_index < len(row) and str(row[teacher_index] or "").strip()
    }


def dingtalk_excluded_teachers() -> set[str]:
    """Teachers configured not to appear in DingTalk teaching sheets."""
    config = dashboard_config()
    return {
        str(name).strip()
        for key in ("excludedTeachers", "comparisonTeachers")
        for name in config.get(key, [])
        if str(name).strip()
    }


def filter_dingtalk_excluded_rows(tables: dict[str, dict], excluded: set[str]) -> None:
    """Apply the configuration-panel exclusions at the final sync boundary."""
    if not excluded:
        return
    teacher_headers = {"老师", "老师姓名", "主讲老师"}
    for table in tables.values():
        columns = [str(value or "").strip() for value in table.get("columns", [])]
        teacher_index = next((index for index, value in enumerate(columns) if value in teacher_headers), None)
        if teacher_index is None:
            continue
        table["data"] = [
            row for row in table.get("data", [])
            if teacher_index >= len(row) or str(row[teacher_index] or "").strip() not in excluded
        ]
        summary = table.get("summary")
        if isinstance(summary, dict):
            summary_columns = [str(value or "").strip() for value in summary.get("columns", [])]
            summary_index = next((index for index, value in enumerate(summary_columns) if value in teacher_headers), None)
            if summary_index is not None:
                summary["data"] = [
                    row for row in summary.get("data", [])
                    if summary_index >= len(row) or str(row[summary_index] or "").strip() not in excluded
                ]


def validate_detail_teacher_preservation(expected: dict[str, set[str]], final_tables: dict[str, dict]) -> None:
    """Never silently remove generated teacher rows before DingTalk sync.

    Expected sets contain only teachers with genuine generated detail rows.
    The guard prevents the final configuration filter or table assembly from
    silently dropping those real records.
    """
    actual = detail_teacher_sets(final_tables)
    for name, expected_teachers in expected.items():
        final = final_tables.get(name)
        if not final:
            continue
        missing = expected_teachers - actual.get(name, set())
        if missing:
            raise RuntimeError(f"{name} 写入前丢失老师：{'、'.join(sorted(missing))}；已停止覆盖钉钉旧数据。")


WORKBOOK = configured_workbook()


def set_status(state: str, message: str, detail: str = "") -> None:
    global CURRENT_STATUS
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
    CURRENT_STATUS = {
        "state": state,
        "message": message,
        "detail": detail,
        "time": now,
        "startedAt": RUN_STARTED_AT or now,
        "phase": "local",
        "lastSuccessTime": last_success,
    }
    STATUS.write_text(json.dumps(CURRENT_STATUS, ensure_ascii=False), encoding="utf-8")


def touch_status(detail: str = "") -> None:
    """Refresh the watchdog heartbeat without losing the visible stage text."""
    if not CURRENT_STATUS or CURRENT_STATUS.get("state") != "running":
        return
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    CURRENT_STATUS["time"] = now
    if detail:
        CURRENT_STATUS["detail"] = detail
    STATUS.write_text(json.dumps(CURRENT_STATUS, ensure_ascii=False), encoding="utf-8")


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
    if configured_url:
        return configured_url, configured_token
    if not LEGACY_SYNC.exists():
        raise RuntimeError("请先在工作台配置面板填写钉钉连接地址")
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
        touch_status(f"正在调用钉钉接口 {name}（第 {attempt}/{attempts} 次）")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if MCP_TOKEN:
            headers["Authorization"] = "Bearer " + MCP_TOKEN
        request = urllib.request.Request(MCP_URL, data=body, method="POST", headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            if attempt >= attempts or exc.code not in (408, 429, 500, 502, 503, 504):
                if exc.code in (401, 403):
                    raise RuntimeError("钉钉连接无权访问当前文档。请把目标文档共享给该钉钉连接所属账号并授予编辑权限，或更换为该组长自己的钉钉连接地址。") from exc
                raise RuntimeError(f"钉钉接口请求失败（HTTP {exc.code}）。请检查钉钉连接地址和目标文档权限。") from exc
            delay = 1.5 * attempt
            print(f"钉钉接口 {name} 暂时异常（HTTP {exc.code}），{delay:.1f} 秒后重试 {attempt + 1}/{attempts}…", flush=True)
            touch_status(f"钉钉接口 {name} 暂时波动，准备重试 {attempt + 1}/{attempts}")
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt >= attempts:
                raise
            delay = 1.5 * attempt
            print(f"钉钉接口 {name} 连接波动（{exc}），{delay:.1f} 秒后重试 {attempt + 1}/{attempts}…", flush=True)
            touch_status(f"钉钉接口 {name} 连接波动，准备重试 {attempt + 1}/{attempts}")
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

    def sheet_list(value):
        if isinstance(value, list) and (not value or all(isinstance(item, dict) for item in value)):
            if not value or any(item.get("name") or item.get("sheetId") for item in value):
                return value
        if isinstance(value, dict):
            for key in ("sheets", "items", "data", "result"):
                if key in value:
                    found = sheet_list(value[key])
                    if found is not None:
                        return found
            for child in value.values():
                found = sheet_list(child)
                if found is not None:
                    return found
        return None

    sheets = sheet_list(listing) or []
    SHEET_IDS.clear()
    SHEET_IDS.update({str(sheet.get("name") or ""): str(sheet.get("sheetId") or sheet.get("id") or sheet.get("name") or "") for sheet in sheets})
    return SHEET_IDS


def normalize_sheet_name(value: object) -> str:
    return re.sub(r"[\s_\-]+", "", str(value or "")).casefold()


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
    sheet_ids = load_sheet_ids()
    aliases = {"班级id", "班级配置", "班级信息"}
    target = next(((name, sheet_id) for name, sheet_id in sheet_ids.items() if normalize_sheet_name(name) in aliases), None)
    if target is None:
        available = "、".join(name for name in sheet_ids if name) or "（未返回任何子表）"
        raise RuntimeError(f"未找到“班级id”子表；当前工作簿子表：{available}")
    sheet_name, sheet_id = target
    result = mcp_call("get_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": "A:F"})
    rows = find_rows(result) or []
    if len(rows) < 2:
        raise RuntimeError(f"“{sheet_name}”子表没有可用数据，请确认第1行为表头、第2行起为班级")
    headers = [normalize_sheet_name(x) for x in rows[0]]
    class_col = next((i for i, h in enumerate(headers) if h in {"班级id", "班级编号", "班级号"}), None)
    term_col = next((i for i, h in enumerate(headers) if h in {"主课期id", "主课期", "课期id"}), None)
    if class_col is None or term_col is None:
        visible_headers = "、".join(str(x or "").strip() for x in rows[0] if str(x or "").strip())
        raise RuntimeError(f"“{sheet_name}”子表缺少“班级id”或“主课期id”列；当前表头：{visible_headers}")
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
    expected = table.get("data", [])
    expected_end_row = len(expected) + 1
    # Verify the populated region in chunks, then probe both the first cleared
    # rows and the far tail. clear_range is atomic; downloading all 6,000 rows
    # again only adds latency without increasing correctness.
    max_rows_per_read = max(1, 30000 // width)
    rows = []
    for r1 in range(1, expected_end_row + 1, max_rows_per_read):
        r2 = min(r1 + max_rows_per_read - 1, expected_end_row)
        result = mcp_call("get_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A{r1}:{end_col}{r2}"}, 180)
        if isinstance(result, dict) and result.get("success") is False:
            raise RuntimeError(f"{sheet_id} 校验读取失败：{result.get('errorMsg') or result}")
        rows.extend(find_rows(result) or [])
    populated = [row for row in rows[1:] if any(value not in (None, "") for value in row[:width])]
    expected_period = str(expected[0][-1]) if expected else ""
    periods = {str(row[width - 1]) for row in populated if len(row) >= width and row[width - 1] not in (None, "")}
    if len(populated) != len(expected) or periods != ({expected_period} if expected_period else set()):
        raise RuntimeError(
            f"{sheet_id} 当周数据校验失败：应为 {len(expected)} 行、周期 {expected_period or '空'}；"
            f"实际 {len(populated)} 行、周期 {sorted(periods)}"
        )
    tail_ranges = []
    clear_start = expected_end_row + 1
    if clear_start <= CURRENT_WEEK_CLEAR_LIMIT:
        tail_ranges.append((clear_start, min(clear_start + 19, CURRENT_WEEK_CLEAR_LIMIT)))
        far_start = max(clear_start, CURRENT_WEEK_CLEAR_LIMIT - 19)
        if far_start > tail_ranges[-1][1]:
            tail_ranges.append((far_start, CURRENT_WEEK_CLEAR_LIMIT))
    for r1, r2 in tail_ranges:
        result = mcp_call("get_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A{r1}:{end_col}{r2}"}, 180)
        if isinstance(result, dict) and result.get("success") is False:
            raise RuntimeError(f"{sheet_id} 清空区校验读取失败：{result.get('errorMsg') or result}")
        tail_rows = find_rows(result) or []
        if any(any(value not in (None, "") for value in row[:width]) for row in tail_rows):
            raise RuntimeError(f"{sheet_id} 清空区仍存在旧数据（{r1}:{r2}），已停止报告成功。")


def style_layout_initialized(name: str, sheet_id: str) -> bool:
    try:
        state = json.loads(STYLE_STATE.read_text(encoding="utf-8"))
    except Exception:
        return False
    return state.get(name) == {"sheetId": str(sheet_id), "version": STYLE_LAYOUT_VERSION}


def mark_style_layout_initialized(name: str, sheet_id: str) -> None:
    try:
        state = json.loads(STYLE_STATE.read_text(encoding="utf-8")) if STYLE_STATE.exists() else {}
    except Exception:
        state = {}
    state[name] = {"sheetId": str(sheet_id), "version": STYLE_LAYOUT_VERSION}
    temporary = STYLE_STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    temporary.replace(STYLE_STATE)


def style_overview_sheet(sheet_id: str, table: dict, initialize_layout: bool = True) -> None:
    """Apply a compact, dashboard-like visual system to the overview sheet."""
    row_count = len(table.get("data", []))
    if not row_count:
        return
    end_row = row_count + 1
    matrix = lambda rows, cols, value: [[value] * cols for _ in range(rows)]
    try:
        if initialize_layout:
            mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1, "frozenColumnCount": 2})
            mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": "A1:P1",
                     "backgroundColors": matrix(1, 16, "#173F5F"), "fontColors": matrix(1, 16, "#FFFFFF"),
                     "fontWeights": matrix(1, 16, "bold"), "fontSizes": matrix(1, 16, 12),
                     "horizontalAlignments": matrix(1, 16, "center"), "verticalAlignments": matrix(1, 16, "middle"), "wordWrap": "autoWrap"})
        term_colors = ["#EAF3F8", "#EDF6E8", "#FFF1E6", "#F1EDFA"]
        terms = []
        body_backgrounds, body_fonts, body_weights, body_alignments = [], [], [], []
        for row in table["data"]:
            term = str(row[0])
            if term not in terms:
                terms.append(term)
            color = term_colors[terms.index(term) % len(term_colors)]
            normal = str(row[14] or "") == "正常"
            body_backgrounds.append([color, color, color, "#FFF6DF", "#E6F1F7", "#E6F1F7", "#E6F1F7",
                                     "#E9F4E7", "#E9F4E7", "#E9F4E7", "#FCE8E6", "#FFF0E4",
                                     "#F1EDFA", "#FFF6DF", "#E8F7F2" if normal else "#FADBD8", "#FFFFFF"])
            body_fonts.append(["#233746"] * 14 + ["#116F5E" if normal else "#A3322E", "#233746"])
            body_weights.append(["bold", "bold", "bold"] + ["normal"] * 11 + ["bold", "normal"])
            body_alignments.append(["center"] * 14 + ["left", "center"])
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A2:P{end_row}",
                 "backgroundColors": body_backgrounds, "fontColors": body_fonts, "fontWeights": body_weights,
                 "fontSizes": matrix(row_count, 16, 11), "horizontalAlignments": body_alignments,
                 "verticalAlignments": matrix(row_count, 16, "middle"), "wordWrap": "autoWrap"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"D2:J{end_row}", "numberFormat": "0.0%"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"C2:C{end_row}", "numberFormat": "#,##0"})
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"K2:N{end_row}", "numberFormat": "#,##0"})
        if initialize_layout:
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


def style_abnormal_sheet(sheet_id: str, table: dict, layout: dict, initialize_layout: bool = True) -> None:
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
        if initialize_layout:
            mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1, "frozenColumnCount": 2, "tabColor": "#F4B183"})
            mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
        try:
            mcp_call("delete_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id})
        except Exception:
            pass
        mcp_call("create_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A{detail_header_row}:H{max(detail_header_row, detail_end)}"})
        if initialize_layout:
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": "A1:H1",
                     "backgroundColors": matrix(1, 8, "#245B83"), "fontColors": matrix(1, 8, "#FFFFFF"),
                     "fontWeights": matrix(1, 8, "bold"), "fontSizes": matrix(1, 8, 12),
                     "horizontalAlignments": matrix(1, 8, "center"), "verticalAlignments": matrix(1, 8, "middle"), "wordWrap": "autoWrap"})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{summary_start_col}1:{summary_end_col}1",
                     "backgroundColors": matrix(1, 10, "#173F5F"), "fontColors": matrix(1, 10, "#FFFFFF"),
                     "fontWeights": matrix(1, 10, "bold"), "fontSizes": matrix(1, 10, 12),
                     "horizontalAlignments": matrix(1, 10, "left"), "verticalAlignments": matrix(1, 10, "middle"), "wordWrap": "autoWrap"})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{summary_start_col}2:{summary_end_col}2",
                     "backgroundColors": matrix(1, 10, "#245B83"), "fontColors": matrix(1, 10, "#FFFFFF"),
                     "fontWeights": matrix(1, 10, "bold"), "fontSizes": matrix(1, 10, 10),
                     "horizontalAlignments": matrix(1, 10, "center"), "verticalAlignments": matrix(1, 10, "middle"), "wordWrap": "autoWrap"})
        if summary_rows:
            summary_colors = ["#EAF3F8", "#FCE8E6", "#FCE8E6", "#FCE8E6", "#FCE8E6",
                              "#FFF0E4", "#FFF0E4", "#FFF6DF", "#E6F1F7", "#F5F7F9"]
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{summary_start_col}3:{summary_end_col}{summary_end}",
                     "backgroundColors": [summary_colors[:] for _ in range(summary_rows)],
                     "fontColors": matrix(summary_rows, 10, "#233746"), "fontSizes": matrix(summary_rows, 10, 11),
                     "fontWeights": [["bold"] + ["normal"] * 7 + ["bold", "normal"] for _ in range(summary_rows)],
                     "horizontalAlignments": matrix(summary_rows, 10, "center"), "verticalAlignments": matrix(summary_rows, 10, "middle"), "wordWrap": "autoWrap"})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"K3:R{summary_end}", "numberFormat": "0"})
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
                fills.append([fill] * 8); fonts.append([font] * 8); weights.append([weight] * 8)
            for offset in range(0, detail_rows, 900):
                chunk_rows = min(900, detail_rows - offset)
                first_row = detail_header_row + 1 + offset
                last_row = first_row + chunk_rows - 1
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A{first_row}:H{last_row}",
                         "backgroundColors": fills[offset:offset + chunk_rows], "fontColors": fonts[offset:offset + chunk_rows],
                         "fontWeights": weights[offset:offset + chunk_rows], "fontSizes": matrix(chunk_rows, 8, 10),
                         "horizontalAlignments": matrix(chunk_rows, 8, "center"),
                         "verticalAlignments": matrix(chunk_rows, 8, "middle"), "wordWrap": "autoWrap"})
        dimensions = [("ROWS", str(detail_header_row + 1), detail_rows, 30)]
        if initialize_layout:
            dimensions.extend([("ROWS", "1", 1, 58), ("ROWS", "2", 1, 54), ("ROWS", "3", summary_rows, 34),
                              ("COLUMNS", "A", 1, 190), ("COLUMNS", "B", 1, 145), ("COLUMNS", "C", 1, 90),
                              ("COLUMNS", "D", 1, 165), ("COLUMNS", "E", 1, 145), ("COLUMNS", "F", 1, 120),
                              ("COLUMNS", "G", 1, 220), ("COLUMNS", "H", 1, 170), ("COLUMNS", "I", 1, 28),
                              ("COLUMNS", "J", 1, 110), ("COLUMNS", "K", 7, 118), ("COLUMNS", "R", 1, 105), ("COLUMNS", "S", 1, 170)])
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
    initialize_layout = not style_layout_initialized(name, str(sheet_id))
    layout = {}
    if name == "异常学员" and table.get("summary"):
        summary = table["summary"]
        summary_start = 9
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
        layout = {"summary_start_col": "J", "summary_end_col": "S", "summary_end_row": summary_rows + 2, "detail_header_row": 1}
    else:
        rows = [table["columns"]] + table.get("data", [])
        width = len(table["columns"])
    end_col = col_letter(width - 1)
    # Keep each request below DingTalk's 30,000-cell limit while avoiding the
    # many tiny 180-row writes that dominated large detail-sheet refreshes.
    chunk = max(1, min(1000, 28000 // max(1, width)))
    for start in range(0, len(rows), chunk):
        values = rows[start:start + chunk]
        r1, r2 = start + 1, start + len(values)
        touch_status(f"{name}：正在写入第 {r1}-{r2} 行，共 {len(rows)} 行")
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
            if initialize_layout:
                mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": "COLUMNS",
                         "startIndex": stamp_col, "length": 1, "pixelSize": 230})
        except Exception as exc:
            print(f"{name} 更新时间单元格写入警告：{exc}", flush=True)
    if name == "组内概览":
        style_overview_sheet(sheet_id, table, initialize_layout)
    elif name == "异常学员":
        style_abnormal_sheet(sheet_id, table, layout, initialize_layout)
    elif name == "推荐话术":
        style_recommended_scripts_sheet(sheet_id, table)
    mark_style_layout_initialized(name, str(sheet_id))
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

    dingtalk_excluded = dingtalk_excluded_teachers()
    generated_detail_teachers = detail_teacher_sets(export["tables"])
    expected_detail_teachers = {
        name: teachers - dingtalk_excluded
        for name, teachers in generated_detail_teachers.items()
    }
    tables = dict(dashboard["sheets"])
    tables.update(export["tables"])
    # Stop syncing retired views while preserving existing workbook sheets.
    for disabled_name in DISABLED_SHEETS:
        tables.pop(disabled_name, None)
    filter_dingtalk_excluded_rows(tables, dingtalk_excluded)
    # Preserve every configured group teacher in all DingTalk detail sheets.
    validate_detail_teacher_preservation(expected_detail_teachers, tables)
    batch_updated_at = time.strftime("%Y-%m-%d %H:%M:%S")
    counts = {}
    timings = {}
    total = len(tables)
    for index, (name, table) in enumerate(tables.items(), 1):
        elapsed = int(time.monotonic() - started)
        set_status("running", f"正在写入钉钉（{index}/{total}）：{name}…", f"本轮已运行 {elapsed // 60} 分 {elapsed % 60} 秒")
        sheet_started = time.monotonic()
        counts[name] = write_sheet(name, table, batch_updated_at)
        timings[name] = round(time.monotonic() - sheet_started, 1)
        print(f"{name} 写入完成：{counts[name]} 行，耗时 {timings[name]:.1f} 秒", flush=True)
    detail = "；".join(f"{name} {count} 行" for name, count in counts.items())
    elapsed = int(time.monotonic() - started)
    print("各子表耗时：" + "；".join(f"{name} {seconds:.1f}秒" for name, seconds in timings.items()), flush=True)
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
