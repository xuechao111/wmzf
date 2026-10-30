import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('comparison_live_cache', Path(__file__).parents[1] / 'comparison_live_cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheTest(unittest.TestCase):
    def block(self, teacher='Other-C1', course=99, unlock=100):
        return {'classId': 1, 'termId': 2, 'info': {'teacherName': teacher}, 'lessons': [{'course_number': 1, 'course_id': course, 'unlock_time': unlock}]}

    def test_missing_source_keeps_verified_roster_only_for_same_identity(self):
        saved = self.block()
        saved['liveAttendance'] = {'1': {'expectedIds': ['a', 'b'], 'attendedIds': ['a']}}
        merged = cache.merge_verified([self.block()], [saved], {'Other'})
        self.assertEqual(merged[0]['liveAttendance']['1']['expectedIds'], ['a', 'b'])
        for incoming in [self.block(course=100), self.block(unlock=200), self.block(teacher='Own-C2')]:
            self.assertFalse(cache.merge_verified([incoming], [saved], {'Other'})[0].get('liveAttendance'))

    def test_new_verified_roster_replaces_old(self):
        saved = self.block()
        saved['liveAttendance'] = {'1': {'expectedIds': ['a', 'b'], 'attendedIds': ['a']}}
        incoming = self.block()
        incoming['liveAttendance'] = {'1': {'expectedIds': ['a', 'b'], 'attendedIds': ['a', 'b']}}
        self.assertEqual(cache.merge_verified([incoming], [saved], {'Other'})[0]['liveAttendance']['1']['attendedIds'], ['a', 'b'])


if __name__ == '__main__':
    unittest.main()
