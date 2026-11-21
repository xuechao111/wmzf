import io
import json
import unittest
from unittest.mock import Mock, patch

import run_dashboard_update as core


class McpOperationErrors(unittest.TestCase):
    def responses(self, name, payloads, attempts=3):
        opener = Mock()
        opener.open.side_effect = [io.BytesIO(json.dumps({'result': {'content': [{'text': json.dumps(payload)}]}}).encode()) for payload in payloads]
        with patch.object(core.urllib.request, 'build_opener', return_value=opener), patch.object(core.time, 'sleep'):
            value = core.mcp_call(name, {'sheetId': 'fixture'}, attempts=attempts)
        return value, opener.open.call_count

    def test_transient_upstream_read_failure_retries_without_losing_data(self):
        failure = {'success': False, 'errorCode': 'internalError', 'errorMsg': "Can't connect to upstream"}
        result = {'values': [['verified', 17]]}
        value, calls = self.responses('get_range', [failure, failure, result])
        self.assertEqual(value, result)
        self.assertEqual(calls, 3)

    def test_temporary_write_failure_and_permission_error_are_not_retried(self):
        for name, message in [('update_range', "Can't connect to upstream"), ('get_range', 'Permission denied')]:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, message):
                self.responses(name, [{'success': False, 'errorMsg': message}])

    def test_read_retry_budget_is_bounded(self):
        failure = {'success': False, 'errorMsg': "Can't connect to upstream"}
        with self.assertRaisesRegex(RuntimeError, "Can't connect"):
            self.responses('get_range', [failure] * 3)

    def call(self, result):
        response = io.BytesIO(json.dumps(result).encode('utf-8'))
        opener = Mock()
        opener.open.return_value = response
        with patch.object(core.urllib.request, 'build_opener', return_value=opener):
            return core.mcp_call('update_range', {'sheetId': 'fixture'}, attempts=1)

    def test_merged_cell_conflict_stops_even_when_transport_succeeds(self):
        payload = {'success': False, 'errorCode': 'MERGED_CELLS_CONFLICT', 'errorMsg': 'Unmerge header first'}
        with self.assertRaisesRegex(RuntimeError, 'MERGED_CELLS_CONFLICT.*Unmerge header first'):
            self.call({'result': {'content': [{'type': 'text', 'text': json.dumps(payload)}]}})

    def test_tool_error_flag_stops_plain_text_result(self):
        with self.assertRaisesRegex(RuntimeError, 'permission denied'):
            self.call({'result': {'isError': True, 'content': [{'type': 'text', 'text': 'permission denied'}]}})

    def test_direct_operation_failure_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'FAILED'):
            self.call({'result': {'success': False, 'errorCode': 'FAILED'}})

    def test_business_rows_and_non_boolean_flags_remain_data(self):
        for payload in [
            {'success': True, 'data': [{'success': False, 'isError': True}]},
            {'success': 0, 'rows': [[0, False]]},
            {'values': [['success', False]]},
        ]:
            with self.subTest(payload=payload):
                self.assertEqual(self.call({'result': {'content': [{'text': json.dumps(payload)}]}}), payload)


if __name__ == '__main__':
    unittest.main()
