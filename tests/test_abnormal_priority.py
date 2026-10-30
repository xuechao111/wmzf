import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_exception_exports as exports


class AbnormalPriorityTests(unittest.TestCase):
    def export(self, blocks):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw, classes, out = (root / name for name in ("raw.json", "classes.json", "out.json"))
            raw.write_text(json.dumps(blocks), encoding="utf-8")
            classes.write_text(json.dumps([[block["classId"], 1] for block in blocks]), encoding="utf-8")
            now = datetime(2026, 10, 18, 16, tzinfo=exports.CN).timestamp()
            with patch.multiple(exports, ROOT=root, RAW=raw, CLASSES=classes, OUT=out), \
                 patch.object(exports.time, "time", return_value=now), contextlib.redirect_stdout(io.StringIO()):
                exports.main()
            return json.loads(out.read_text(encoding="utf-8"))["tables"]

    def block(self, *, second_session=False):
        cases = [
            ("replay-finished", True, True),
            ("replay-unfinished", True, False),
            ("unwatched-finished", False, True),
            ("unwatched-unfinished", False, False),
            ("timely-unfinished", False, False),
        ]
        unlock = int(datetime(2026, 10, 16, 19, tzinfo=exports.CN).timestamp())
        lessons = [{"course_id": 1, "course_number": 1, "unlock_time": unlock},
                   {"course_id": 2, "course_number": 2, "unlock_time": unlock}]
        items = []
        for uid, replay, finished in cases:
            # The live board wins over conflicting course-detail live flags.
            items.extend([
                {"user_id": uid, "child_name": uid, "course_id": 1, "is_open": replay,
                 "live_course": replay, "watch_time": 30 if replay else 0, "watch_process": 59 if replay else 0},
                {"user_id": uid, "child_name": uid, "course_id": 2, "is_finish": finished},
            ])
        boards = {"1": {"expectedIds": [case[0] for case in cases], "attendedIds": ["timely-unfinished"],
                         "absentIds": [case[0] for case in cases if case[0] != "timely-unfinished"]}}
        if second_session:
            lessons.extend([{"course_id": 3, "course_number": 3, "unlock_time": unlock + 86400},
                            {"course_id": 4, "course_number": 4, "unlock_time": unlock + 86400}])
            items.extend([{"user_id": "replay-finished", "course_id": 3, "live_course": False, "watch_time": 0},
                          {"user_id": "replay-finished", "course_id": 4, "is_finish": True}])
            boards["3"] = {"expectedIds": ["replay-finished"], "attendedIds": [], "absentIds": ["replay-finished"]}
        return {"classId": 1, "termId": 1, "info": {"teacherName": "Teacher-C1", "className": "Class"},
                "lessons": lessons, "items": items, "liveAttendance": boards}

    def test_all_unfinished_students_are_priority_one_even_if_untimely(self):
        tables = self.export([self.block()])
        rows = {row[4]: row for row in tables["异常学员"]["data"]}
        for uid in ("replay-finished", "replay-unfinished", "unwatched-finished", "unwatched-unfinished"):
            self.assertEqual(rows[uid][0], "一级｜未完课（最高）" if uid.endswith("unfinished") else "二级｜未准时参播")
        self.assertEqual(rows["timely-unfinished"][0], "一级｜未完课（最高）")
        self.assertIn("已回看", rows["replay-finished"][6])
        self.assertIn("已回看", rows["replay-unfinished"][6])
        self.assertIn("课程未完成", rows["replay-unfinished"][6])
        self.assertNotIn("已回看", rows["unwatched-unfinished"][6])
        self.assertEqual(len(tables["未准时参播学员"]["data"]), 4)
        self.assertEqual(len(tables["回放学员"]["data"]), 2)
        summary = tables["异常学员"]["summary"]
        values = dict(zip(summary["columns"], summary["data"][0]))
        self.assertEqual(sum(value for key, value in values.items() if key.startswith("二级")), 2)
        self.assertEqual(values["异常学员合计"], 5)

    def test_replay_marker_applies_only_to_the_missed_sessions_watched(self):
        tables = self.export([self.block(second_session=True)])
        row = next(row for row in tables["异常学员"]["data"] if row[4] == "replay-finished")
        self.assertIn("部分已回看", row[6])
        self.assertEqual(row[0], "二级｜未准时参播")

    def test_priority_one_streak_shows_actual_unique_missing_lessons(self):
        block = self.block()
        previous = int(datetime(2026, 10, 9, 19, tzinfo=exports.CN).timestamp())
        block["lessons"] += [{"course_id": 11, "course_number": 11, "unlock_time": previous},
                             {"course_id": 12, "course_number": 12, "unlock_time": previous}]
        old = {"user_id": "timely-unfinished", "course_id": 12, "is_finish": False}
        block["items"] += [old, dict(old)]
        tables = self.export([block])
        row = next(row for row in tables["异常学员"]["data"] if row[4] == "timely-unfinished")
        self.assertIn("连续落课2周｜实际落课2节", row[6])
        summary = tables["异常学员"]["summary"]
        values = dict(zip(summary["columns"], summary["data"][0]))
        self.assertEqual(values["其中·未到课"], 2)
        self.assertEqual(values["异常学员合计"], 5)
        single = self.export([self.block()])
        self.assertFalse(any("实际落课" in row[6] for row in single["异常学员"]["data"]))

    def test_unfinished_summary_keeps_learners_with_long_duration(self):
        for base in ("未到课", "课程未完成", "直播缺席｜未到课", "直播缺席｜课程未完成"):
            self.assertEqual(exports.category_without_replay(base + "｜完课时长偏长｜已回看"), base)
        self.assertEqual(exports.category_without_replay("直播缺席｜完课时长偏长｜已回看"), "直播缺席｜完课时长偏长")

    def test_summary_deduplicates_cross_class_categories_and_highest_severity(self):
        rows = [
            ["一级｜未完课（最高）", "T", "term1", "S", "1", "周五晚", "未到课", "P"],
            ["一级｜未完课（最高）", "T", "term2", "S", "1", "周六午", "直播缺席｜课程未完成｜已回看", "P"],
            ["二级｜未准时参播", "T", "term3", "S", "1", "周六晚", "直播缺席", "P"],
            ["三级｜完课时长异常", "T", "term4", "S", "1", "周六晚", "完课时长偏长", "P"],
        ]
        summary = exports.build_abnormal_summary(rows, "P")
        values = dict(zip(summary["columns"], summary["data"][0]))
        self.assertEqual(values["一级·未完课合计"], 1)
        self.assertEqual(values["其中·到课未完课"], 1)
        self.assertEqual(values["其中·未到课"], 0)
        self.assertEqual(values["二级·仅直播缺席"], 0)
        self.assertEqual(values["三级·仅时长异常"], 0)
        self.assertEqual(values["异常学员合计"], 1)
        self.assertEqual(values["未准时参播合计"], 1)
        self.assertEqual(values["其中·已回看"], 1)

    def test_summary_totals_partition_unique_learners(self):
        tables = self.export([self.block(second_session=True)])
        row = tables["异常学员"]["summary"]["data"][0]
        self.assertEqual(row[1], row[2] + row[3])
        self.assertEqual(row[1] + row[4] + row[5], row[8])
        self.assertLessEqual(row[7], row[6])
        self.assertEqual(row[1], 3)

    def test_validation_blocks_missing_student_and_modified_summary(self):
        import copy
        import run_dashboard_update as core
        table = self.export([self.block()])["异常学员"]
        ids = {row[4] for row in table["data"] if row[0].startswith("一级")}
        snapshot = {"rows": [{"teacher": "Teacher", "current": {"incompleteList": [{"id": uid} for uid in ids]}}]}
        core.validate_abnormal_summary(table, snapshot)
        broken = copy.deepcopy(table)
        broken["summary"]["data"][0][1] += 1
        with self.assertRaisesRegex(RuntimeError, "汇总与明细不一致"):
            core.validate_abnormal_summary(broken, snapshot)
        snapshot["rows"][0]["current"]["incompleteList"].append({"id": "missing"})
        with self.assertRaisesRegex(RuntimeError, "名单不一致"):
            core.validate_abnormal_summary(table, snapshot)

    def test_replay_scripts_acknowledge_replay_instead_of_requesting_it_again(self):
        context, action = exports.followup_context_and_action("直播缺席｜已回看")
        self.assertIn("已经补看", context)
        self.assertNotIn("回看", action)
        self.assertIn("下次直播", action)


if __name__ == "__main__":
    unittest.main()
