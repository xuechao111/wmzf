from __future__ import annotations

import json
import sys
from pathlib import Path

import run_dashboard_update as dashboard


def prepare(out: Path) -> dict:
    # A failed source read must never silently reuse an old class list.
    pairs = dashboard.read_classes()
    dashboard.DATA.mkdir(exist_ok=True)
    payload = {
        "classes": pairs,
        "excludedTeachers": dashboard.dashboard_config().get("excludedTeachers") or ["薛超"],
        "classSource": "workbook",
    }
    (dashboard.DATA / "classes.json").write_text(json.dumps(pairs, ensure_ascii=False), encoding="utf-8")
    temporary = out.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(out)
    print(f"已从钉钉班级id子表读取最新名单：{len(pairs)} 个班级。", flush=True)
    return payload


if __name__ == "__main__":
    prepare(Path(sys.argv[1]) if len(sys.argv) > 1 else dashboard.ROOT / "extension-classes.json")
