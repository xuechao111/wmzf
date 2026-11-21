import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_dashboard_update as core


class RollingPeriodVerification(unittest.TestCase):
    previous = '2026-11-09至2026-11-15'
    current = '2026-11-16至2026-11-22'

    def verify(self, table, rows=None, tail=None):
        responses = iter([{'values': [table['columns']] + (table['data'] if rows is None else rows)},
                          {'values': tail or []}, {'values': []}])
        with patch.object(core, 'mcp_call', side_effect=lambda *a: next(responses)):
            core.verify_current_week_only('fixture', table)

    def table(self):
        return {'columns': ['老师姓名', '学生ID', '班级ID', '统计周期'],
                'data': [['已结课老师', '1', 101, self.previous],
                         ['正常上课老师', '2', 102, self.current]]}

    def test_screenshot_258_rows_may_have_two_cohort_weeks(self):
        table = self.table()
        table['data'] = [['老师', str(i), 101 if i < 100 else 102,
                          self.previous if i < 100 else self.current] for i in range(258)]
        self.verify(table)

    def test_paused_cohort_and_current_cohort_keep_own_weeks(self):
        self.verify(self.table())

    def test_old_week_is_rejected_even_at_equal_row_count(self):
        table = self.table()
        rows = [list(row) for row in table['data']]
        rows[1][-1] = self.previous
        with self.assertRaisesRegex(RuntimeError, '对应关系不一致'):
            self.verify(table, rows)

    def test_swapped_weeks_are_rejected_even_when_period_set_matches(self):
        table = self.table()
        rows = [list(row) for row in table['data']]
        rows[0][-1], rows[1][-1] = rows[1][-1], rows[0][-1]
        with self.assertRaisesRegex(RuntimeError, '对应关系不一致'):
            self.verify(table, rows)

    def test_duplicate_or_missing_learner_is_rejected(self):
        table = self.table()
        with self.assertRaises(RuntimeError):
            self.verify(table, [table['data'][0], table['data'][0]])
        with self.assertRaises(RuntimeError):
            self.verify(table, table['data'][:1])

    def test_cohort_exception_checks_current_and_previous_columns(self):
        table = {'columns': ['课期', '老师姓名', '学生ID', '本周周期', '上周周期'],
                 'data': [['A', '老师', '1', self.current, self.previous]]}
        self.verify(table)
        with self.assertRaises(RuntimeError):
            self.verify(table, [['A', '老师', '1', self.previous, self.previous]])

    def test_reordered_rows_and_numeric_ids_are_accepted(self):
        table = self.table()
        self.verify(table, [['正常上课老师', 2, 102.0, self.current],
                            ['已结课老师', 1, 101.0, self.previous]])

    def test_stale_tail_still_fails(self):
        with self.assertRaisesRegex(RuntimeError, '清空区仍存在旧数据'):
            self.verify(self.table(), tail=[['旧老师', '9', 100, self.previous]])

    def test_empty_generated_table_checks_tail(self):
        self.verify({'columns': ['老师姓名', '统计周期'], 'data': []})

    def test_no_period_column_does_not_guess_last_metric_is_week(self):
        with self.assertRaisesRegex(RuntimeError, '缺少明确的周期列'):
            self.verify({'columns': ['老师姓名', '人数'], 'data': [['老师', 10]]})


if __name__ == '__main__':
    unittest.main()
