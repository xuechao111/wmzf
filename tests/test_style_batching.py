"""Check exact per-cell formatting after batching, without network writes."""
import ast
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "run_dashboard_update.py"

class StyleBatchingTests(unittest.TestCase):
    def capture(self, name, count):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
        calls = []
        namespace = {"WORKBOOK": "offline-test", "mcp_call": lambda method, args: calls.append((method, args))}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "style-test", "exec"), namespace)
        namespace[name]("sheet", {"data": [["value"] * 6 for _ in range(count)]})
        return calls

    def test_recommended_formats(self):
        for count in (1, 7, 40):
            calls = self.capture("style_recommended_scripts_sheet", count)
            ranges = [args for method, args in calls if method == "update_range"]
            self.assertEqual(len(ranges), 1)
            style = ranges[0]
            self.assertEqual(style["rangeAddress"], f"A1:E{count+1}")
            expected = {
                "backgroundColors": (["#173F5F"] * 5, ["#FFF1E6", "#EAF3F8", "#EDF6E8", "#F1EDFA", "#F5F7F9"]),
                "fontColors": (["#FFFFFF"] * 5, ["#233746"] * 5),
                "fontSizes": ([12] * 5, [11] * 5),
                "fontWeights": (["bold"] * 5, ["bold", "normal", "normal", "normal", "normal"]),
                "horizontalAlignments": (["center"] * 5, ["left", "left", "left", "left", "center"]),
                "verticalAlignments": (["middle"] * 5, ["middle"] * 5),
            }
            for key, (header, body) in expected.items():
                self.assertEqual(style[key], [header] + [body] * count)
            self.assertEqual(style["wordWrap"], "autoWrap")

    def test_consecutive_formats_including_empty(self):
        for count in (0, 1, 13, 40):
            calls = self.capture("style_consecutive_incomplete_sheet", count)
            ranges = [args for method, args in calls if method == "update_range"]
            self.assertEqual(len(ranges), 1)
            style = ranges[0]
            self.assertEqual(style["rangeAddress"], f"A1:F{count+1}")
            self.assertEqual(style["backgroundColors"], [["#173F5F"]*6] + [["#F7FAFC", "#FCE8E6", "#FFF0E4", "#FFF6DF", "#EAF3F8", "#F5F7F9"]]*count)
            self.assertEqual(style["fontWeights"], [["bold"]*6] + [["bold", "bold", "normal", "normal", "normal", "normal"]]*count)
            for key in ("fontColors", "fontSizes", "horizontalAlignments", "verticalAlignments"):
                self.assertEqual(len(style[key]), count+1)
                self.assertTrue(all(len(row)==6 for row in style[key]))
            self.assertTrue(any(method == "create_filter" for method, _ in calls))

if __name__ == "__main__":
    unittest.main()
