from collections import defaultdict
from math import isclose
from datetime import datetime, timedelta, timezone
import re
import hashlib
import json
import os
from pathlib import Path

SHEET_NAME = "老师周参播对比-1-1"
METRICS = ["应到人数", "邀约人数", "邀约率", "上座人数", "上座率", "回看人数", "回看率", "总参播率"]
FIXED = ["老师", "课线", "课期", "在读人数", "上课时间"]
WEEKLY_HASH_FILE = Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent) / "run-data" / "weekly-attendance-hash.json"


def ids(rows):
    return {str(row["id"]) for row in rows or [] if row.get("id") is not None}


def build_weekly_attendance_table(snapshot, excluded=()):
    week_by_teacher = {(r["teacher"], r["cohort"]):
                       {key: str(r.get(key + "Week") or "").removesuffix("周") for key in ("current", "previous")}
                       for r in snapshot.get("rows", [])}
    groups = {}
    selected_weeks = []
    configured_weeks = [str(value) for value in snapshot.get("weeklyAttendanceWeeks", []) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value))]
    if len(configured_weeks) >= 2:
        selected_weeks = configured_weeks[:2]
    elif snapshot.get("updatedAt"):
        date = datetime.fromisoformat(snapshot["updatedAt"]).replace(tzinfo=timezone(timedelta(hours=8)))
        monday = date - timedelta(days=date.weekday())
        selected_weeks = [(monday + timedelta(days=offset)).strftime("%Y-%m-%d") for offset in (-7, 0)]
    weeks = set(selected_weeks)
    for item in snapshot.get("weeklyAttendanceClasses", snapshot.get("classes", [])):
        if item.get("teacher") in excluded:
            continue
        key = (item["teacher"], item.get("coursePackage", ""), item["cohort"], item.get("slot", ""))
        group = groups.setdefault(key, {"students": set(), "weeks": {}})
        group["students"].update(ids(item.get("students")))
        periods = list((item.get("attendanceWeeks") or {}).items()) if "attendanceWeeks" in item else [
            (week_by_teacher.get((item["teacher"], item["cohort"]), {}).get(period), item.get(period) or {}) for period in ("previous", "current")]
        for week, metrics in periods:
            if selected_weeks and week not in selected_weeks:
                continue
            if not week:
                continue
            # 课前/下周直播名单可能尚未产生，但应到人数仍应直接取在读人数。
            # 只有实际返回了直播名单时才校验名单并填充上座、回看指标。
            record = group["weeks"].setdefault(week, {"expected": set(), "attend": set(), "replay": set(), "has_live_data": False, "unverified": False})
            expected, attend = ids(metrics.get("liveExpectedList")), ids(metrics.get("liveAttendList"))
            has_live_data = bool(metrics.get("liveExpected") or expected or attend or metrics.get("liveAttend"))
            if has_live_data and (not expected or not attend.issubset(expected)):
                raise ValueError(f"WEEKLY_ATTENDANCE_ROSTER_INVALID:{item['classId']}:{period}")
            if has_live_data:
                record["has_live_data"] = True
                record["expected"].update(expected)
                record["attend"].update(attend)
                record["replay"].update(ids(metrics.get("replayList")) & expected)
                record["unverified"] |= bool(metrics.get("missingLiveBoards")) or metrics.get("liveRate") is None
            weeks.add(week)
    weeks = sorted(weeks)
    if not groups or not weeks:
        raise ValueError("WEEKLY_ATTENDANCE_NO_DATA")
    averages = defaultdict(lambda: [0, 0])
    invalid = set()
    for key, group in groups.items():
        for week, record in group["weeks"].items():
            average_key = (*key[:3], week)
            if record["unverified"]:
                invalid.add(average_key)
            averages[average_key][0] += len(record["attend"] | record["replay"])
            averages[average_key][1] += len(group["students"])
    columns = FIXED + [f"{week} {name}" for week in weeks for name in METRICS]
    rows, row_keys = [], []
    slots = {"周五晚": 0, "周六午": 1, "周六晚": 2}
    for key in sorted(groups, key=lambda k: (k[:3], slots.get(k[3], 9), k[3])):
        group = groups[key]
        row = [key[0], key[1], key[2], len(group["students"]), key[3]]
        for week in weeks:
            record = group["weeks"].get(week)
            expected = len(group["students"])
            if not record:
                row.extend([expected, None, None, None, None, None, None, None])
                continue
            if record["unverified"] or not record.get("has_live_data"):
                row.extend([expected, None, None, None, None, None, None, None])
                continue
            attend = len(record["attend"] & group["students"])
            replay = len((record["replay"] - record["attend"]) & group["students"])
            row.extend([expected, None, None, attend, attend / expected if expected else None, replay,
                        replay / expected if expected else None, (attend + replay) / expected if expected else None])
        rows.append(row)
        row_keys.append(key)
    # 每位老师追加一行汇总，邀约人数仍留空供老师填写，邀约率由表格公式计算。
    summary_rows, summary_keys = [], []
    for teacher in sorted({key[0] for key in row_keys}):
        indexes = [i for i, key in enumerate(row_keys) if key[0] == teacher]
        if not indexes:
            continue
        summary = [teacher, "汇总", "老师汇总", sum(rows[i][3] for i in indexes), "汇总"]
        for week_index in range(len(weeks)):
            offset = 5 + week_index * len(METRICS)
            expected = sum((rows[i][offset] or 0) for i in indexes)
            attend_values = [rows[i][offset + 3] for i in indexes if rows[i][offset + 3] is not None]
            replay_values = [rows[i][offset + 5] for i in indexes if rows[i][offset + 5] is not None]
            attend = sum(attend_values) if attend_values else None
            replay = sum(replay_values) if replay_values else None
            summary.extend([expected, None, None, attend,
                            attend / expected if attend is not None and expected else None,
                            replay, replay / expected if replay is not None and expected else None,
                            (attend + replay) / expected if attend is not None and replay is not None and expected else None])
        summary_rows.append(summary)
        summary_keys.append((teacher, "汇总", "老师汇总", "汇总"))
    combined_rows, combined_keys = [], []
    for teacher in sorted({key[0] for key in row_keys}):
        for row, key in zip(rows, row_keys):
            if key[0] == teacher:
                combined_rows.append(row); combined_keys.append(key)
        idx = [i for i, k in enumerate(summary_keys) if k[0] == teacher][0]
        combined_rows.append(summary_rows[idx]); combined_keys.append(summary_keys[idx])
    return {"columns": columns, "data": combined_rows, "weeks": weeks, "rowKeys": combined_keys,
            "sourceUpdatedAt": snapshot.get("updatedAt", "")}


def write_weekly_attendance_sheet(core, table, updated_at=""):
    sheet_id = core.load_sheet_ids().get(SHEET_NAME)
    if not sheet_id:
        raise RuntimeError(f"WEEKLY_ATTENDANCE_TARGET_MISSING:找不到指定子表 {SHEET_NAME}，已停止；不会另建子表")
    base = {"nodeId": core.WORKBOOK, "sheetId": sheet_id}
    width, count = len(table["columns"]), len(table["data"])
    last = core.col_letter(width - 1)
    # 周参播数据没有变化时跳过整套清空/写入/合并/格式化，避免每次教学更新都额外耗时。
    fingerprint_payload = {"formatVersion": 4, "workbook": core.WORKBOOK, "sheetId": sheet_id, "weeks": table["weeks"], "rows": table["data"], "rowKeys": table["rowKeys"]}
    fingerprint = hashlib.sha256(json.dumps(fingerprint_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    try:
        if WEEKLY_HASH_FILE.exists() and json.loads(WEEKLY_HASH_FILE.read_text(encoding="utf-8")).get("fingerprint") == fingerprint:
            return count
    except (OSError, ValueError, TypeError):
        pass
    # 更新前读取旧表，只保留老师手填的邀约人数。系统采集列仍全部按最新数据重写。
    preserved_invites = {}
    try:
        previous_rows_limit = min(max(count + 100, 120), 1000)
        previous = core.find_rows(core.mcp_call("get_range", {**base, "range": f"A1:{last}{previous_rows_limit}"})) or []
        if not previous:
            raise RuntimeError("WEEKLY_PREVIOUS_SHEET_EMPTY:无法确认老师手填数据")
        backup_dir = WEEKLY_HASH_FILE.parent / "weekly-invite-backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / (datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".json")
        backup_path.write_text(json.dumps({**base, "rows": previous}, ensure_ascii=False), encoding="utf-8")
        if len(previous) >= 3:
            previous_week_starts = {}
            for index, value in enumerate(previous[0]):
                match = re.search(r"(\d{4}-\d{2}-\d{2})", str(value or ""))
                if match:
                    previous_week_starts[match.group(1)] = index
            identity = [None, None, None]
            for previous_row in previous[2:]:
                for index in range(3):
                    value = previous_row[index] if index < len(previous_row) else None
                    if value not in (None, ""):
                        identity[index] = str(value)
                slot = str(previous_row[4] if len(previous_row) > 4 and previous_row[4] not in (None, "") else "")
                key = (*identity, slot)
                for week, start in previous_week_starts.items():
                    invite_index = start + 1
                    if invite_index < len(previous_row):
                        value = previous_row[invite_index]
                        if value not in (None, ""):
                            preserved_invites[(key, week)] = value
    except Exception as exc:
        # Never clear a sheet if its manual entries could not be read.
        raise RuntimeError("WEEKLY_INVITES_READ_FAILED:已停止写入以保护老师手填邀约人数") from exc
    core.mcp_call("unmerge_range", {**base, "rangeAddress": "A1:AZ6000"})
    core.mcp_call("clear_range", {**base, "range": "A1:AZ6000", "type": "all"})
    header = FIXED + [value for week in table["weeks"] for value in [week + "周", *[""] * (len(METRICS) - 1)]]
    labels = [""] * len(FIXED) + METRICS * len(table["weeks"])
    matrix = [header, labels, *[list(row) for row in table["data"]]]
    # 邀约人数由老师手填，邀约率始终由表格公式计算；空邀约时显示为空。
    for matrix_index, row_data in enumerate(table["data"], start=2):
        spreadsheet_row = matrix_index + 1
        for week_index in range(len(table["weeks"])):
            start = 5 + week_index * len(METRICS)
            expected_col = core.col_letter(start)
            invited_col = core.col_letter(start + 1)
            rate_col = core.col_letter(start + 2)
            identity_key = (*table["rowKeys"][matrix_index - 2][:3], table["rowKeys"][matrix_index - 2][3])
            old_invite = preserved_invites.get((identity_key, table["weeks"][week_index]))
            if old_invite not in (None, ""):
                matrix[matrix_index][start + 1] = old_invite
            matrix[matrix_index][start + 2] = f'=IFERROR(IF(OR({invited_col}{spreadsheet_row}="",NOT(ISNUMBER({invited_col}{spreadsheet_row})),{expected_col}{spreadsheet_row}=0),"",{invited_col}{spreadsheet_row}/{expected_col}{spreadsheet_row}),"")'
    core.mcp_call("update_range", {**base, "rangeAddress": f"A1:{last}{count + 2}", "values": matrix, "format": "auto"})
    def style(address, **options):
        core.mcp_call("update_range", {**base, "rangeAddress": address, **options})
    style(f"A1:{last}{count + 2}", fontSizes=[[10] * width for _ in matrix],
          horizontalAlignments=[["center"] * width for _ in matrix],
          verticalAlignments=[["middle"] * width for _ in matrix], wordWrap="autoWrap")
    style(f"A1:{last}2", backgroundColors=[["#FFE699"] * width for _ in range(2)],
          fontWeights=[["bold"] * width for _ in range(2)])
    for index in range(5):
        col = core.col_letter(index)
        core.mcp_call("merge_cells", {**base, "rangeAddress": f"{col}1:{col}2", "mergeType": "mergeAll"})
    style("A1:E2", backgroundColors=[["#DCEAF4"] * 5 for _ in range(2)])
    for index, week in enumerate(table["weeks"]):
        start, end = 5 + index * len(METRICS), 5 + (index + 1) * len(METRICS) - 1
        left, right = core.col_letter(start), core.col_letter(end)
        core.mcp_call("merge_cells", {**base, "rangeAddress": f"{left}1:{right}1", "mergeType": "mergeAll"})
        style(f"{left}1:{right}1", backgroundColors=[["#F6BC99" if index % 2 else "#B9D9EA"] * len(METRICS)])
        for offset in range(len(METRICS)):
            col = core.col_letter(start + offset)
            style(f"{col}3:{col}{count + 2}", numberFormat="0%" if offset in (2, 4, 6, 7) else "0")
    cohort_colors = {cohort: ["#E5EFDC", "#E4EDF6", "#F1E7F0", "#F8EDDB"][i % 4]
                     for i, cohort in enumerate(dict.fromkeys(key[2] for key in table["rowKeys"]))}
    fills = []
    for row, key in zip(table["data"], table["rowKeys"]):
        summary_row = key[3] == "汇总"
        colors = ["#D9E2F3"] * width if summary_row else [cohort_colors[key[2]]] * width
        colors[4] = "#C5D4E8" if summary_row else {"周五晚": "#C6D5F5", "周六午": "#FFF0B3", "周六晚": "#F8C4AC"}.get(key[3], "#E5EFDC")
        if not summary_row:
            for i in range(len(table["weeks"])):
                for offset in (4, 6, 7):
                    cell = 5 + i * len(METRICS) + offset
                    if row[cell] is not None:
                        colors[cell] = "#D5EBD9" if row[cell] >= .9 else "#FFE2BF" if row[cell] >= .7 else "#F7C9C1"
        fills.append(colors)
    style(f"A3:{last}{count + 2}", backgroundColors=fills)
    summary_weights = [["bold"] * width if key[3] == "汇总" else ["normal"] * width for key in table["rowKeys"]]
    style(f"A3:{last}{count + 2}", fontWeights=summary_weights)
    # Merge repeated identifying cells while retaining an independent row per slot.
    start = 0
    keys = table["rowKeys"]
    while start < count:
        end = start + 1
        while end < count and keys[end][:3] == keys[start][:3]:
            end += 1
        if end - start > 1:
            for col in ("A", "B", "C"):
                core.mcp_call("merge_cells", {**base, "rangeAddress": f"{col}{start + 3}:{col}{end + 2}", "mergeType": "mergeAll"})
        start = end
    core.mcp_call("update_sheet", {**base, "frozenRowCount": 2, "frozenColumnCount": 5})
    for start, length, size in [("A", 1, 100), ("B", 1, 85), ("C", 1, 190), ("D", 2, 85), ("F", width - 5, 90)]:
        core.mcp_call("update_dimension", {**base, "dimension": "COLUMNS", "startIndex": start, "length": length, "pixelSize": size})
    core.mcp_call("update_dimension", {**base, "dimension": "ROWS", "startIndex": "1", "length": count + 2, "pixelSize": 30})
    note = f"数据截止：{table['sourceUpdatedAt']}。应到人数直接取在读人数；邀约人数由老师手动填写，邀约率自动按邀约人数÷应到人数计算并按整数百分比显示。总参播=准时直播或回看的去重人数/在读人数；回看人数剔除已准时直播者。未开课时仅保留应到人数。每位老师末尾为汇总行。"
    style(f"A{count + 4}", values=[[note]])
    core.mcp_call("merge_cells", {**base, "rangeAddress": f"A{count + 4}:{last}{count + 4}", "mergeType": "mergeAll"})
    core.mcp_call("update_dimension", {**base, "dimension": "ROWS", "startIndex": str(count + 4), "length": 1, "pixelSize": 48})
    verify_weekly_attendance_sheet(core, sheet_id, table, matrix)
    try:
        WEEKLY_HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
        WEEKLY_HASH_FILE.write_text(json.dumps({"fingerprint": fingerprint, "updatedAt": updated_at}, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return count


def verify_weekly_attendance_sheet(core, sheet_id, table, written_matrix=None):
    count = len(table["data"])
    last = core.col_letter(len(table["columns"]) - 1)
    verify = core.find_rows(core.mcp_call("get_range", {"nodeId": core.WORKBOOK, "sheetId": sheet_id, "range": f"D3:{last}{count + 2}"})) or []
    expected = [row[3:] for row in table["data"]]
    def equal(value, actual):
        if value is None:
            return actual is None or actual == ""
        if isinstance(value, (int, float)):
            try:
                return isclose(value, float(actual), rel_tol=1e-9, abs_tol=1e-9)
            except (ValueError, TypeError):
                return False
        return value == actual
    # Invitation numbers are manual; invitation rates are calculated cells.
    manual_or_formula = {3 + i * len(METRICS) + offset for i in range(len(table["weeks"])) for offset in (0, 1)}
    if len(verify) != count or any(len(received) != len(row) or any(index not in manual_or_formula and not equal(value, actual)
                                    for index, (value, actual) in enumerate(zip(row, received))) for row, received in zip(expected, verify)):
        raise RuntimeError("WEEKLY_ATTENDANCE_VERIFY_FAILED")
    if written_matrix is not None:
        for row_index, received in enumerate(verify):
            for week_index in range(len(table["weeks"])):
                invite_index = 6 + week_index * len(METRICS)
                original = written_matrix[row_index + 2][invite_index]
                if not equal(original, received[invite_index - 3]):
                    raise RuntimeError("WEEKLY_INVITES_VERIFY_FAILED:手填邀约人数核对失败")
