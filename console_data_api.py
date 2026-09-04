from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent)
GROUP = ROOT / "run-data" / "group-dashboard-tables.json"
EXCEPTION = ROOT / "run-data" / "exception-export-tables.json"
SNAPSHOT = ROOT / "dashboard-snapshot.json"
CONFIG = ROOT / "dashboard-config.json"
LIVE_TABLE = "班级直播上座"
LIVE_EXTRA_COLUMNS = ["课期", "较上周对应时段准时直播 Gap"]
LABELS = {
    "组内概览": "核心指标与同期异常",
    "班级课次看板": "各班当周课次表现",
    "班级直播上座": "三班型直播参播",
    "异常学员": "异常分层跟进名单",
    "推荐话术": "按异常类别生成的三种跟进风格",
    "未准时参播学员": "直播未准时参播明细",
    "回放学员": "回放学员与观看进度明细",
}
ORDER = list(LABELS)
DISABLED_TABLES = {"\u63a8\u8350\u8bdd\u672f"}


def load_tables() -> tuple[dict, dict]:
    group = json.loads(GROUP.read_text(encoding="utf-8")) if GROUP.exists() else {"sheets": {}}
    extra = json.loads(EXCEPTION.read_text(encoding="utf-8")) if EXCEPTION.exists() else {"tables": {}}
    tables = dict(group.get("sheets", {}))
    tables.update(extra.get("tables", {}))
    # Keep explicitly retired views out of the console without deleting source data.
    for name in DISABLED_TABLES:
        tables.pop(name, None)
    return tables, extra


def load_snapshot() -> dict:
    return json.loads(SNAPSHOT.read_text(encoding="utf-8")) if SNAPSHOT.exists() else {"classes": []}


def comparison_teachers() -> set[str]:
    try:
        config = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
        return {str(name or "").strip() for name in config.get("comparisonTeachers", []) if str(name or "").strip()}
    except (OSError, ValueError, TypeError):
        return set()


def class_key(value: object) -> str:
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return str(value or "").strip()


def prepare_table(name: str, table: dict, snapshot: dict) -> dict:
    """Add console-only fields without mutating the workbook export or its metrics."""
    if name != LIVE_TABLE:
        return {"columns": list(table.get("columns", [])), "data": [list(row) for row in table.get("data", [])]}

    columns = list(table.get("columns", []))
    class_id_index = columns.index("班级ID") if "班级ID" in columns else -1
    class_rows = {class_key(row.get("classId")): row for row in snapshot.get("classes", [])}
    rows = []
    for source_row in table.get("data", []):
        row = list(source_row)
        class_row = class_rows.get(class_key(row[class_id_index])) if class_id_index >= 0 else None
        row.extend([
            class_row.get("cohort", "") if class_row else "",
            class_row.get("liveDelta") if class_row else None,
        ])
        rows.append(row)
    return {"columns": columns + LIVE_EXTRA_COLUMNS, "data": rows}


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "meta"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "console-response.json"
    tables, extra = load_tables()
    snapshot = load_snapshot()
    if mode == "meta":
        comparison = comparison_teachers()
        abnormal_table = tables.get("异常学员", {})
        abnormal = abnormal_table.get("data", [])
        abnormal_columns = abnormal_table.get("columns", [])
        level_index = abnormal_columns.index("异常等级") if "异常等级" in abnormal_columns else 0
        teacher_index = abnormal_columns.index("老师姓名") if "老师姓名" in abnormal_columns else 1
        teacher_levels: dict[str, dict[str, int | str]] = {}
        for row in abnormal:
            if len(row) <= max(level_index, teacher_index):
                continue
            teacher = str(row[teacher_index] or "").strip()
            level = str(row[level_index] or "").strip()
            if not teacher or teacher in comparison:
                continue
            item = teacher_levels.setdefault(teacher, {"teacher": teacher, "level1": 0, "level2": 0, "level3": 0, "total": 0})
            item["total"] += 1
            if level.startswith("一级"):
                item["level1"] += 1
            elif level.startswith("二级"):
                item["level2"] += 1
            elif level.startswith("三级"):
                item["level3"] += 1
        abnormal_stats = {
            "total": len(abnormal),
            "level1": sum(str(row[level_index]).startswith("一级") for row in abnormal if len(row) > level_index),
            "level2": sum(str(row[level_index]).startswith("二级") for row in abnormal if len(row) > level_index),
            "level3": sum(str(row[level_index]).startswith("三级") for row in abnormal if len(row) > level_index),
            "byTeacher": sorted(teacher_levels.values(), key=lambda item: (-int(item["total"]), str(item["teacher"]))),
        }
        payload = {
            "period": extra.get("period", ""),
            "fallback": bool(extra.get("fallback")),
            "tables": [
                {
                    "name": name,
                    "label": LABELS[name],
                    "rows": len(tables.get(name, {}).get("data", [])),
                    "columns": len(prepare_table(name, tables.get(name, {}), snapshot).get("columns", [])),
                }
                for name in ORDER if name in tables
            ],
            "abnormalStats": abnormal_stats,
        }
    else:
        name = sys.argv[3]
        page = max(1, int(sys.argv[4]))
        size = min(200, max(20, int(sys.argv[5])))
        query_arg = sys.argv[6] if len(sys.argv) > 6 else ""
        query = ("" if query_arg == "__EMPTY__" else query_arg).strip().lower()
        cohort = (sys.argv[7] if len(sys.argv) > 7 else "all").strip() or "all"
        table = tables.get(name)
        if not table:
            raise SystemExit(f"unknown table: {name}")
        table = prepare_table(name, table, snapshot)
        rows = table.get("data", [])
        cohorts = []
        if name == LIVE_TABLE:
            cohort_index = table["columns"].index("课期")
            cohorts = sorted({str(row[cohort_index]) for row in rows if row[cohort_index]}, reverse=True)
            if cohort != "all" and cohort in cohorts:
                rows = [row for row in rows if str(row[cohort_index]) == cohort]
            else:
                cohort = "all"
        if query:
            rows = [row for row in rows if query in " ".join(str(v or "") for v in row).lower()]
        start = (page - 1) * size
        payload = {"name": name, "columns": table.get("columns", []), "rows": rows[start:start + size], "page": page, "size": size, "total": len(rows), "pages": max(1, (len(rows) + size - 1) // size)}
        if name == LIVE_TABLE:
            payload.update({"cohorts": cohorts, "cohort": cohort})
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
