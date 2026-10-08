from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent)
RAW = ROOT / "run-data" / "group-lessons-raw.json"
OUT = ROOT / "run-data" / "exception-export-tables.json"
CLASSES = ROOT / "run-data" / "classes.json"
CN = timezone(timedelta(hours=8))


CONSECUTIVE_COLUMNS = ["老师姓名", "落课≥2周学员总数", "连续2周学员数", "连续3周及以上学员数", "最长连续周数", "统计周期"]


def visible_phone(value):
    """Keep only a CRM-visible phone number; never export encrypted payloads."""
    text = str(value or "").strip()
    visible = text.split("||", 1)[0].strip()
    digits = re.sub(r"\D", "", visible)
    return visible if len(digits) >= 7 and "*" not in visible else "CRM未提供明文"


def build_consecutive_incomplete(blocks, main_term_by_class, now):
    """Build the latest opened teaching weeks' repeated-incomplete list."""
    week_records = {}
    opened_weeks = set()
    for block in blocks:
        info = block.get("info", {})
        teacher = clean_teacher(info.get("teacherName"))
        class_id = int(block.get("classId") or info.get("classId") or 0)
        class_name = str(info.get("className") or "")
        main_term = main_term_by_class.get(class_id, int(block.get("termId") or info.get("termId") or 0))
        slot = schedule_label(block.get("items", []))
        lessons_by_time = {}
        for lesson in block.get("lessons", []):
            number = int(lesson.get("course_number") or 0)
            unlock = int(lesson.get("unlock_time") or 0)
            if number > 0 and 0 < unlock <= now:
                lessons_by_time.setdefault(unlock, []).append(lesson)
        for unlock, same_time_lessons in lessons_by_time.items():
            ordered = sorted(same_time_lessons, key=lambda item: (int(item.get("course_number") or 0), int(item.get("course_id") or 0)))
            if len(ordered) < 2:
                continue
            completion = ordered[1]
            course_id = int(completion.get("course_id") or 0)
            week_start = monday(unlock)
            opened_weeks.add(week_start)
            for item in block.get("items", []):
                if int(item.get("course_id") or 0) != course_id or bool(item.get("is_finish")):
                    continue
                student_id = str(item.get("user_id") or "").strip()
                if not student_id:
                    continue
                record = {
                    "id": student_id,
                    "name": str(item.get("child_name") or item.get("nickname") or ""),
                    "phone": visible_phone(item.get("phone_number") or item.get("bind_phone_number")),
                    "teacher": teacher,
                    "term": main_term,
                    "classId": class_id,
                    "className": class_name,
                    "slot": slot,
                    "courseNumber": int(completion.get("course_number") or 0),
                }
                # A learner can be duplicated after a class transfer. Prefer the
                # record carrying a visible phone, otherwise keep the latest row.
                previous = week_records.setdefault(week_start, {}).get(student_id)
                if not previous or (previous["phone"] == "CRM未提供明文" and record["phone"] != "CRM未提供明文"):
                    week_records[week_start][student_id] = record
    opened_weeks = sorted(opened_weeks)
    if len(opened_weeks) < 2:
        return [], ""
    latest_week = opened_weeks[-1]
    if latest_week not in week_records:
        return [], ""
    # Track consecutive opened teaching weeks. Calendar weeks without opened
    # lessons, such as holidays, should not break a learner's falling-behind
    # streak.
    consecutive_weeks = opened_weeks
    period_start = opened_weeks[-2]
    period = f"{datetime.fromtimestamp(period_start, CN):%Y-%m-%d}至{datetime.fromtimestamp(latest_week + 6 * 86400, CN):%Y-%m-%d}"
    rows = []
    latest_ids = set(week_records[latest_week])
    for student_id in latest_ids:
        streak = []
        for week_start in reversed(consecutive_weeks):
            record = week_records.get(week_start, {}).get(student_id)
            if not record:
                break
            streak.append((week_start, record))
        if len(streak) < 2:
            continue
        streak.reverse()
        first_week, older = streak[0]
        second_week, latest = streak[-1]
        phone = next((record["phone"] for _week, record in reversed(streak) if record["phone"] != "CRM未提供明文"), "CRM未提供明文")
        first_label = f"{datetime.fromtimestamp(first_week, CN):%m-%d}周"
        second_label = f"{datetime.fromtimestamp(second_week, CN):%m-%d}周"
        rows.append([
            student_id, latest["name"] or older["name"], phone, latest["teacher"], latest["term"],
            latest["classId"], latest["className"], latest["slot"],
            f"{first_label}｜第{older['courseNumber']}课", f"{second_label}｜第{latest['courseNumber']}课", len(streak),
            "待安排", "", "请尽快完成课程，避免影响后续比赛安排。", "否", "待跟进", "", "", period,
        ])
    rows.sort(key=lambda row: (row[3], row[7], row[1], row[0]))
    return rows, period


def clean_teacher(value):
    text = str(value or "")
    return text.rsplit("-C", 1)[0] if "-C" in text else text


def previous_week_label(value):
    """Return the prior Monday label for a snapshot week such as 2026-09-14周."""
    text = str(value or "").strip().removesuffix("周")
    try:
        return (datetime.strptime(text, "%Y-%m-%d") - timedelta(days=7)).strftime("%Y-%m-%d周")
    except ValueError:
        return ""


def build_cohort_exception_rows(snapshot):
    """Expand teacher/cohort attendance changes to one filterable learner row."""
    rows = []
    categories = (
        ("lastWeekCameThisWeekMissed", "上周准时参播｜本周未准时参播", "未准时参播", "准时参播"),
        ("lastWeekMissedThisWeekCame", "上周未准时参播｜本周准时参播", "准时参播", "未准时参播"),
    )
    for teacher_row in snapshot.get("rows", []):
        comparison = teacher_row.get("timelyLiveComparison") or {}
        if not comparison.get("hasBaseline"):
            continue
        current = teacher_row.get("current") or {}
        previous = teacher_row.get("previous") or {}
        finish_has_baseline = int(previous.get("evenExpected") or 0) > 0
        current_week = str(teacher_row.get("currentWeek") or "")
        previous_week = previous_week_label(current_week)
        common = [
            str(teacher_row.get("cohort") or ""),
            str(teacher_row.get("teacher") or ""),
        ]
        for key, category, current_status, previous_status in categories:
            learners = (comparison.get("attendanceChanges") or {}).get(key) or []
            for learner in learners:
                student_id = str(learner.get("id") or "").strip()
                if not student_id:
                    continue
                rows.append(common + [
                    category,
                    str(learner.get("name") or ""),
                    student_id,
                    current_status,
                    previous_status,
                    str(comparison.get("label") or ""),
                    comparison.get("currentRate"),
                    comparison.get("previousRate"),
                    comparison.get("gap"),
                    int(comparison.get("currentAttend") or 0),
                    int(comparison.get("currentExpected") or 0),
                    int(comparison.get("previousAttend") or 0),
                    int(comparison.get("previousExpected") or 0),
                    current.get("finishRate"),
                    previous.get("finishRate") if finish_has_baseline else "",
                    (float(current.get("finishRate") or 0) - float(previous.get("finishRate") or 0)) if finish_has_baseline else "",
                    int(current.get("evenDone") or 0),
                    int(current.get("evenExpected") or 0),
                    int(previous.get("evenDone") or 0) if finish_has_baseline else "",
                    int(previous.get("evenExpected") or 0) if finish_has_baseline else "",
                    current_week,
                    previous_week,
                ])
    category_order = {
        "上周准时参播｜本周未准时参播": 0,
        "上周未准时参播｜本周准时参播": 1,
    }
    rows.sort(key=lambda row: (row[0], row[1], category_order.get(row[2], 9), row[3], row[4]))
    return rows


def monday(seconds):
    dt = datetime.fromtimestamp(seconds, CN)
    return int((dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


def schedule_label(items):
    sample = next((x for x in items if x.get("day_of_week") or x.get("class_time")), {})
    day = int(sample.get("day_of_week") or 0)
    hour = int(str(sample.get("class_time") or "19:00").split(":")[0])
    if day == 5:
        return "周五晚"
    if day == 6 and hour < 18:
        return "周六午"
    if day == 6:
        return "周六晚"
    return f"周{day} {sample.get('class_time') or ''}".strip()


def duration_over_two_hours(row):
    if not row.get("is_finish") or not row.get("course_open_time") or not row.get("course_finish_time"):
        return False
    try:
        start = datetime.strptime(str(row["course_open_time"]), "%Y-%m-%d %H:%M").replace(tzinfo=CN)
        finish = datetime.strptime(str(row["course_finish_time"]), "%Y-%m-%d %H:%M").replace(tzinfo=CN)
        return (finish - start).total_seconds() > 7200
    except ValueError:
        return False


def attended(row):
    """CRM's live-course flag means the learner attended the live session on time.

    Replay/watch/late-entry fields must not inflate the timely live attendance rate.
    """
    return bool(row.get("live_course"))


def replayed(row):
    """A replay is post-live video consumption, never a timely live seat."""
    return not attended(row) and (int(row.get("watch_time") or 0) > 0 or float(row.get("watch_process") or 0) > 0)


def abnormal_category(reasons):
    """Collapse overlapping CRM flags into one concise, mutually exclusive display category."""
    reasons = set(reasons or [])
    parts = []
    if "未参加直播" in reasons:
        parts.append("直播缺席")
    if "未到课" in reasons:
        parts.append("未到课")
    elif "到课未完课" in reasons or "未完课" in reasons:
        parts.append("课程未完成")
    if "完课时长大于2小时" in reasons:
        parts.append("完课时长偏长")
    return "｜".join(parts)


def followup_context_and_action(reason_text):
    """Turn an internal exception category into parent-friendly context and a soft next step."""
    presets = {
        "直播缺席｜未到课": (
            "这周的直播和课程进度可能都被时间安排打乱了一点",
            "回看直播重点，再进入课程完成本节内容和作品",
        ),
        "直播缺席｜课程未完成": (
            "这周直播时间可能没完全衔接上，不过课程已经开始学习，离完成只差一点收尾",
            "先回看一下直播重点，再把课程剩余内容完成并提交",
        ),
        "未到课": (
            "这周课程还没来得及展开，最近可能安排得比较满",
            "进入课程，把本节内容和作品慢慢完成",
        ),
        "课程未完成": (
            "课程已经开始学习了，离完成只差最后一点收尾",
            "把已经开始的课程继续做完，再完成最后的提交",
        ),
        "直播缺席｜完课时长偏长": (
            "这周直播时间可能没完全衔接上，课后学习又花了比较长时间，担心孩子中间遇到了一些卡点",
            "先回看直播重点，也和孩子聊聊卡在哪一步，需要的话把问题发给我一起看看",
        ),
        "直播缺席": (
            "这周直播时间可能没完全衔接上，最近的安排或许有点赶",
            "回看直播重点，再提前确认一下下次直播时间",
        ),
        "完课时长偏长": (
            "这节课孩子投入的时间比较长，担心过程中是不是遇到了一些卡点",
            "和孩子轻松聊聊哪一步花的时间比较多，有卡点就发给我一起看看",
        ),
    }
    category = str(reason_text or "").strip()
    if category in presets:
        return presets[category]
    return (
        "这周的学习节奏可能有一点小波动",
        "和孩子一起看看本周课程进度，挑一个轻松的时间往前推进一点",
    )


def followup_scripts(reason_text):
    """Create three warm, relationship-building scripts without exposing internal labels."""
    category = str(reason_text or "").strip()
    context, action = followup_context_and_action(category)
    return [
        f"家长您好，想问问#{{#学生昵称}}最近学习安排还顺利吗？{context}。如果最近时间比较赶也没关系，我们一起把节奏调顺就好。您看这两天什么时候方便{action}？有卡点随时告诉我，我来帮孩子一起梳理。",
        f"家长您好，#{{#学生昵称}}这周其实已经有一些学习积累了，接下来不用一下子赶很多。我们可以先定一个小目标：这两天找个轻松的时间{action}。我也会继续帮您留意进度，您安排好后给我回个消息，我们一起把这周的小目标稳稳完成～",
        f"家长您好，和您报个小进度～#{{#学生昵称}}这周再往前推进一小步就很棒了。建议这两天{action}。完成后您给我回个“好”或者小表情都可以，我及时给孩子一个鼓励，也方便我们一起把后面的学习节奏接稳 😊",
    ]


def main():
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    class_pairs = json.loads(CLASSES.read_text(encoding="utf-8")) if CLASSES.exists() else []
    main_term_by_class = {int(pair[0]): int(pair[1]) for pair in class_pairs if len(pair) >= 2}
    now = int(time.time())
    blocks = [b for b in raw if not b.get("excluded") and clean_teacher(b.get("info", {}).get("teacherName")) != "薛超" and b.get("lessons")]
    current = monday(now)
    opened_weeks = set()
    for block in blocks:
        lessons_by_time = {}
        populated_course_ids = {
            int(item.get("course_id") or 0)
            for item in block.get("items", [])
            if int(item.get("course_id") or 0) > 0
        }
        for lesson in block.get("lessons", []):
            unlock_time = int(lesson.get("unlock_time") or 0)
            if int(lesson.get("course_number") or 0) > 0 and unlock_time > 0:
                lessons_by_time.setdefault(unlock_time, []).append(lesson)
        for unlock_time, same_time_lessons in lessons_by_time.items():
            ordered = sorted(same_time_lessons, key=lambda item: (int(item.get("course_number") or 0), int(item.get("course_id") or 0)))
            if len(ordered) < 2:
                continue
            completion = ordered[1]
            course_id = int(completion.get("course_id") or 0)
            if 0 < unlock_time <= now and course_id in populated_course_ids:
                opened_weeks.add(monday(unlock_time))
    has_current = current in opened_weeks
    start = current if has_current else max((week for week in opened_weeks if week <= current), default=current - 7 * 86400)
    end = start + 7 * 86400
    period = f"{datetime.fromtimestamp(start, CN):%Y-%m-%d}至{datetime.fromtimestamp(end - 1, CN):%Y-%m-%d}"
    abnormal = {}
    untimely = {}
    replay_students = {}
    live_rows = []
    overview = {}
    term_first_unlock = {}
    for block in blocks:
        info = block.get("info", {})
        class_id = int(block.get("classId") or info.get("classId") or 0)
        main_term = main_term_by_class.get(class_id, int(block.get("termId") or info.get("termId") or 0))
        lesson_times = [
            int(lesson.get("unlock_time") or 0)
            for lesson in block.get("lessons", [])
            if int(lesson.get("course_number") or 0) > 0 and int(lesson.get("unlock_time") or 0) > 0
        ]
        if lesson_times:
            first_unlock = min(lesson_times)
            term_first_unlock[main_term] = min(term_first_unlock.get(main_term, first_unlock), first_unlock)
    term_short_ids = {
        term: datetime.fromtimestamp(first_unlock, CN).strftime("%m%d")
        for term, first_unlock in term_first_unlock.items()
    }
    term_first_labels = {
        term: datetime.fromtimestamp(monday(first_unlock), CN).strftime("%Y-%m-%d周")
        for term, first_unlock in term_first_unlock.items()
    }
    for block in blocks:
        info = block.get("info", {})
        teacher = clean_teacher(info.get("teacherName"))
        class_id = int(block.get("classId") or info.get("classId") or 0)
        class_name = str(info.get("className") or "")
        lessons = [lesson for lesson in block["lessons"] if int(lesson.get("course_number") or 0) > 0]
        lessons_by_time = {}
        for lesson in sorted(lessons, key=lambda item: (int(item.get("unlock_time") or 0), int(item.get("course_number") or 0), int(item.get("course_id") or 0))):
            unlock_time = int(lesson.get("unlock_time") or 0)
            if unlock_time:
                lessons_by_time.setdefault(unlock_time, []).append(lesson)
        items = block.get("items", [])
        slot = schedule_label(items)
        roster = {str(x.get("user_id")): str(x.get("child_name") or x.get("nickname") or "") for x in items if x.get("user_id")}
        for attendance in (block.get("liveAttendance") or {}).values():
            roster.update({str(uid): str(name or "") for uid, name in (attendance.get("names") or {}).items()})
        class_live_expected = class_live_attend = 0
        class_absent = set()
        opened_live_numbers = []
        main_term = main_term_by_class.get(class_id, int(block.get("termId") or info.get("termId") or 0))
        term_short_id = term_short_ids.get(main_term, "")
        main_term_label = term_first_labels.get(main_term, str(main_term))
        teacher_key = (main_term_label, teacher)
        teacher_total = overview.setdefault(teacher_key, {"classes": set(), "arrival_expected": 0, "arrival_attend": 0, "live_expected": 0, "live_attend": 0, "finish_expected": 0, "finished": 0, "arrived_unfinished": 0, "unarrived": 0, "incomplete_ids": set(), "arrived_ids": set(), "live_absent_ids": set(), "replay_ids": set()})
        # CRM course numbers are not guaranteed to remain odd/even or
        # contiguous (older cohorts can reach 60 and some templates skip
        # numbers). The two lessons sharing the same unlock time are the real
        # weekly live/completion pair.
        lesson_pairs = []
        for unlock_time, same_time_lessons in sorted(lessons_by_time.items()):
            ordered = sorted(same_time_lessons, key=lambda item: (int(item.get("course_number") or 0), int(item.get("course_id") or 0)))
            if len(ordered) >= 2:
                lesson_pairs.append((ordered[0], ordered[1]))
        for first, even in lesson_pairs:
            live_number = int(first.get("course_number") or 0)
            even_time = int(even.get("unlock_time") or 0)
            even_rows = [x for x in items if int(x.get("course_id") or 0) == int(even.get("course_id") or 0)]
            first_time = int(first.get("unlock_time") or 0)
            first_rows = [x for x in items if int(x.get("course_id") or 0) == int(first.get("course_id") or 0)]
            first_arrived_ids = {str(x.get("user_id")) for x in first_rows if x.get("user_id") and bool(x.get("is_open"))}
            pair_open = start <= even_time < end and even_time <= now
            if pair_open:
                finished_ids = {str(x.get("user_id")) for x in even_rows if x.get("user_id") and bool(x.get("is_finish"))}
                arrived_unfinished_ids = first_arrived_ids - finished_ids
                teacher_total["classes"].add(class_id)
                teacher_total["finish_expected"] += len(even_rows)
                teacher_total["finished"] += sum(bool(x.get("is_finish")) for x in even_rows)
                teacher_total["arrived_unfinished"] += len(arrived_unfinished_ids)
                teacher_total["unarrived"] += len({str(x.get("user_id")) for x in even_rows if x.get("user_id")} - first_arrived_ids)
                teacher_total["arrived_ids"].update(arrived_unfinished_ids)
                for row in even_rows:
                    uid = str(row.get("user_id") or "")
                    if not uid:
                        continue
                    key = (teacher, class_id, uid)
                    rec = abnormal.setdefault(key, {"teacher": teacher, "termShortId": term_short_id, "student": roster.get(uid, ""), "id": uid, "slot": slot, "reasons": set()})
                    if duration_over_two_hours(row):
                        rec["reasons"].add("完课时长大于2小时")
                    if not row.get("is_finish"):
                        teacher_total["incomplete_ids"].add(uid)
                        rec["reasons"].add("未完课")
                        rec["reasons"].add("到课未完课" if uid in first_arrived_ids else "未到课")
            live = first
            live_time = first_time
            live_items = first_rows
            # Attribute both halves of a weekly pair by the actual even lesson.
            # Array position and an independently opened odd lesson are not a
            # valid substitute for CRM's real course_number pairing.
            if pair_open and live_time <= now:
                teacher_total["arrival_expected"] += len(live_items)
                teacher_total["arrival_attend"] += len(first_arrived_ids)
                board = (block.get("liveAttendance") or {}).get(str(live_number)) or (block.get("liveAttendance") or {}).get(live_number)
                if block.get("liveAttendance") and not board:
                    continue
                attended_ids = set(str(x) for x in (board or {}).get("attendedIds", []))
                expected_ids = set(str(x) for x in (board or {}).get("expectedIds", []))
                absent_ids = set(str(x) for x in (board or {}).get("absentIds", []))
                live_expected = len(expected_ids) if board else len(live_items)
                live_attend = len(attended_ids) if board else sum(attended(x) for x in live_items)
                teacher_total["classes"].add(class_id)
                opened_live_numbers.append(live_number)
                class_live_expected += live_expected
                class_live_attend += live_attend
                teacher_total["live_expected"] += live_expected
                teacher_total["live_attend"] += live_attend
                for row in live_items:
                    uid = str(row.get("user_id") or "")
                    is_timely = uid in attended_ids if board else attended(row)
                    if uid and not is_timely and (int(row.get("watch_time") or 0) > 0 or float(row.get("watch_process") or 0) > 0):
                        teacher_total["replay_ids"].add(uid)
                        replay_students[(teacher, class_id, uid, live_number)] = [teacher, roster.get(uid, ""), uid, slot, class_id, class_name, live_number, int(row.get("watch_time") or 0), float(row.get("watch_process") or 0) / 100, period]
                current_absent = absent_ids if board else set(str(row.get("user_id") or "") for row in live_items if not attended(row))
                for uid in current_absent:
                    if not uid: continue
                    class_absent.add(uid)
                    teacher_total["live_absent_ids"].add(uid)
                    untimely[(teacher, class_id, uid)] = [teacher, roster.get(uid, ""), uid, slot, class_id, class_name, live_number, period]
                    key = (teacher, class_id, uid)
                    rec = abnormal.setdefault(key, {"teacher": teacher, "termShortId": term_short_id, "student": roster.get(uid, ""), "id": uid, "slot": slot, "reasons": set()})
                    rec["reasons"].add("未参加直播")
        if class_live_expected:
            live_rows.append([teacher, slot, class_id, class_name, ",".join(map(str, opened_live_numbers)), class_live_expected, class_live_attend, class_live_expected - class_live_attend, len(class_absent), class_live_attend / class_live_expected, period])
    abnormal_rows = []
    for rec in abnormal.values():
        if not rec["reasons"]:
            continue
        category = abnormal_category(rec["reasons"])
        if "未完课" in rec["reasons"]:
            level = "一级｜未完课（最高）"
        elif "未参加直播" in rec["reasons"]:
            level = "二级｜未准时参播"
        else:
            level = "三级｜完课时长异常"
        abnormal_rows.append([level, rec["teacher"], rec["termShortId"], rec["student"], rec["id"], rec["slot"], category, period])
    priority = {"一级｜未完课（最高）": 1, "二级｜未准时参播": 2, "三级｜完课时长异常": 3}
    abnormal_rows.sort(key=lambda x: (priority.get(x[0], 9), x[2], x[1], ["周五晚", "周六午", "周六晚"].index(x[5]) if x[5] in ("周五晚", "周六午", "周六晚") else 9, x[3], x[4]))
    category_specs = [
        ("一级｜未完课（最高）", "直播缺席｜未到课", "一级·直播缺席+未到课"),
        ("一级｜未完课（最高）", "直播缺席｜课程未完成", "一级·直播缺席+课程未完成"),
        ("一级｜未完课（最高）", "未到课", "一级·未到课"),
        ("一级｜未完课（最高）", "课程未完成", "一级·课程未完成"),
        ("二级｜未准时参播", "直播缺席｜完课时长偏长", "二级·直播缺席+时长偏长"),
        ("二级｜未准时参播", "直播缺席", "二级·直播缺席"),
        ("三级｜完课时长异常", "完课时长偏长", "三级·时长偏长"),
    ]
    category_order = {category: index for index, (_, category, _) in enumerate(category_specs)}
    category_levels = {row[6]: row[0] for row in abnormal_rows}
    recommended_rows = [
        [category, *followup_scripts(category), period]
        for category in sorted(category_levels, key=lambda value: category_order.get(value, 99))
    ]
    grouped_students = {}
    for level, teacher, _term_short_id, _student, student_id, _slot, category, _period in abnormal_rows:
        grouped_students.setdefault((teacher, level, category), set()).add(student_id)
    teacher_names = sorted({row[1] for row in abnormal_rows})
    abnormal_summary_rows = []
    for teacher in teacher_names:
        counts = [len(grouped_students.get((teacher, level, category), set())) for level, category, _ in category_specs]
        abnormal_summary_rows.append([teacher, *counts, sum(counts), period])
    abnormal_summary_rows.sort(key=lambda row: (-row[-2], row[0]))
    abnormal_summary_columns = ["老师姓名", *[label for _level, _category, label in category_specs], "异常学员合计", "统计周期"]
    untimely_rows = sorted(untimely.values(), key=lambda x: (x[0], ["周五晚", "周六午", "周六晚"].index(x[3]) if x[3] in ("周五晚", "周六午", "周六晚") else 9, x[1], x[2]))
    replay_rows = sorted(replay_students.values(), key=lambda x: (x[0], ["周五晚", "周六午", "周六晚"].index(x[3]) if x[3] in ("周五晚", "周六午", "周六晚") else 9, x[1], x[2], x[6]))
    live_rows.sort(key=lambda x: (x[0], ["周五晚", "周六午", "周六晚"].index(x[1]) if x[1] in ("周五晚", "周六午", "周六晚") else 9))
    term_rates = {}
    for (term, teacher), rec in overview.items():
        arrival_rate = rec["arrival_attend"] / rec["arrival_expected"] if rec["arrival_expected"] else 0
        live_rate = rec["live_attend"] / rec["live_expected"] if rec["live_expected"] else 0
        finish_rate = rec["finished"] / rec["finish_expected"] if rec["finish_expected"] else 0
        arrived_rate = rec["arrived_unfinished"] / rec["finish_expected"] if rec["finish_expected"] else 0
        term_rates.setdefault(term, []).append((arrival_rate, live_rate, finish_rate, arrived_rate))
    overview_rows = []
    for (term, teacher), rec in overview.items():
        if not rec["live_expected"] and not rec["finish_expected"]:
            continue
        arrival_rate = rec["arrival_attend"] / rec["arrival_expected"] if rec["arrival_expected"] else 0
        live_rate = rec["live_attend"] / rec["live_expected"] if rec["live_expected"] else 0
        finish_rate = rec["finished"] / rec["finish_expected"] if rec["finish_expected"] else 0
        arrived_rate = rec["arrived_unfinished"] / rec["finish_expected"] if rec["finish_expected"] else 0
        peers = term_rates.get(term, [])
        avg_live = sum(x[1] for x in peers) / len(peers) if peers else 0
        avg_finish = sum(x[2] for x in peers) / len(peers) if peers else 0
        avg_arrived = sum(x[3] for x in peers) / len(peers) if peers else 0
        warnings = []
        if len(peers) > 1 and live_rate < avg_live:
            warnings.append("准时参播率低于同期均值")
        if len(peers) > 1 and finish_rate < avg_finish:
            warnings.append("偶数课完课率低于同期均值")
        if len(peers) > 1 and arrived_rate > avg_arrived:
            warnings.append("到课未完课率高于同期均值")
        overview_rows.append([term, teacher, len(rec["classes"]), arrival_rate, live_rate, finish_rate, len(rec["incomplete_ids"]), len(rec["live_absent_ids"]), len(rec["replay_ids"]), len(rec["arrived_ids"]), "；".join(warnings) or "正常", period])
    overview_rows.sort(key=lambda x: (x[0], -x[5], -x[4], x[1]))
    # The console snapshot chooses the latest available week independently for
    # each cohort.  Reuse that verified result for the overview and live-seat
    # sheets so completed cohorts do not disappear when newer cohorts continue.
    snapshot_path = ROOT / "dashboard-snapshot.json"
    snapshot = {}
    if snapshot_path.exists():
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        overview_rows = []
        for row in snapshot.get("rows", []):
            current_metrics = row.get("current", {})
            warnings = []
            if row.get("liveAnomaly"):
                warnings.append("准时参播率低于同期均值")
            if row.get("finishAnomaly"):
                warnings.append("偶数课完课率低于同期均值")
            overview_rows.append([
                row.get("cohort", ""), row.get("teacher", ""),
                len([x for x in snapshot.get("classes", []) if x.get("teacher") == row.get("teacher") and x.get("cohort") == row.get("cohort")]),
                current_metrics.get("arrivalRate", 0), current_metrics.get("liveRate", 0), current_metrics.get("finishRate", 0),
                current_metrics.get("incompleteStudents", 0), current_metrics.get("liveAbsentStudents", 0), current_metrics.get("replayStudents", 0), current_metrics.get("arrivedIncompleteStudents", 0),
                "；".join(warnings) or "正常", row.get("currentWeek", "")
            ])
        overview_rows.sort(key=lambda x: (x[0], -x[5], -x[4], x[1]))
        live_rows = []
        for row in snapshot.get("classes", []):
            current_metrics = row.get("current", {})
            expected = int(current_metrics.get("liveExpected", 0) or 0)
            if not expected:
                continue
            attend_count = int(current_metrics.get("liveAttend", 0) or 0)
            live_rows.append([
                row.get("teacher", ""), row.get("slot", ""), int(row.get("classId", 0) or 0), row.get("className", ""),
                ",".join(str(x) for x in row.get("liveLessonNumbers", [])), expected, attend_count, expected - attend_count,
                int(current_metrics.get("liveAbsentStudents", 0) or 0), attend_count / expected, row.get("currentWeek", "")
            ])
        live_rows.sort(key=lambda x: (x[0], x[1], x[2]))
    cohort_exception_rows = build_cohort_exception_rows(snapshot)
    consecutive_details, consecutive_period = build_consecutive_incomplete(blocks, main_term_by_class, now)
    teacher_streaks = {}
    for row in consecutive_details:
        teacher_streaks.setdefault(str(row[3] or ""), []).append(int(row[10] or 0))
    all_teachers = sorted({clean_teacher(block.get("info", {}).get("teacherName")) for block in blocks if clean_teacher(block.get("info", {}).get("teacherName"))})
    consecutive_rows = []
    for teacher in all_teachers:
        streaks = teacher_streaks.get(teacher, [])
        consecutive_rows.append([
            teacher,
            len(streaks),
            sum(value == 2 for value in streaks),
            sum(value >= 3 for value in streaks),
            max(streaks, default=0),
            consecutive_period,
        ])
    consecutive_rows.sort(key=lambda row: (-row[1], row[0]))
    tables = {
        "组内概览": {"columns": ["主课期", "老师", "班级数", "到课率", "直播上座率", "偶数课完课率", "未完课", "未准时参播", "观看回放", "到课未完课", "同期异常", "统计周期"], "data": overview_rows,
                 "dtypes": {"班级数": "int", "到课率": "float", "直播上座率": "float", "偶数课完课率": "float", "未完课": "int", "未准时参播": "int", "观看回放": "int", "到课未完课": "int"}, "formats": {"到课率": "0.0%", "直播上座率": "0.0%", "偶数课完课率": "0.0%"}},
        "异常学员": {"columns": ["异常等级", "老师姓名", "课期ID", "学生姓名", "学生ID", "班型", "异常原因", "统计周期"], "data": abnormal_rows,
                 "summary": {"title": "各老师异常等级与学员类别汇总（按学员去重）", "columns": abnormal_summary_columns, "data": abnormal_summary_rows}},
        "推荐话术": {"columns": ["异常学员类别", "温和关怀型", "陪伴推进型", "积极鼓励型", "统计周期"], "data": recommended_rows},
        "未准时参播学员": {"columns": ["老师姓名", "学生姓名", "学生ID", "班型", "班级ID", "班级", "直播课节", "统计周期"], "data": untimely_rows,
                    "dtypes": {"班级ID": "int", "直播课节": "int"}},
        "回放学员": {"columns": ["老师姓名", "学生姓名", "学生ID", "班型", "班级ID", "班级", "直播课节", "回放时长（秒）", "回放进度", "统计周期"], "data": replay_rows,
                 "dtypes": {"班级ID": "int", "直播课节": "int", "回放时长（秒）": "int", "回放进度": "float"}, "formats": {"回放进度": "0.0%"}},
        "班级直播上座": {"columns": ["老师姓名", "班型", "班级ID", "班级", "已开直播课节", "直播应到次数", "直播上座次数", "直播未上座次数", "直播未上座人数", "直播上座率", "统计周期"], "data": live_rows,
                       "dtypes": {"班级ID": "int", "直播应到次数": "int", "直播上座次数": "int", "直播未上座次数": "int", "直播未上座人数": "int", "直播上座率": "float"}, "formats": {"直播上座率": "0.0%"}},
        "课期异常": {"columns": ["课期", "老师姓名", "异常类型", "学生姓名", "学生ID", "本周参播状态", "上周参播状态", "对比时段", "本周准时参播率", "上周准时参播率", "直播较上周", "本周准时参播人次", "本周直播应到人次", "上周准时参播人次", "上周直播应到人次", "本周完课率", "上周完课率", "完课较上周", "本周完成人次", "本周应完人次", "上周完成人次", "上周应完人次", "本周周期", "上周周期"], "data": cohort_exception_rows,
                 "dtypes": {"本周准时参播率": "float", "上周准时参播率": "float", "直播较上周": "float", "本周准时参播人次": "int", "本周直播应到人次": "int", "上周准时参播人次": "int", "上周直播应到人次": "int", "本周完课率": "float", "上周完课率": "float", "完课较上周": "float", "本周完成人次": "int", "本周应完人次": "int", "上周完成人次": "int", "上周应完人次": "int"},
                 "formats": {"本周准时参播率": "0.0%", "上周准时参播率": "0.0%", "直播较上周": "0.0%", "本周完课率": "0.0%", "上周完课率": "0.0%", "完课较上周": "0.0%"}},
        "连续2周及以上未完课": {"columns": CONSECUTIVE_COLUMNS, "data": consecutive_rows,
                       "dtypes": {"落课≥2周学员总数": "int", "连续2周学员数": "int", "连续3周及以上学员数": "int", "最长连续周数": "int"}},
    }
    # Enrich the workbook overview with teaching-service metrics. Missing
    # values stay blank and are never converted to zero.
    overview = tables.get("\u7ec4\u5185\u6982\u89c8")
    if overview and snapshot_path.exists():
        current_snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        service_by_teacher = {
            str(item.get("teacher") or ""): item.get("service", {})
            for item in current_snapshot.get("rows", [])
        }
        overview["columns"].extend(["IM 3\u5206\u949f\u56de\u590d\u7387", "\u4f01\u5fae2\u5c0f\u65f6\u56de\u590d\u7387", "\u6559\u5b66\u670d\u52a1\u66f4\u65b0\u65f6\u95f4"])
        for export_row in overview.get("data", []):
            service = service_by_teacher.get(str(export_row[1] or ""), {})
            export_row.extend([service.get("imRate"), service.get("wecomRate"), service.get("updatedAt", "")])
        overview.setdefault("dtypes", {}).update({"IM 3\u5206\u949f\u56de\u590d\u7387": "float", "\u4f01\u5fae2\u5c0f\u65f6\u56de\u590d\u7387": "float"})
        overview.setdefault("formats", {}).update({"IM 3\u5206\u949f\u56de\u590d\u7387": "0.0%", "\u4f01\u5fae2\u5c0f\u65f6\u56de\u590d\u7387": "0.0%"})
    fallback = start != current
    OUT.write_text(json.dumps({"period": period, "fallback": fallback, "tables": tables}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"period": period, "fallback": fallback, "overviewRows": len(overview_rows), "abnormalRows": len(abnormal_rows), "abnormalSummaryRows": len(abnormal_summary_rows), "recommendedRows": len(recommended_rows), "untimelyRows": len(untimely_rows), "replayRows": len(replay_rows), "liveRows": len(live_rows), "cohortExceptionRows": len(cohort_exception_rows), "consecutiveIncompleteRows": len(consecutive_rows), "consecutiveIncompletePeriod": consecutive_period}, ensure_ascii=False))


if __name__ == "__main__":
    main()
