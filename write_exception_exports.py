from __future__ import annotations

import json

from run_dashboard_update import DATA, write_sheet


def main() -> None:
    export = json.loads((DATA / "exception-export-tables.json").read_text(encoding="utf-8"))
    names = ("异常学员", "推荐话术")
    counts = {name: write_sheet(name, export["tables"][name]) for name in names}
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()
