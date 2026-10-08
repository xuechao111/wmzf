from __future__ import annotations

from typing import Any


SHEET_NAME = "组内教学总看板"


def _num(value: Any, default: float | int | None = 0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _count_pair(done: Any, total: Any) -> str:
    return f"{int(_num(done, 0) or 0)} / {int(_num(total, 0) or 0)}"


def _rate_gap(row: dict, key: str):
    value = row.get(key)
    return value if isinstance(value, (int, float)) else None


def _student_label(student: dict) -> str:
    name = str(student.get("name") or "未命名学员").strip()
    student_id = str(student.get("id") or "").strip()
    return f"{name}（{student_id}）" if student_id else name


def _student_list(students: list[dict], include_makeup_detail: bool = False) -> str:
    items = []
    for student in students or []:
        label = _student_label(student)
        if include_makeup_detail:
            completions = []
            for completion in student.get("completions") or []:
                lesson = completion.get("courseNumber") or "—"
                time_text = completion.get("time") or str(completion.get("completedAt") or "")[-5:]
                class_name = completion.get("className") or ""
                suffix = f"第{lesson}课"
                if class_name:
                    suffix += f" {class_name}"
                if time_text:
                    suffix += f" {time_text}"
                completions.append(suffix)
            if completions:
                label += "：" + "、".join(completions)
        items.append(label)
    return "\n".join(items)


def build_overview_total_table(snapshot: dict) -> dict:
    rows = []
    for item in snapshot.get("rows", []):
        current = item.get("current") or {}
        service = item.get("service") or {}
        call = service.get("dailyCall") or {}
        dial = int(_num(call.get("dial"), 0) or 0)
        connected = int(_num(call.get("connected"), 0) or 0)
        voice_dial = int(_num(call.get("voiceDial"), 0) or 0)
        voice_connected = int(_num(call.get("voiceConnected"), 0) or 0)
        video_dial = int(_num(call.get("videoDial"), 0) or 0)
        video_connected = int(_num(call.get("videoConnected"), 0) or 0)
        daily_makeup = item.get("dailyMakeup") or {}
        attendance_changes = ((item.get("timelyLiveComparison") or {}).get("attendanceChanges") or {})
        rows.append([
            item.get("cohort") or "",
            item.get("teacher") or "",
            item.get("recentClassTime") or "",
            current.get("arrivalRate"),
            _count_pair(current.get("arrivalAttend"), current.get("arrivalExpected")),
            current.get("liveRate"),
            item.get("cohortLiveAverage"),
            _rate_gap(item, "cohortLiveGap"),
            _count_pair(current.get("liveAttend"), current.get("liveExpected")),
            current.get("finishRate"),
            item.get("cohortFinishAverage"),
            _rate_gap(item, "cohortFinishGap"),
            _count_pair(current.get("evenDone"), current.get("evenExpected")),
            call.get("rate") if dial else None,
            f"{connected} / {dial}",
            f"{voice_connected} / {voice_dial}",
            f"{video_connected} / {video_dial}",
            int(_num((item.get("dailyMakeup") or {}).get("count"), 0) or 0),
            _student_list(daily_makeup.get("students") or [], include_makeup_detail=True),
            len(attendance_changes.get("lastWeekCameThisWeekMissed") or []),
            _student_list(attendance_changes.get("lastWeekCameThisWeekMissed") or []),
            len(attendance_changes.get("lastWeekMissedThisWeekCame") or []),
            _student_list(attendance_changes.get("lastWeekMissedThisWeekCame") or []),
            int(_num(current.get("incompleteStudents"), 0) or 0),
            int(_num(current.get("liveAbsentStudents"), 0) or 0),
            int(_num(current.get("replayStudents"), 0) or 0),
            int(_num(current.get("arrivedIncompleteStudents"), 0) or 0),
            (snapshot.get("weeks") or {}).get("current") or "",
        ])

    columns = [
        "课期",
        "老师",
        "最近开课",
        "第一节课到课率",
        "第一节课到课",
        "准时直播上座率",
        "同期直播均值",
        "直播Gap",
        "准时直播",
        "偶数课完课率",
        "同期完课均值",
        "完课Gap",
        "偶数课完课",
        "今日IM电话接通率",
        "IM电话接通/拨打",
        "语音接通/拨打",
        "视频接通/拨打",
        "今日新增补课",
        "今日新增补课明细",
        "上周准时本周未到",
        "上周准时本周未到明细",
        "上周未到本周准时",
        "上周未到本周准时明细",
        "未完课学员",
        "未准时参播",
        "观看回放",
        "到课未完课",
        "统计周期",
    ]
    return {
        "columns": columns,
        "data": rows,
        "dtypes": {
            "第一节课到课率": "float",
            "准时直播上座率": "float",
            "同期直播均值": "float",
            "直播Gap": "float",
            "偶数课完课率": "float",
            "同期完课均值": "float",
            "完课Gap": "float",
            "今日IM电话接通率": "float",
            "今日新增补课": "int",
            "上周准时本周未到": "int",
            "上周未到本周准时": "int",
            "未完课学员": "int",
            "未准时参播": "int",
            "观看回放": "int",
            "到课未完课": "int",
        },
        "formats": {
            "第一节课到课率": "0.0%",
            "准时直播上座率": "0.0%",
            "同期直播均值": "0.0%",
            "直播Gap": "0.0%",
            "偶数课完课率": "0.0%",
            "同期完课均值": "0.0%",
            "完课Gap": "0.0%",
            "今日IM电话接通率": "0.0%",
        },
    }
