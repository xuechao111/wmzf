import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_dashboard_update as dashboard
import prepare_extension_update as preparation


class ClassSourceTests(unittest.TestCase):
    def test_workbook_changes_override_local_config_and_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            out = root / "extension-classes.json"
            out.write_text(json.dumps({"classes": [[1, 10]]}), encoding="utf-8")
            rows = [
                {"values": [["班级ID", "主课期ID"], [2, 20], [2, 20]]},
                {"values": [["班级ID", "主课期ID"], [3, 30]]},
            ]
            with patch.object(dashboard, "DATA", root / "run-data"), \
                 patch.object(dashboard, "dashboard_config", return_value={"classes": [[1, 10]]}), \
                 patch.object(dashboard, "load_sheet_ids", return_value={"班级id": "live-sheet"}) as listing, \
                 patch.object(dashboard, "mcp_call", side_effect=rows) as read:
                self.assertEqual(preparation.prepare(out)["classes"], [[2, 20]])
                self.assertEqual(preparation.prepare(out)["classes"], [[3, 30]])
                self.assertEqual(read.call_count, 2)
                listing.assert_called_with(refresh=True, allow_cached=False)
                self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["classSource"], "workbook")
                self.assertEqual(json.loads((dashboard.DATA / "classes.json").read_text(encoding="utf-8")), [[3, 30]])

    def test_group_column_beyond_first_six_columns_is_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            headers = ["班级ID", "主课期ID"] + [""] * 22 + ["小组", "老师工号", "老师姓名"]
            row = [123, 456] + [""] * 22 + ["远航组", "C123", "老师甲"]
            with patch.object(dashboard, "DATA", root), patch.object(dashboard, "load_sheet_ids", return_value={"班级id": "sheet"}), patch.object(dashboard, "mcp_call", return_value={"values": [headers, row]}) as read:
                self.assertEqual(dashboard.read_classes(), [[123, 456]])
                self.assertEqual(read.call_args.args[1]["range"], "A:AI")
                metadata = json.loads((root / "class-group-metadata.json").read_text(encoding="utf-8"))
                self.assertEqual(metadata["classes"]["123"], ["远航组"])
                self.assertEqual(metadata["teachers"]["老师甲"], ["远航组"])

    def test_read_failure_does_not_publish_old_ids_as_new(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            out = root / "extension-classes.json"
            previous = '{"classes":[[1,10]]}'
            out.write_text(previous, encoding="utf-8")
            with patch.object(dashboard, "DATA", root), \
                 patch.object(dashboard, "read_classes", side_effect=RuntimeError("gateway unavailable")):
                with self.assertRaisesRegex(RuntimeError, "gateway unavailable"):
                    preparation.prepare(out)
            self.assertEqual(out.read_text(encoding="utf-8"), previous)

    def test_empty_workbook_does_not_fall_back_to_local_config(self):
        with patch.object(dashboard, "dashboard_config", return_value={"classes": [[1, 10]]}), \
             patch.object(dashboard, "load_sheet_ids", return_value={"班级id": "sheet"}), \
             patch.object(dashboard, "mcp_call", return_value={"values": [["班级ID", "主课期ID"]]}):
            with self.assertRaises(RuntimeError):
                dashboard.read_classes()

    def test_directory_failure_cannot_use_cached_sheet_from_another_workbook(self):
        with patch.object(dashboard, "SHEET_IDS", {}), \
             patch.object(dashboard, "mcp_call", side_effect=RuntimeError("directory unavailable")), \
             patch.object(dashboard, "cached_sheet_ids", return_value={"班级id": "old-workbook-sheet"}):
            with self.assertRaisesRegex(RuntimeError, "directory unavailable"):
                dashboard.read_classes()


if __name__ == "__main__":
    unittest.main()
