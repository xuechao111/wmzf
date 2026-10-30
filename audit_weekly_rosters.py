"""Audit weekly current enrollment against the latest class detail roster."""
import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def latest_class_roster(block):
    by_course = defaultdict(dict)
    for item in block.get("items", []):
        if item.get("user_id"):
            by_course[int(item.get("course_id") or 0)][str(item["user_id"])] = str(item.get("child_name") or item.get("nickname") or "")
    lesson = max((lesson for lesson in block.get("lessons", []) if int(lesson.get("course_id") or 0) in by_course),
                 key=lambda lesson: (int(lesson.get("unlock_time") or 0), int(lesson.get("course_number") or 0)), default=None)
    if lesson is None:
        raise ValueError(f"WEEKLY_ACTIVE_ROSTER_MISSING:{block.get('classId')}")
    return int(lesson["course_id"]), by_course[int(lesson["course_id"])]


def audit():
    rows = []
    for block in json.loads((ROOT / "run-data/group-lessons-raw.json").read_text(encoding="utf-8")):
        if block.get("excluded") or not block.get("items"):
            continue
        course, active = latest_class_roster(block)
        old = {str(item["user_id"]) for item in block["items"] if item.get("user_id")}
        for board in (block.get("liveAttendance") or {}).values():
            old.update(str(uid) for uid in (board.get("names") or {}))
        rows.append({"老师": str(block.get("info", {}).get("teacherName", "")).split("-C")[0],
                     "班级ID": block["classId"], "课次ID": course, "旧在读人数": len(old),
                     "最新课次名单人数": len(active), "差额": len(old) - len(active)})
    out = ROOT / "run-data/weekly-roster-audit.csv"
    with out.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({"classes": len(rows), "teachers": len({row['老师'] for row in rows}),
                      "changedClasses": sum(row['差额'] != 0 for row in rows), "report": str(out)}, ensure_ascii=False))


if __name__ == "__main__":
    audit()
