from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import run_dashboard_update as core

ROOT = Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent)
OUT = ROOT / "dashboard-snapshot.json"
RAW = ROOT / "run-data" / "group-lessons-raw.json"
SERVICE = ROOT / "service-data.json"
CONFIG = ROOT / "dashboard-config.json"
CN = timezone(timedelta(hours=8))


def teacher_name(value):
    text = str(value or "")
    return text.rsplit("-C", 1)[0] if "-C" in text else text


def week_start(seconds):
    dt = datetime.fromtimestamp(seconds, CN)
    day = (dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(day.timestamp())


def previous_opened_week(opened_weeks, current):
    previous = [week for week in sorted(opened_weeks) if week < current]
    return previous[-1] if previous else current - 7 * 86400


def pct(done, total):
    return done / total if total else 0


def slot_label(seconds):
    dt = datetime.fromtimestamp(seconds, CN)
    if dt.weekday() == 4:
        return "周五晚"
    if dt.weekday() == 5 and dt.hour < 18:
        return "周六午"
    if dt.weekday() == 5:
        return "周六晚"
    return dt.strftime("周%w %H:%M")


def parse_crm_time(value):
    text = str(value or "").strip()
    if not text:
        return None
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, pattern).replace(tzinfo=CN)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=CN) if parsed.tzinfo is None else parsed.astimezone(CN)
    except ValueError:
        return None


def daily_makeup_students(records):
    """Collapse same-day late completions to one learner with all completion events."""
    students = {}
    for record in records:
        uid = str(record.get("id") or "")
        if not uid:
            continue
        student = students.setdefault(uid, {"id": uid, "name": record.get("name") or "", "completions": []})
        event = {
            "courseNumber": int(record.get("courseNumber") or 0),
            "completedAt": str(record.get("completedAt") or ""),
            "time": str(record.get("time") or ""),
            "classId": int(record.get("classId") or 0),
            "className": str(record.get("className") or ""),
        }
        if event not in student["completions"]:
            student["completions"].append(event)
    result = list(students.values())
    for student in result:
        student["completions"].sort(key=lambda item: (item["completedAt"], item["courseNumber"]))
        student["completedAt"] = student["completions"][-1]["completedAt"] if student["completions"] else ""
    return sorted(result, key=lambda item: (item["completedAt"], item["name"], item["id"]), reverse=True)


def numeric_or_none(value):
    try:
        return int(float(value)) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def service_number(source, key):
    value = source.get(key)
    try:
        return float(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def daily_call_metrics(source):
    voice_dial = service_number(source, "voiceDialStudents")
    if voice_dial is None:
        voice_dial = service_number(source, "voiceDialUsers")
    if voice_dial is None:
        voice_dial = service_number(source, "voiceDialCount")
    video_dial = service_number(source, "videoDialStudents")
    if video_dial is None:
        video_dial = service_number(source, "videoDialUsers")
    if video_dial is None:
        video_dial = service_number(source, "videoDialCount")
    video_connected = service_number(source, "videoCallUsers")
    if video_connected is None:
        video_connected = service_number(source, "videoConnectedCount")
    total_connected = service_number(source, "callUsers")
    voice_connected = service_number(source, "voiceConnectedCount")
    if total_connected is not None and video_connected is not None:
        voice_connected = max(0, total_connected - video_connected)
    elif voice_connected is None:
        voice_connected = service_number(source, "callUsers")
    dial_total = int((voice_dial or 0) + (video_dial or 0))
    connected_total = int(total_connected if total_connected is not None else (voice_connected or 0) + (video_connected or 0))
    return {
        "voiceDial": int(voice_dial or 0),
        "voiceConnected": int(voice_connected or 0),
        "videoDial": int(video_dial or 0),
        "videoConnected": int(video_connected or 0),
        "dial": dial_total,
        "connected": connected_total,
        "rate": pct(connected_total, dial_total),
    }


def public_metrics(metrics, roster, include_lists=True):
    incomplete = sorted(metrics["incompleteIds"], key=lambda uid: roster.get(uid, ""))
    absent = sorted(metrics["liveAbsentIds"], key=lambda uid: roster.get(uid, ""))
    replay = sorted(metrics["replayIds"], key=lambda uid: roster.get(uid, ""))
    live_expected = sorted(metrics["liveExpectedIds"], key=lambda uid: roster.get(uid, ""))
    live_attend = sorted(metrics["liveAttendIds"], key=lambda uid: roster.get(uid, ""))
    result = {
        "arrivalExpected": metrics["arrivalExpected"], "arrivalAttend": metrics["arrivalAttend"],
        "arrivalRate": pct(metrics["arrivalAttend"], metrics["arrivalExpected"]),
        "liveExpected": metrics["liveExpected"], "liveAttend": metrics["liveAttend"],
        "liveRate": pct(metrics["liveAttend"], metrics["liveExpected"]),
        "liveAbsentStudents": len(absent), "replayAttend": metrics["replayAttend"],
        "replayRate": pct(metrics["replayAttend"], metrics["liveExpected"]),
        "replayStudents": len(replay), "evenExpected": metrics["evenExpected"],
        "evenDone": metrics["evenDone"], "finishRate": pct(metrics["evenDone"], metrics["evenExpected"]),
        "incompleteStudents": len(incomplete), "arrivedIncomplete": metrics["arrivedIncomplete"],
        "arrivedIncompleteStudents": len(metrics["arrivedIncompleteIds"]),
        "missingLiveBoards": metrics.get("missingLiveBoards", 0)
        , "detailLiveFallbacks": metrics.get("detailLiveFallbacks", 0)
    }
    if include_lists:
        result["liveExpectedList"] = [{"id": uid, "name": roster.get(uid, "")} for uid in live_expected]
        result["liveAttendList"] = [{"id": uid, "name": roster.get(uid, "")} for uid in live_attend]
        result["liveAbsentList"] = [{"id": uid, "name": roster.get(uid, "")} for uid in absent]
        result["replayList"] = [{"id": uid, "name": roster.get(uid, "")} for uid in replay]
        result["incompleteList"] = [{"id": uid, "name": roster.get(uid, "")} for uid in incomplete]
        arrived_incomplete = sorted(metrics["arrivedIncompleteIds"], key=lambda uid: roster.get(uid, ""))
        result["arrivedIncompleteList"] = [{"id": uid, "name": roster.get(uid, "")} for uid in arrived_incomplete]
    return result


def timely_live_comparison(class_rows):
    """Compare only opened current slots with the same slots last week.

    A teacher's overall gap compares the combined timely-live rate at the
    current update stage with the same stage last week. Missing prior-week
    data is never treated as a zero rate.
    """
    slot_order = {"周五晚": 0, "周六午": 1, "周六晚": 2}
    grouped = {}
    for row in class_rows:
        if row["current"]["liveExpected"] <= 0:
            continue
        grouped.setdefault(row["slot"], []).append(row)

    slots = []
    for slot, rows in sorted(grouped.items(), key=lambda item: slot_order.get(item[0], 99)):
        current_expected = sum(row["current"]["liveExpected"] for row in rows)
        previous_expected = sum(row["previous"]["liveExpected"] for row in rows)
        current_rate = pct(sum(row["current"]["liveAttend"] for row in rows), current_expected)
        previous_rate = (
            pct(sum(row["previous"]["liveAttend"] for row in rows), previous_expected)
            if previous_expected
            else None
        )
        slots.append({
            "slot": slot,
            "currentRate": current_rate,
            "previousRate": previous_rate,
            "gap": current_rate - previous_rate if previous_rate is not None else None,
            "hasBaseline": previous_rate is not None,
        })

    count = len(slots)
    if count == 1:
        label = slots[0]["slot"]
    elif count == 2:
        label = "+".join(item["slot"] for item in slots) + "合计"
    elif count == 3:
        label = "三时段合计"
    else:
        label = f"{count}时段合计" if count else "暂无已开课时段"
    has_baseline = bool(slots) and all(item["hasBaseline"] for item in slots)
    current_expected = sum(
        row["current"]["liveExpected"]
        for rows in grouped.values()
        for row in rows
    )
    current_attend = sum(
        row["current"]["liveAttend"]
        for rows in grouped.values()
        for row in rows
    )
    previous_expected = sum(
        row["previous"]["liveExpected"]
        for rows in grouped.values()
        for row in rows
    )
    previous_attend = sum(
        row["previous"]["liveAttend"]
        for rows in grouped.values()
        for row in rows
    )
    current_average = pct(current_attend, current_expected) if current_expected else None
    previous_average = pct(previous_attend, previous_expected) if has_baseline else None
    def student_map(key, period):
        return {
            str(student.get("id")): {"id": str(student.get("id")), "name": str(student.get("name") or "")}
            for rows in grouped.values()
            for row in rows
            for student in row[period].get(key, [])
            if str(student.get("id") or "")
        }

    current_expected_students = student_map("liveExpectedList", "current")
    current_attend_students = student_map("liveAttendList", "current")
    previous_expected_students = student_map("liveExpectedList", "previous")
    previous_attend_students = student_map("liveAttendList", "previous")
    comparable_ids = set(current_expected_students) & set(previous_expected_students)
    last_week_came_this_week_missed = (set(previous_attend_students) & comparable_ids) - set(current_attend_students)
    last_week_missed_this_week_came = (set(previous_expected_students) - set(previous_attend_students)) & set(current_attend_students) & comparable_ids
    def student_list(ids):
        merged = {**previous_expected_students, **current_expected_students}
        return sorted(
            (merged[uid] for uid in ids),
            key=lambda student: (student.get("name") or "", student["id"]),
        )
    return {
        "label": label,
        "slotCount": count,
        "slots": slots,
        "currentRate": current_average,
        "previousRate": previous_average,
        # Retained for compatibility with already-open dashboard pages.
        "currentAverage": current_average,
        "previousAverage": previous_average,
        "gap": current_average - previous_average if has_baseline else None,
        "hasBaseline": has_baseline,
        "currentExpected": current_expected,
        "currentAttend": current_attend,
        "previousExpected": previous_expected,
        "previousAttend": previous_attend,
        "missingSlots": [item["slot"] for item in slots if not item["hasBaseline"]],
        "attendanceChanges": {
            "lastWeekCameThisWeekMissed": student_list(last_week_came_this_week_missed) if has_baseline else [],
            "lastWeekMissedThisWeekCame": student_list(last_week_missed_this_week_came) if has_baseline else [],
        },
    }


def item_map(block, lesson_number):
    candidates = [
        lesson for lesson in block.get("lessons", [])
        if int(lesson.get("course_number") or 0) == int(lesson_number)
    ]
    if not candidates:
        return None, []
    lesson = min(candidates, key=lambda item: (int(item.get("unlock_time") or 0), int(item.get("course_id") or 0)))
    cid = int(lesson["course_id"])
    return lesson, [x for x in block.get("items", []) if int(x.get("course_id") or 0) == cid]


def lesson_pairs(block):
    """Return real weekly first/second lesson pairs.

    CRM course numbers can contain gaps after inserted lessons (for example
    48/49 then 51/52), so odd/even arithmetic is not a stable pairing rule.
    Lessons sharing the same unlock time are one weekly pair; a live-board key
    identifies the first lesson when available.
    """
    groups = {}
    for lesson in block.get("lessons", []):
        number = int(lesson.get("course_number") or 0)
        unlock = int(lesson.get("unlock_time") or 0)
        name = str(lesson.get("course_name") or "")
        if number <= 0 or unlock <= 0 or "赛考精讲" in name:
            continue
        groups.setdefault(unlock, []).append(lesson)
    board_numbers = {int(key) for key in (block.get("liveAttendance") or {}) if str(key).isdigit()}
    pairs = []
    for unlock, lessons in sorted(groups.items()):
        ordered = sorted(lessons, key=lambda item: (int(item.get("course_number") or 0), int(item.get("course_id") or 0)))
        first = next((item for item in ordered if int(item.get("course_number") or 0) in board_numbers), None)
        if first is not None:
            later = [item for item in ordered if int(item.get("course_number") or 0) > int(first.get("course_number") or 0)]
            second = later[0] if later else None
        else:
            first, second = (ordered[0], ordered[1]) if len(ordered) >= 2 else (None, None)
        if first is not None and second is not None:
            pairs.append((first, second))
    return pairs


def period_metrics(block, start, end, now, allow_detail_live=False):
    result = {"arrivalExpected": 0, "arrivalAttend": 0, "liveExpected": 0, "liveAttend": 0, "replayAttend": 0, "evenExpected": 0, "evenDone": 0, "arrivedIncomplete": 0, "missingLiveBoards": 0, "detailLiveFallbacks": 0, "incompleteIds": set(), "arrivedIncompleteIds": set(), "liveExpectedIds": set(), "liveAttendIds": set(), "liveAbsentIds": set(), "replayIds": set(), "latestOpenedTime": 0}
    for live_lesson, even_lesson in lesson_pairs(block):
        live_number = int(live_lesson.get("course_number") or 0)
        even_rows = [x for x in block.get("items", []) if int(x.get("course_id") or 0) == int(even_lesson.get("course_id") or 0)]
        even_time = int(even_lesson.get("unlock_time") or 0)
        pair_open = start <= even_time < end and even_time <= now
        if pair_open:
            first_rows = [x for x in block.get("items", []) if int(x.get("course_id") or 0) == int(live_lesson.get("course_id") or 0)]
            first_arrived_ids = {str(x.get("user_id")) for x in first_rows if x.get("user_id") and bool(x.get("is_open"))}
            finished_ids = {str(x.get("user_id")) for x in even_rows if x.get("user_id") and bool(x.get("is_finish"))}
            pair_arrived_incomplete = first_arrived_ids - finished_ids
            result["latestOpenedTime"] = max(result["latestOpenedTime"], even_time)
            result["evenExpected"] += len(even_rows)
            result["evenDone"] += sum(bool(x.get("is_finish")) for x in even_rows)
            result["arrivedIncomplete"] += len(pair_arrived_incomplete)
            result["incompleteIds"].update(str(x.get("user_id")) for x in even_rows if not bool(x.get("is_finish")))
            result["arrivedIncompleteIds"].update(pair_arrived_incomplete)
        live_rows = [x for x in block.get("items", []) if int(x.get("course_id") or 0) == int(live_lesson.get("course_id") or 0)]
        live_time = int(live_lesson.get("unlock_time") or 0)
        # A weekly pair belongs to the period of its real even-numbered lesson.
        # This prevents an inserted/duplicate odd lesson from being counted as a
        # second live class before its paired even lesson opens.
        if pair_open and live_time <= now:
            result["arrivalExpected"] += len(live_rows)
            result["arrivalAttend"] += sum(bool(x.get("is_open")) for x in live_rows)
            result["latestOpenedTime"] = max(result["latestOpenedTime"], live_time)
            board = (block.get("liveAttendance") or {}).get(str(live_number)) or (block.get("liveAttendance") or {}).get(live_number)
            if not board:
                if not allow_detail_live:
                    # Group members remain protected by the authoritative
                    # live-board gate; an absent room can never become a zero.
                    result["missingLiveBoards"] += 1
                    continue
                # Explicitly configured same-cohort comparison teachers may
                # not be visible to this group's live-room API. In that case
                # use CRM course-detail's live_course participation flag.
                expected_ids = {str(x.get("user_id")) for x in live_rows if x.get("user_id")}
                attended_ids = {str(x.get("user_id")) for x in live_rows if x.get("user_id") and bool(x.get("live_course"))}
                absent_ids = expected_ids - attended_ids
                result["detailLiveFallbacks"] += 1
            else:
                attended_ids = set(str(x) for x in (board or {}).get("attendedIds", []))
                expected_ids = set(str(x) for x in (board or {}).get("expectedIds", []))
                absent_ids = set(str(x) for x in (board or {}).get("absentIds", []))
            result["liveExpected"] += len(expected_ids)
            result["liveAttend"] += len(attended_ids)
            result["liveExpectedIds"].update(expected_ids)
            result["liveAttendIds"].update(attended_ids)
            result["liveAbsentIds"].update(absent_ids)
            replayed = lambda x: str(x.get("user_id")) not in attended_ids and (int(x.get("watch_time") or 0) > 0 or float(x.get("watch_process") or 0) > 0)
            result["replayAttend"] += sum(replayed(x) for x in live_rows)
            result["replayIds"].update(str(x.get("user_id")) for x in live_rows if replayed(x))
    return result


def merge_metrics(target, source):
    for key in ("arrivalExpected", "arrivalAttend", "liveExpected", "liveAttend", "replayAttend", "evenExpected", "evenDone", "arrivedIncomplete", "missingLiveBoards", "detailLiveFallbacks"):
        target[key] += source[key]
    target["incompleteIds"].update(source["incompleteIds"])
    target["arrivedIncompleteIds"].update(source["arrivedIncompleteIds"])
    target["liveExpectedIds"].update(source["liveExpectedIds"])
    target["liveAttendIds"].update(source["liveAttendIds"])
    target["liveAbsentIds"].update(source["liveAbsentIds"])
    target["replayIds"].update(source["replayIds"])
    target["latestOpenedTime"] = max(target["latestOpenedTime"], source["latestOpenedTime"])


def iter_json_array(path, chunk_size=1024 * 1024):
    """Stream top-level JSON array items without loading the full CRM export."""
    decoder = json.JSONDecoder()
    buffer = ""
    started = False
    eof = False
    with path.open("r", encoding="utf-8-sig") as handle:
        while True:
            if not eof:
                chunk = handle.read(chunk_size)
                if chunk:
                    buffer += chunk
                else:
                    eof = True
            while True:
                buffer = buffer.lstrip()
                if not started:
                    if not buffer:
                        break
                    if buffer[0] != "[":
                        raise ValueError("CRM 原始数据不是 JSON 数组")
                    started = True
                    buffer = buffer[1:]
                    continue
                buffer = buffer.lstrip()
                if buffer.startswith(","):
                    buffer = buffer[1:]
                    continue
                if buffer.startswith("]"):
                    return
                if not buffer:
                    break
                try:
                    item, end = decoder.raw_decode(buffer)
                except json.JSONDecodeError:
                    if eof:
                        raise
                    break
                yield item
                buffer = buffer[end:]
            if eof:
                if buffer.strip():
                    raise ValueError("CRM 原始数据尾部不完整")
                return


def eligible_block(block, now):
    lessons = block.get("lessons") or []
    unlocks = [int(x.get("unlock_time") or 0) for x in lessons if int(x.get("unlock_time") or 0) > 0]
    return (
        not block.get("excluded")
        and teacher_name(block.get("info", {}).get("teacherName")) != "薛超"
        and bool(unlocks)
        and min(unlocks) <= now
    )


def main():
    try:
        dashboard_config = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        dashboard_config = {}
    comparison_teachers = {
        str(name).strip() for name in dashboard_config.get("comparisonTeachers", [])
        if str(name).strip()
    }
    if not RAW.exists():
        raise RuntimeError("尚未生成 CRM 最新数据，请先点击“更新组内教学数据”")
    now = int(time.time())
    today = datetime.fromtimestamp(now, CN).replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = int(today.timestamp())
    tomorrow_start = int((today + timedelta(days=1)).timestamp())
    today_label = today.strftime("%Y-%m-%d")
    opened_weeks = set()
    cohort_opened_weeks = {}
    for block in iter_json_array(RAW):
        if not eligible_block(block, now):
            continue
        unlocks = [int(lesson.get("unlock_time") or 0) for lesson in block.get("lessons", []) if int(lesson.get("unlock_time") or 0) > 0]
        cohort_start = week_start(min(unlocks))
        # Keep the latest opened week independently for every cohort.  A
        # single group-wide week made completed cohorts appear as zero data.
        populated_course_ids = {int(item.get("course_id") or 0) for item in block.get("items", []) if int(item.get("course_id") or 0) > 0}
        block_weeks = {
            week_start(int(second.get("unlock_time") or 0))
            for _first, second in lesson_pairs(block)
            if 0 < int(second.get("unlock_time") or 0) <= now
            and int(second.get("course_id") or 0) in populated_course_ids
        }
        if not block_weeks:
            block_weeks = {
                week_start(int(lesson.get("unlock_time") or 0))
                for _first, lesson in lesson_pairs(block)
                if 0 < int(lesson.get("unlock_time") or 0) <= now
                and int(lesson.get("course_id") or 0) in populated_course_ids
            }
        opened_weeks.update(block_weeks)
        cohort_opened_weeks.setdefault(cohort_start, set()).update(block_weeks)
    opened_weeks = sorted(opened_weeks)
    if not opened_weeks:
        raise RuntimeError("CRM 数据中没有已开课课程")
    current_start = max(opened_weeks)
    previous_start = previous_opened_week(opened_weeks, current_start)
    labels = {"current": datetime.fromtimestamp(current_start, CN).strftime("%m月%d日周"), "previous": datetime.fromtimestamp(previous_start, CN).strftime("%m月%d日周")}
    teachers = {}
    classes = []
    daily_makeup_records = {}
    for block in iter_json_array(RAW):
        if not eligible_block(block, now):
            continue
        info = block.get("info", {})
        teacher = teacher_name(info.get("teacherName"))
        if not teacher:
            continue
        first_time = min(int(x.get("unlock_time") or 0) for x in block["lessons"] if int(x.get("unlock_time") or 0) > 0)
        cohort_start = week_start(first_time)
        cohort = datetime.fromtimestamp(cohort_start, CN).strftime("%Y-%m-%d周")
        first_label = datetime.fromtimestamp(first_time, CN).strftime("%Y-%m-%d %H:%M")
        lesson_by_id = {int(item.get("course_id") or 0): item for item in block.get("lessons", [])}
        roster = {}
        for x in block.get("items", []):
            uid = str(x.get("user_id") or "")
            if uid:
                roster[uid] = str(x.get("child_name") or x.get("nickname") or "")
            finished_at = parse_crm_time(x.get("course_finish_time"))
            unlock_time = int(x.get("unlock_time") or lesson_by_id.get(int(x.get("course_id") or 0), {}).get("unlock_time") or 0)
            if (
                uid
                and bool(x.get("is_finish"))
                and finished_at is not None
                and today_start <= int(finished_at.timestamp()) < tomorrow_start
                and 0 < unlock_time < today_start
            ):
                record = {
                    "id": uid,
                    "name": str(x.get("child_name") or x.get("nickname") or ""),
                    "courseNumber": int(x.get("course_number") or lesson_by_id.get(int(x.get("course_id") or 0), {}).get("course_number") or 0),
                    "completedAt": finished_at.strftime("%Y-%m-%d %H:%M"),
                    "time": finished_at.strftime("%H:%M"),
                    "classId": int(block.get("classId") or info.get("classId") or 0),
                    "className": str(info.get("className") or x.get("class_name") or ""),
                }
                daily_makeup_records.setdefault((cohort, teacher), []).append(record)
        for attendance in (block.get("liveAttendance") or {}).values():
            roster.update({str(uid): str(name or "") for uid, name in (attendance.get("names") or {}).items()})
        cohort_weeks = cohort_opened_weeks.get(cohort_start) or {current_start}
        block_current_start = max(cohort_weeks)
        block_previous_start = previous_opened_week(cohort_weeks, block_current_start)
        allow_detail_live = teacher in comparison_teachers
        current = period_metrics(block, block_current_start, block_current_start + 7 * 86400, now, allow_detail_live)
        previous = period_metrics(block, block_previous_start, block_previous_start + 7 * 86400, now, allow_detail_live)
        recent_time = current["latestOpenedTime"] or previous["latestOpenedTime"] or first_time
        class_current = public_metrics(current, roster)
        class_previous = public_metrics(previous, roster)
        class_row = {"classId": int(block.get("classId") or info.get("classId") or 0), "className": str(info.get("className") or ""), "teacher": teacher, "cohort": cohort, "slot": slot_label(first_time), "recentClassTime": datetime.fromtimestamp(recent_time, CN).strftime("%Y-%m-%d %H:%M"),
                     "students": [{"id": uid, "name": name} for uid, name in sorted(roster.items(), key=lambda x: x[1])],
                     "current": class_current, "previous": class_previous,
                     "liveDelta": class_current["liveRate"] - class_previous["liveRate"] if class_previous["liveExpected"] else None,
                     "replayDelta": class_current["replayRate"] - class_previous["replayRate"],
                     "finishDelta": class_current["finishRate"] - class_previous["finishRate"]}
        class_row["currentWeek"] = datetime.fromtimestamp(block_current_start, CN).strftime("%Y-%m-%d")
        class_row["liveLessonNumbers"] = [
            int(first.get("course_number") or 0)
            for first, second in lesson_pairs(block)
            if block_current_start <= int(second.get("unlock_time") or 0) < block_current_start + 7 * 86400
            and int(second.get("unlock_time") or 0) <= now
        ]
        # Class-level risk details and the summary count only include classes
        # that have an actually opened lesson in the displayed current period.
        # Future Saturday sessions must not dilute Friday-only rates.
        if current["latestOpenedTime"]:
            classes.append(class_row)
        teacher_key = (cohort, teacher)
        if teacher_key not in teachers:
            teachers[teacher_key] = {"teacher": teacher, "cohort": cohort, "currentStart": block_current_start, "cohorts": set(), "firstTimes": [], "students": {},
                                 "current": {"arrivalExpected": 0, "arrivalAttend": 0, "liveExpected": 0, "liveAttend": 0, "replayAttend": 0, "evenExpected": 0, "evenDone": 0, "arrivedIncomplete": 0, "missingLiveBoards": 0, "detailLiveFallbacks": 0, "incompleteIds": set(), "arrivedIncompleteIds": set(), "liveExpectedIds": set(), "liveAttendIds": set(), "liveAbsentIds": set(), "replayIds": set(), "latestOpenedTime": 0},
                                 "previous": {"arrivalExpected": 0, "arrivalAttend": 0, "liveExpected": 0, "liveAttend": 0, "replayAttend": 0, "evenExpected": 0, "evenDone": 0, "arrivedIncomplete": 0, "missingLiveBoards": 0, "detailLiveFallbacks": 0, "incompleteIds": set(), "arrivedIncompleteIds": set(), "liveExpectedIds": set(), "liveAttendIds": set(), "liveAbsentIds": set(), "replayIds": set(), "latestOpenedTime": 0}}
        t = teachers[teacher_key]
        t["cohorts"].add(cohort); t["firstTimes"].append(first_time); t["students"].update(roster)
        merge_metrics(t["current"], current); merge_metrics(t["previous"], previous)
    service_updated_at = ""
    service_by_teacher = {}
    daily_service_by_teacher = {}
    daily_service_date = ""
    daily_service_selection = {}
    if SERVICE.exists():
        try:
            service_payload = json.loads(SERVICE.read_text(encoding="utf-8-sig"))
            service_updated_at = str(service_payload.get("updatedAt") or "")
            service_by_teacher = {
                str(item.get("\u8001\u5e08") or "").strip(): item
                for item in service_payload.get("teachers", [])
                if str(item.get("\u8001\u5e08") or "").strip()
            }
            daily_payload = service_payload.get("today") or {}
            daily_service_date = str(daily_payload.get("date") or "")
            if daily_service_date == today_label:
                daily_service_by_teacher = {
                    str(item.get("\u8001\u5e08") or "").strip(): item
                    for item in daily_payload.get("teachers", [])
                    if str(item.get("\u8001\u5e08") or "").strip()
                }
            daily_service_selection = service_payload.get("serviceSelection") or {}
        except (OSError, ValueError, TypeError):
            service_by_teacher = {}
            daily_service_by_teacher = {}
    rows = []
    for t in teachers.values():
        c, p = t["current"], t["previous"]
        first = min(t["firstTimes"])
        recent_time = c["latestOpenedTime"] or p["latestOpenedTime"] or first
        row = {"teacher": t["teacher"], "cohort": t["cohort"], "currentWeek": datetime.fromtimestamp(t["currentStart"], CN).strftime("%Y-%m-%d周"), "recentClassTime": datetime.fromtimestamp(recent_time, CN).strftime("%Y-%m-%d %H:%M"),
               "current": public_metrics(c, t["students"]), "previous": public_metrics(p, t["students"], False)}
        teacher_classes = [item for item in classes if item["teacher"] == t["teacher"] and item["cohort"] == t["cohort"]]
        row["timelyLiveComparison"] = timely_live_comparison(teacher_classes)
        row["liveDelta"] = row["timelyLiveComparison"]["gap"]
        row["replayDelta"] = row["current"]["replayRate"] - row["previous"]["replayRate"]
        row["finishDelta"] = row["current"]["finishRate"] - row["previous"]["finishRate"]
        makeup_students = daily_makeup_students(daily_makeup_records.get((t["cohort"], t["teacher"]), []))
        row["dailyMakeup"] = {"date": today_label, "count": len(makeup_students), "students": makeup_students}
        service = service_by_teacher.get(t["teacher"], {})
        daily_service = daily_service_by_teacher.get(t["teacher"], {})
        def service_rate(key):
            value = service.get(key)
            try:
                return float(value) / 100 if value is not None and value != "" else None
            except (TypeError, ValueError):
                return None
        row["service"] = {
            "employeeId": str(service.get("\u5de5\u53f7") or ""),
            "imRate": service_rate("im"),
            "wecomRate": service_rate("wecom"),
            "todayDate": daily_service_date if daily_service_by_teacher else "",
            "voiceDialCount": numeric_or_none(daily_service.get("voiceDialCount")),
            "voiceConnectedCount": numeric_or_none(daily_service.get("voiceConnectedCount")),
            "videoDialCount": numeric_or_none(daily_service.get("videoDialCount")),
            "videoConnectedCount": numeric_or_none(daily_service.get("videoConnectedCount")),
            "callUsers": numeric_or_none(daily_service.get("callUsers")),
            "videoCallUsers": numeric_or_none(daily_service.get("videoCallUsers")),
            "dailyCall": daily_call_metrics(daily_service),
            "updatedAt": service_updated_at,
        }
        rows.append(row)
    missing_live = [f"{item['cohort']} {item['teacher']}" for item in rows if item["current"].get("missingLiveBoards")]
    if missing_live:
        raise RuntimeError("CRM直播房间数据不完整，已保留上一轮正确看板：" + "、".join(missing_live))
    rows.sort(key=lambda x: (x["cohort"], -x["current"]["finishRate"], -x["current"]["liveRate"], x["teacher"]))
    by_cohort = {}
    for row in rows: by_cohort.setdefault(row["cohort"], []).append(row)
    for peers in by_cohort.values():
        live_avg = sum(x["current"]["liveRate"] for x in peers) / len(peers)
        finish_avg = sum(x["current"]["finishRate"] for x in peers) / len(peers)
        for row in peers:
            row["liveAnomaly"] = row["current"]["liveRate"] < live_avg
            row["finishAnomaly"] = row["current"]["finishRate"] < finish_avg
            row["cohortLiveAverage"] = live_avg
            row["cohortFinishAverage"] = finish_avg
            row["cohortLiveGap"] = row["current"]["liveRate"] - live_avg
            row["cohortFinishGap"] = row["current"]["finishRate"] - finish_avg
    arrival_expected = sum(x["current"]["arrivalExpected"] for x in rows); live_expected = sum(x["current"]["liveExpected"] for x in rows); even_expected = sum(x["current"]["evenExpected"] for x in rows)
    group_teacher_names = {
        row["teacher"] for row in rows
        if row["teacher"] not in comparison_teachers and row["teacher"] != "薛超"
    }
    group_teacher_names.update(name for name in service_by_teacher if name and name != "薛超")
    makeup_by_teacher = {}
    calls_by_teacher = {}
    for row in rows:
        if row["teacher"] not in group_teacher_names:
            continue
        makeup_by_teacher.setdefault(row["teacher"], {})
        for student in row["dailyMakeup"]["students"]:
            makeup_by_teacher[row["teacher"]][student["id"]] = student
        calls_by_teacher[row["teacher"]] = row.get("service", {}).get("dailyCall") or daily_call_metrics({})
    call_totals = {
        "dial": sum(item.get("dial", 0) for item in calls_by_teacher.values()),
        "connected": sum(item.get("connected", 0) for item in calls_by_teacher.values()),
        "voiceDial": sum(item.get("voiceDial", 0) for item in calls_by_teacher.values()),
        "voiceConnected": sum(item.get("voiceConnected", 0) for item in calls_by_teacher.values()),
        "videoDial": sum(item.get("videoDial", 0) for item in calls_by_teacher.values()),
        "videoConnected": sum(item.get("videoConnected", 0) for item in calls_by_teacher.values()),
    }
    call_totals["rate"] = pct(call_totals["connected"], call_totals["dial"])
    group_daily = {
        "date": today_label,
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "serviceDate": daily_service_date if daily_service_by_teacher else "",
        "serviceUpdatedAt": service_updated_at,
        "serviceWindow": {
            "startHour": int(daily_service_selection.get("startHour", 14)),
            "endHour": int(daily_service_selection.get("endHour", 21)),
        },
        "totals": {
            "makeupStudents": sum(len(items) for items in makeup_by_teacher.values()),
            "videoDialCount": sum(numeric_or_none(daily_service_by_teacher.get(name, {}).get("videoDialCount")) or 0 for name in group_teacher_names) if daily_service_by_teacher else None,
            "voiceDialCount": sum(numeric_or_none(daily_service_by_teacher.get(name, {}).get("voiceDialCount")) or 0 for name in group_teacher_names) if daily_service_by_teacher else None,
            "callDialCount": call_totals["dial"] if daily_service_by_teacher else None,
            "callConnectedCount": call_totals["connected"] if daily_service_by_teacher else None,
            "callConnectRate": call_totals["rate"] if daily_service_by_teacher else None,
            "voiceConnectedCount": call_totals["voiceConnected"] if daily_service_by_teacher else None,
            "videoConnectedCount": call_totals["videoConnected"] if daily_service_by_teacher else None,
        },
        "rankings": {
            "makeup": sorted(
                ({"teacher": name, "value": len(makeup_by_teacher.get(name, {}))} for name in group_teacher_names),
                key=lambda item: (-item["value"], item["teacher"]),
            ),
            "videoCalls": sorted(
                ({"teacher": name, "value": numeric_or_none(daily_service_by_teacher.get(name, {}).get("videoDialCount"))} for name in group_teacher_names),
                key=lambda item: (item["value"] is None, -(item["value"] or 0), item["teacher"]),
            ),
            "voiceCalls": sorted(
                ({"teacher": name, "value": numeric_or_none(daily_service_by_teacher.get(name, {}).get("voiceDialCount"))} for name in group_teacher_names),
                key=lambda item: (item["value"] is None, -(item["value"] or 0), item["teacher"]),
            ),
        },
    }
    cohort_week_labels = {datetime.fromtimestamp(start, CN).strftime("%Y-%m-%d周"): datetime.fromtimestamp(max(weeks), CN).strftime("%Y-%m-%d周") for start, weeks in cohort_opened_weeks.items() if weeks}
    snapshot = {"updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "serviceUpdatedAt": service_updated_at, "weeks": labels, "cohortWeeks": cohort_week_labels, "cohorts": sorted(by_cohort), "rows": rows, "classes": classes,
                "summary": {"teachers": len(rows), "classes": len(classes), "arrivalRate": pct(sum(x["current"]["arrivalAttend"] for x in rows), arrival_expected), "liveRate": pct(sum(x["current"]["liveAttend"] for x in rows), live_expected), "replayRate": pct(sum(x["current"]["replayAttend"] for x in rows), live_expected), "finishRate": pct(sum(x["current"]["evenDone"] for x in rows), even_expected)},
                "groupDaily": group_daily}
    OUT.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
