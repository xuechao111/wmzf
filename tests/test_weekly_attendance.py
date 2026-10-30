import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from weekly_attendance_table import SHEET_NAME, build_weekly_attendance_table, verify_weekly_attendance_sheet, write_weekly_attendance_sheet
from audit_weekly_rosters import latest_class_roster


def metrics(expected, attend, replay):
    wrap = lambda values: [{"id": value} for value in values]
    return {"liveExpected": len(expected), "liveRate": len(attend) / len(expected),
            "liveExpectedList": wrap(expected), "liveAttendList": wrap(attend), "replayList": wrap(replay)}


class WeeklyAttendanceTests(unittest.TestCase):
    def test_configured_previous_and_current_weeks_are_kept(self):
        snapshot = self.snapshot()
        snapshot["updatedAt"] = "2026-10-25 20:00:00"
        snapshot["weeklyAttendanceClasses"] = snapshot["classes"]
        for item in snapshot["weeklyAttendanceClasses"]:
            item["attendanceWeeks"] = {"2026-10-19": item["current"], "2026-10-26": {}}
        table = build_weekly_attendance_table(snapshot)
        self.assertEqual(table["weeks"], ["2026-10-12", "2026-10-19"])
        self.assertEqual(table["data"][0][5], 1)
        self.assertEqual(table["data"][0][16], 1)
        snapshot["updatedAt"] = "2026-10-26 09:00:00"
        table = build_weekly_attendance_table(snapshot)
        self.assertEqual(table["weeks"], ["2026-10-19", "2026-10-26"])
        self.assertTrue(all(row[13] == row[3] and all(value is None for value in row[14:]) for row in table["data"] if row[1] != "汇总"))

    def snapshot(self):
        return {"rows": [{"teacher": "T", "cohort": "C", "currentWeek": "2026-10-19周", "previousWeek": "2026-10-05周"}],
                "classes": [{"teacher": "T", "cohort": "C", "classId": 1, "slot": "周五晚", "students": [{"id": "1"}],
                             "current": metrics(["1", "2"], ["1"], ["1", "2", "outside"]),
                             "previous": metrics(["1", "2"], ["1"], [])},
                            {"teacher": "T", "cohort": "C", "classId": 2, "slot": "周六午", "students": [{"id": "3"}],
                             "current": metrics(["3", "4", "5", "6"], ["3"], []), "previous": {}}]}

    def test_replay_union_and_weighted_average_skip_unopened_week(self):
        table = build_weekly_attendance_table(self.snapshot())
        self.assertEqual(table["weeks"], ["2026-10-05", "2026-10-19"])
        current = table["data"][0][13:]
        self.assertEqual(current[:4], [1, None, None, 1])
        self.assertEqual(current[5], 0)
        self.assertEqual(current[7], 1)
        self.assertEqual(table["data"][1][5:13], [1, None, None, None, None, None, None, None])

    def test_duplicate_classes_do_not_duplicate_students(self):
        snapshot = self.snapshot()
        snapshot["classes"].append(snapshot["classes"][0])
        table = build_weekly_attendance_table(snapshot)
        self.assertEqual(table["data"][0][13], 1)
        self.assertEqual(table["data"][0][3], 1)

    def test_previous_and_current_week_data_are_kept(self):
        snapshot = self.snapshot()
        snapshot["updatedAt"] = "2026-10-26 09:00:00"
        snapshot["weeklyAttendanceWeeks"] = ["2026-10-19", "2026-10-26"]
        snapshot["weeklyAttendanceClasses"] = snapshot["classes"]
        for item in snapshot["weeklyAttendanceClasses"]:
            item["attendanceWeeks"] = {"2026-10-19": item["current"], "2026-10-26": {}}
        table = build_weekly_attendance_table(snapshot)
        self.assertEqual(table["weeks"], ["2026-10-19", "2026-10-26"])
        self.assertEqual(table["data"][0][5], 1)
        self.assertEqual(table["data"][0][13], 1)
        self.assertEqual(table["data"][0][16], None)

    def test_stopped_or_empty_live_week_does_not_fail(self):
        snapshot = self.snapshot()
        snapshot["weeklyAttendanceClasses"] = [{
            "teacher": "T", "coursePackage": "C", "cohort": "C", "slot": "周五晚",
            "classId": 99, "students": [{"id": "1"}],
            "attendanceWeeks": {"2026-10-19": {}, "2026-10-26": {}}
        }]
        snapshot["updatedAt"] = "2026-10-20 09:00:00"
        table = build_weekly_attendance_table(snapshot)
        self.assertEqual(len(table["data"]), 2)
        self.assertEqual(table["data"][0][5], 1)
        self.assertEqual(table["data"][0][13], 1)
        self.assertIsNone(table["data"][0][8])

    def test_unverified_data_remains_blank(self):
        snapshot = self.snapshot()
        snapshot["classes"][0]["current"]["missingLiveBoards"] = 1
        table = build_weekly_attendance_table(snapshot)
        self.assertEqual(table["data"][0][13:], [1, None, None, None, None, None, None, None])
        self.assertEqual(table["data"][0][13], table["data"][0][3])

    def test_workbook_verification_accepts_numeric_strings_but_rejects_bad_counts(self):
        table = build_weekly_attendance_table(self.snapshot())
        rows = [["" if value is None else str(value) for value in row[3:]] for row in table["data"]]
        core = SimpleNamespace(WORKBOOK="workbook", col_letter=lambda index: "W",
                               mcp_call=Mock(return_value=rows), find_rows=lambda value: value)
        verify_weekly_attendance_sheet(core, "sheet", table)
        rows[0][0] = "999"
        with self.assertRaisesRegex(RuntimeError, "VERIFY_FAILED"):
            verify_weekly_attendance_sheet(core, "sheet", table)

    def test_latest_roster_excludes_historical_students(self):
        block = {"lessons": [{"course_id": 1, "unlock_time": 100, "course_number": 1},
                             {"course_id": 2, "unlock_time": 200, "course_number": 2}],
                 "items": [{"course_id": 1, "user_id": "past"}, {"course_id": 1, "user_id": "active"},
                           {"course_id": 2, "user_id": "active"}],
                 "liveAttendance": {"1": {"names": {"room-only": "X"}}}}
        course, roster = latest_class_roster(block)
        self.assertEqual(course, 2)
        self.assertEqual(set(roster), {"active"})

    def test_verification_keeps_manual_invitation_values(self):
        table = build_weekly_attendance_table(self.snapshot())
        rows = [list(row[3:]) for row in table["data"]]
        for row in rows:
            row[3], row[4], row[11], row[12] = 17, .17, "周五发", ""
        core = SimpleNamespace(WORKBOOK="workbook", col_letter=lambda index: "U",
                               mcp_call=Mock(return_value=rows), find_rows=lambda value: value)
        verify_weekly_attendance_sheet(core, "sheet", table)

    def test_missing_target_never_creates_another_sheet(self):
        core = SimpleNamespace(load_sheet_ids=lambda: {}, mcp_call=Mock())
        with self.assertRaisesRegex(RuntimeError, "TARGET_MISSING"):
            write_weekly_attendance_sheet(core, build_weekly_attendance_table(self.snapshot()))
        core.mcp_call.assert_not_called()

    def test_failed_invitation_read_never_clears_sheet(self):
        core = SimpleNamespace(WORKBOOK="workbook", load_sheet_ids=lambda: {SHEET_NAME: "sheet"},
                               col_letter=lambda index: "U", find_rows=lambda value: value,
                               mcp_call=Mock(side_effect=RuntimeError("network")))
        with patch("weekly_attendance_table.WEEKLY_HASH_FILE") as hashed:
            hashed.exists.return_value = False
            with self.assertRaisesRegex(RuntimeError, "INVITES_READ_FAILED"):
                write_weekly_attendance_sheet(core, build_weekly_attendance_table(self.snapshot()))
        self.assertEqual([call.args[0] for call in core.mcp_call.call_args_list], ["get_range"])


if __name__ == "__main__":
    unittest.main()




