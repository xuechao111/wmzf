import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from get_dashboard_snapshot import course_package

class CoursePackageTests(unittest.TestCase):
    def test_same_date_different_catalogs_do_not_share_package(self):
        block=lambda title: {"lessons":[{"course_number":1,"course_name":title,"course_id":1,"unlock_time":1792149600}]}
        self.assertEqual(course_package(block("1-C++基础框架")), "进阶")
        self.assertEqual(course_package(block("51-认识一维数组")), "高阶")
    def test_unknown_curriculum_is_not_guessed_as_known_package(self):
        self.assertTrue(course_package({"lessons":[{"course_id":999,"course_name":"新课程"}]}).startswith("课包待确认"))
    def test_explicit_crm_package_takes_priority(self):
        self.assertEqual(course_package({"info":{"packageName":"探月C++高阶班"},"lessons":[]}), "高阶")
