from __future__ import annotations

import json
import argparse
import subprocess
import sys
import time

import run_dashboard_update as core


TARGET_SHEET = "课期异常"


def run_command(command, cwd):
    result = subprocess.run(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.stdout:
        sys.stdout.buffer.write(result.stdout.encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    if result.returncode:
        raise RuntimeError(f"命令执行失败：{command[0]}")


def verify_sheet(sheet_id: str, table: dict, count: int) -> None:
    end_col = core.col_letter(len(table["columns"]) - 1)
    first = core.find_rows(core.mcp_call("get_range", {
        "nodeId": core.WORKBOOK,
        "sheetId": sheet_id,
        "range": f"A1:{end_col}{2 if count else 1}",
    })) or []
    if not first or [str(value or "") for value in first[0]] != [str(value or "") for value in table["columns"]]:
        raise RuntimeError("课期异常表头复核失败")
    if count and len(first) < 2:
        raise RuntimeError("课期异常首条学员明细缺失")
    last = core.find_rows(core.mcp_call("get_range", {
        "nodeId": core.WORKBOOK,
        "sheetId": sheet_id,
        "range": f"A{count + 1}:{end_col}{count + 1}",
    })) or []
    if count and (not last or not any(str(value or "").strip() for value in last[0])):
        raise RuntimeError("课期异常末条学员明细缺失")
    tail = core.find_rows(core.mcp_call("get_range", {
        "nodeId": core.WORKBOOK,
        "sheetId": sheet_id,
        "range": f"A{count + 2}:{end_col}{count + 2}",
    })) or []
    if tail and any(str(value or "").strip() for value in tail[0]):
        raise RuntimeError("课期异常旧尾行未清理")


def main() -> None:
    parser = argparse.ArgumentParser(description="只更新钉钉工作簿中的“课期异常”子表")
    parser.add_argument(
        "--from-raw",
        action="store_true",
        help="复用连接器已写入 run-data/group-lessons-raw.json 的 CRM 数据",
    )
    args = parser.parse_args()
    core.WORKBOOK = core.configured_workbook()
    if not core.WORKBOOK:
        raise RuntimeError("未配置钉钉教学工作簿")
    core.DATA.mkdir(exist_ok=True)
    core.SHEET_IDS.clear()
    if not args.from_raw:
        core.ensure_crm_ready()
        pairs = core.read_classes()
        (core.DATA / "classes.json").write_text(json.dumps(pairs, ensure_ascii=False), encoding="utf-8")
        run_command([
            str(core.NODE), str(core.SOURCE_ROOT / "fetch_group_via_extension.mjs"), "9222",
            str(core.DATA / "classes.json"), str(core.DATA / "group-lessons-raw.json"),
        ], core.SOURCE_ROOT)
    elif not (core.DATA / "group-lessons-raw.json").exists():
        raise RuntimeError("未找到连接器提交的 CRM 原始数据")
    if not (core.DATA / "classes.json").exists():
        raise RuntimeError("未找到班级配置数据")
    run_command([
        str(core.NODE), str(core.SKILL / "scripts" / "build_group_dashboard.mjs"),
        str(core.DATA), str(core.DATA / "classes.json"), "group-lessons-raw.json",
    ], core.SKILL / "scripts")
    run_command([sys.executable, str(core.SOURCE_ROOT / "get_dashboard_snapshot.py")], core.ROOT)
    run_command([sys.executable, str(core.SOURCE_ROOT / "build_exception_exports.py")], core.ROOT)

    export = json.loads((core.DATA / "exception-export-tables.json").read_text(encoding="utf-8"))
    table = export["tables"][TARGET_SHEET]
    updated_at = time.strftime("%Y-%m-%d %H:%M:%S")
    count = core.write_sheet(TARGET_SHEET, table, updated_at)
    sheet_id = core.SHEET_IDS.get(TARGET_SHEET) or core.load_sheet_ids(refresh=True).get(TARGET_SHEET)
    if not sheet_id:
        raise RuntimeError("课期异常子表创建后未找到")
    verify_sheet(str(sheet_id), table, count)
    cohorts = sorted({str(row[0]) for row in table.get("data", []) if row and str(row[0])}, reverse=True)
    teachers = sorted({str(row[1]) for row in table.get("data", []) if len(row) > 1 and str(row[1])})
    print(json.dumps({
        "sheet": TARGET_SHEET,
        "rows": count,
        "columns": len(table.get("columns", [])),
        "cohorts": cohorts,
        "teachers": teachers,
        "updatedAt": updated_at,
        "verified": True,
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
