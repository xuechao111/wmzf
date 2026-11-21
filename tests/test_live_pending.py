import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from get_dashboard_snapshot import period_metrics, public_metrics, timely_live_comparison
from live_pending import apply_live_pending
from overview_total_table import build_overview_total_table
from console_data_api import prepare_table


class LivePendingTests(unittest.TestCase):
    def block(self, with_board=False):
        block = {"lessons": [{"course_number": 1, "course_id": 1, "unlock_time": 100},
                             {"course_number": 2, "course_id": 2, "unlock_time": 100}],
                 "items": [{"course_id": 1, "user_id": "a", "is_open": True, "live_course": True},
                           {"course_id": 2, "user_id": "a", "is_finish": True}]}
        if with_board:
            block["liveAttendance"] = {"1": {"expectedIds": ["a"], "attendedIds": ["a"], "absentIds": []}}
        return block

    def test_unstarted_or_substitute_room_does_not_erase_course_completion(self):
        for allow_detail in (False, True):
            metrics = public_metrics(period_metrics(self.block(), 0, 200, 150, allow_detail), {"a": "A"})
            self.assertTrue(metrics["livePending"])
            self.assertIsNone(metrics["liveRate"])
            self.assertIsNone(metrics["replayRate"])
            self.assertEqual((metrics["evenDone"], metrics["evenExpected"], metrics["finishRate"]), (1, 1, 1))
            self.assertEqual((metrics["arrivalAttend"], metrics["arrivalExpected"]), (1, 1))

    def test_real_zero_attendance_is_not_pending_and_room_recovery_clears_pending(self):
        block = self.block(True)
        metrics = public_metrics(period_metrics(block, 0, 200, 150), {"a": "A"})
        self.assertFalse(metrics["livePending"])
        self.assertEqual(metrics["liveRate"], 1)
        block["liveAttendance"]["1"].update(attendedIds=[], absentIds=["a"])
        zero = public_metrics(period_metrics(block, 0, 200, 150), {"a": "A"})
        self.assertFalse(zero["livePending"])
        self.assertEqual(zero["liveRate"], 0)

    def test_one_pending_slot_blocks_partial_live_total_but_not_other_fields(self):
        good = public_metrics(period_metrics(self.block(True), 0, 200, 150), {"a": "A"})
        pending = public_metrics(period_metrics(self.block(), 0, 200, 150), {"a": "A"})
        comparison = timely_live_comparison([{"slot": "周五晚", "current": good, "previous": good},
                                             {"slot": "周六午", "current": pending, "previous": good}])
        self.assertTrue(comparison["livePending"])
        self.assertFalse(comparison["hasBaseline"])
        self.assertIsNone(comparison["currentRate"])
        self.assertEqual(comparison["attendanceChanges"]["lastWeekCameThisWeekMissed"], [])

    def test_generated_workbook_cells_show_pending_and_completion_survives(self):
        metrics = public_metrics(period_metrics(self.block(), 0, 200, 150), {"a": "A"})
        snapshot = {"rows": [{"teacher": "T", "cohort": "C", "current": metrics}],
                    "classes": [{"classId": 9, "teacher": "T", "cohort": "C", "slot": "周五晚", "current": metrics}]}
        tables = {"组内概览": {"columns": ["主课期", "老师", "直播上座率", "偶数课完课率"], "data": [["C", "T", 0, 1]]},
                  "班级直播上座": {"columns": ["老师姓名", "班型", "班级ID", "班级", "已开直播课节", "直播应到次数", "直播上座次数", "直播未上座次数", "直播未上座人数", "直播上座率", "统计周期"], "data": []}}
        apply_live_pending(tables, snapshot)
        self.assertEqual(tables["组内概览"]["data"][0], ["C", "T", "待更新", 1])
        self.assertEqual(tables["班级直播上座"]["data"][0][5:10], ["待更新"] * 5)
        overview = build_overview_total_table(snapshot)["data"][0]
        self.assertEqual(overview[5:7], ["待更新", "待更新"])
        self.assertEqual(overview[7], 1)
        prepared = prepare_table("班级直播上座", {"columns": tables["班级直播上座"]["columns"], "data": []}, snapshot)
        self.assertEqual(len(prepared["data"][0]), len(prepared["columns"]))
        self.assertEqual(prepared["data"][0][-2], "C")


if __name__ == "__main__":
    unittest.main()
