import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def letter(index):
    result = ""
    while index >= 0:
        result = chr(index % 26 + 65) + result
        index = index // 26 - 1
    return result

def capture(source, name, table, initialize):
    tree = ast.parse(source)
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {name, "apply_column_number_formats"}]
    calls = []
    scope = {"WORKBOOK": "offline", "mcp_call": lambda method, args: calls.append((method,args)), "col_letter": letter}
    exec(compile(ast.Module(body=functions,type_ignores=[]), "styles", "exec"),scope)
    scope[name]("sheet",table,initialize)
    return calls

def cells(calls):
    result = {}
    other = []
    for method,args in calls:
        if method != "update_range":
            other.append((method,args))
            continue
        match = re.fullmatch(r"([A-Z]+)([0-9]+):([A-Z]+)([0-9]+)",args["rangeAddress"])
        def index(text):
            value=0
            for char in text: value=value*26+ord(char)-64
            return value-1
        c1,r1,c2,r2=match.groups()
        for row in range(int(r1),int(r2)+1):
            for col in range(index(c1),index(c2)+1):
                for key,value in args.items():
                    if key in {"nodeId","sheetId","rangeAddress"}: continue
                    result[(row,col,key)] = value[row-int(r1)][col-index(c1)] if isinstance(value,list) else value
    return result,other

class OverviewBatchingTests(unittest.TestCase):
    def test_exact_cell_equivalence(self):
        old=(ROOT/"tests/fixtures/overview_styles_before_batching.py").read_text(encoding="utf-8")
        new=(ROOT/"run_dashboard_update.py").read_text(encoding="utf-8")
        configs = [
          ("style_overview_sheet",["主课期","老师","班级数","到课率","直播上座率","偶数课完课率","未完课","未准时参播","观看回放","到课未完课","同期异常","统计周期"]),
          ("style_overview_total_sheet",["课期","老师","最近开课","第一节课到课率","准时直播上座率","偶数课完课率","今日IM电话接通率","今日新增补课","今日新增补课明细","未完课学员","未准时参播","观看回放","到课未完课"]),
        ]
        for name,columns in configs:
            for initialize in (False,True):
                for count in (0,1,13):
                    table={"columns":columns,"data":[["normal"]*len(columns) for _ in range(count)],"rowMeta":[{"liveGap":-.06,"finishGap":.08}]*count}
                    before=capture(old,name,table,initialize)
                    after=capture(new,name,table,initialize)
                    self.assertEqual(cells(before),cells(after),(name,count,initialize))
                    if count: self.assertLess(len(after),len(before))

if __name__ == "__main__": unittest.main()
