import sys
import re
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_dashboard_update as core


class ReplicaLegacyClear(unittest.TestCase):
    def test_large_rectangle_exact_coverage_and_cell_limit(self):
        with patch.object(core, 'mcp_call', return_value={'success': True}) as call:
            core.clear_generated_range('fixture', 19, 51, 1, 6000, 'all', 'overview')
        next_row = 1
        for c in call.call_args_list:
            args = c.args[1]
            match = re.fullmatch(r'T(\d+):AZ(\d+)', args['range'])
            self.assertIsNotNone(match)
            first, last = map(int, match.groups())
            self.assertEqual(first, next_row)
            self.assertLessEqual((last - first + 1) * 33, 1300)
            next_row = last + 1
        self.assertEqual(next_row, 6001)

    def test_tail_cleanup_preserves_manual_columns(self):
        with patch.object(core, 'mcp_call', return_value={'success': True}) as call:
            core.clear_stale_rows('fixture', 6, 31, 6000, True, 'teacher summary')
        self.assertEqual(call.call_args_list[0].args[1]['range'], 'A31:F246')
        self.assertTrue(all(re.fullmatch(r'A\d+:F\d+', c.args[1]['range']) for c in call.call_args_list))
        self.assertTrue(all(c.args[1]['type'] == 'content' for c in call.call_args_list))
        self.assertTrue(call.call_args_list[-1].args[1]['range'].endswith('F6000'))

    def test_permission_failure_has_context_and_is_not_retried(self):
        with patch.object(core, 'mcp_call', side_effect=RuntimeError('forbidden.accessDenied')) as call:
            with self.assertRaisesRegex(RuntimeError, r'teacher summary.*fixture.*A31:F246.*forbidden.accessDenied'):
                core.clear_stale_rows('fixture', 6, 31, 6000, True, 'teacher summary')
        self.assertEqual(call.call_count, 1)

    def test_initialized_layout_does_not_repeat_legacy_clear(self):
        table = {'columns': ['teacher', 'count'], 'data': [['fixture', 1]]}
        with patch.object(core, 'load_sheet_ids', return_value={core.OVERVIEW_TOTAL_SHEET_NAME: 'fixture'}), \
             patch.object(core, 'style_layout_initialized', return_value=True), \
             patch.object(core, 'mcp_call', return_value={'success': True}) as call, \
             patch.object(core, 'apply_explicit_number_formats'), \
             patch.object(core, 'style_overview_total_sheet'), \
             patch.object(core, 'mark_style_layout_initialized'):
            core.write_sheet(core.OVERVIEW_TOTAL_SHEET_NAME, table)
        clears = [c.args[1] for c in call.call_args_list if c.args[0] == 'clear_range']
        self.assertTrue(clears)
        self.assertTrue(all(c['type'] == 'content' for c in clears))

    def test_write_permission_error_does_not_try_alias_or_mark_success(self):
        with patch.object(core, 'load_sheet_ids', return_value={'fixture': 'fixture'}), \
             patch.object(core, 'style_layout_initialized', return_value=True), \
             patch.object(core, 'mcp_call', side_effect=RuntimeError('forbidden.accessDenied')) as call, \
             patch.object(core, 'mark_style_layout_initialized') as mark:
            with self.assertRaisesRegex(RuntimeError, 'forbidden.accessDenied'):
                core.write_sheet('fixture', {'columns': ['teacher'], 'data': [['fixture']]})
        self.assertEqual(call.call_count, 1)
        mark.assert_not_called()

    def test_full_legacy_span_is_cleared_once_in_small_batches(self):
        with patch.object(core, 'mcp_call', return_value={'success': True}) as call:
            core.clear_consecutive_legacy_columns('generated-only')
        ranges = [c.args[1]['range'] for c in call.call_args_list]
        self.assertEqual(ranges, [f'G{i}:S{i+99}' for i in range(1, 6001, 100)])
        self.assertTrue(all(c.args[1]['sheetId'] == 'generated-only' and c.args[1]['type'] == 'all'
                            for c in call.call_args_list))

    def test_failed_clear_stops_before_later_batches(self):
        with patch.object(core, 'mcp_call', side_effect=[{'success': True}, RuntimeError('timeout')]) as call:
            with self.assertRaisesRegex(RuntimeError, 'timeout'):
                core.clear_consecutive_legacy_columns('generated-only')
        self.assertEqual(call.call_count, 2)


if __name__ == '__main__':
    unittest.main()
