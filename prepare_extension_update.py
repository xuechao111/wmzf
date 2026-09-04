from __future__ import annotations
import json
import sys
import traceback
from pathlib import Path
import run_dashboard_update as dashboard

out = Path(sys.argv[1]) if len(sys.argv) > 1 else dashboard.ROOT / "extension-classes.json"
error_out = Path(sys.argv[2]) if len(sys.argv) > 2 else dashboard.ROOT / "prepare-error.json"
try:
    pairs = dashboard.configured_classes() or dashboard.read_classes()
    dashboard.DATA.mkdir(exist_ok=True)
    (dashboard.DATA / "classes.json").write_text(json.dumps(pairs, ensure_ascii=False), encoding="utf-8")
    excluded = dashboard.dashboard_config().get("excludedTeachers") or ["薛超"]
    out.write_text(json.dumps({"classes": pairs, "excludedTeachers": excluded}, ensure_ascii=False), encoding="utf-8")
    error_out.unlink(missing_ok=True)
except Exception as exc:
    error_out.write_text(json.dumps({
        "message": str(exc) or exc.__class__.__name__,
        "type": exc.__class__.__name__,
        "trace": traceback.format_exc(limit=4),
    }, ensure_ascii=False), encoding="utf-8")
    raise SystemExit(1)
