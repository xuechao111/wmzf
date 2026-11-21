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
import get_dashboard_snapshot as snapshot
import run_dashboard_update as core


def stamp(day):
    return int(datetime.fromisoformat(day + 'T19:00:00+08:00').timestamp())


def block(class_id, dates, package='进阶'):
    lessons, items, boards = [], [], {}
    for index, day in enumerate(dates):
        first, second = index * 2 + 1, index * 2 + 2
        uid = f'{class_id}-week-{index}'
        lessons.extend({'course_id': n, 'course_number': n, 'course_name': f'{n}-lesson',
                        'unlock_time': stamp(day)} for n in (first, second))
        items.extend([{'user_id': uid, 'child_name': uid, 'course_id': first, 'is_open': True},
                      {'user_id': uid, 'child_name': uid, 'course_id': second, 'is_finish': False}])
        boards[str(first)] = {'expectedIds': [uid], 'attendedIds': [uid], 'absentIds': []}
    return {'classId': class_id, 'termId': class_id,
            'info': {'teacherName': '伍桔滔-C1', 'packageName': package, 'className': str(class_id)},
            'lessons': lessons, 'items': items, 'liveAttendance': boards}


class CohortExceptionAlignment(unittest.TestCase):
    def generate(self, blocks):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'run-data').mkdir()
            raw = root / 'run-data/group-lessons-raw.json'
            classes = root / 'run-data/classes.json'
            raw.write_text(json.dumps(blocks), encoding='utf-8')
            classes.write_text(json.dumps([[b['classId'], b['termId']] for b in blocks]), encoding='utf-8')
            out = root / 'dashboard-snapshot.json'
            exception = root / 'run-data/exception-export-tables.json'
            with patch.multiple(snapshot, ROOT=root, RAW=raw, OUT=out, CONFIG=root/'config.json', SERVICE=root/'service.json'), \
                 patch.multiple(exports, ROOT=root, RAW=raw, OUT=exception, CLASSES=classes), \
                 patch.object(snapshot.time, 'time', return_value=stamp('2026-11-06') + 10800), \
                 contextlib.redirect_stdout(io.StringIO()):
                snapshot.main()
                exports.main()
            board = json.loads(out.read_text(encoding='utf-8'))
            table = json.loads(exception.read_text(encoding='utf-8'))['tables']['异常学员']
            core.validate_abnormal_summary(table, board)
            return board, table

    def test_completed_cohort_and_current_cohort_keep_their_own_latest_week(self):
        _, table = self.generate([block(1, ['2026-10-16', '2026-10-30']), block(2, ['2026-11-06'])])
        rows = {row[4]: row for row in table['data'] if row[0].startswith('一级')}
        self.assertEqual(set(rows), {'1-week-1', '2-week-0'})
        self.assertEqual(rows['1-week-1'][7], '2026-10-26至2026-11-01')
        self.assertEqual(rows['2-week-0'][7], '2026-11-02至2026-11-08')

    def test_same_start_different_package_does_not_borrow_newer_package_week(self):
        _, table = self.generate([block(1, ['2026-10-16', '2026-10-23'], '高阶'),
                                  block(2, ['2026-10-16', '2026-11-06'], '进阶')])
        self.assertEqual({row[4] for row in table['data'] if row[0].startswith('一级')},
                         {'1-week-1', '2-week-1'})

    def test_paused_cohort_uses_last_populated_week_and_ignores_future_classes(self):
        paused = block(1, ['2026-10-16', '2026-10-23', '2026-11-13'])
        paused['items'] = [item for item in paused['items'] if item['course_id'] < 5]
        _, table = self.generate([paused, block(2, ['2026-11-06'])])
        self.assertEqual({row[4] for row in table['data'] if row[0].startswith('一级')},
                         {'1-week-1', '2-week-0'})

    def test_live_board_pairing_ignores_inserted_lesson(self):
        data = block(1, ['2026-11-06'])
        data['lessons'].append({'course_id': 3, 'course_number': 3, 'course_name': '3-completion', 'unlock_time': stamp('2026-11-06')})
        data['liveAttendance'] = {'2': {'expectedIds': ['correct'], 'attendedIds': ['correct'], 'absentIds': []}}
        data['items'] = [{'user_id': 'obsolete', 'course_id': 1, 'is_finish': False},
                         {'user_id': 'correct', 'course_id': 2, 'is_open': True, 'is_finish': True},
                         {'user_id': 'correct', 'course_id': 3, 'is_finish': False}]
        _, table = self.generate([data])
        self.assertEqual({row[4] for row in table['data'] if row[0].startswith('一级')}, {'correct'})


if __name__ == '__main__':
    unittest.main()
