from __future__ import annotations
import json
import sys
from pathlib import Path
import run_dashboard_update as dashboard

out = Path(sys.argv[1]) if len(sys.argv) > 1 else dashboard.ROOT / "extension-classes.json"


def cached_classes() -> list[list[int]]:
    candidates = [out, dashboard.DATA / "classes.json", dashboard.ROOT / "extension-classes.json"]
    for path in candidates:
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            rows = payload.get("classes") if isinstance(payload, dict) else payload
            pairs = []
            for row in rows or []:
                class_id, term_id = int(float(row[0])), int(float(row[1]))
                if class_id and term_id:
                    pairs.append([class_id, term_id])
            if pairs:
                return [list(pair) for pair in dict.fromkeys((class_id, term_id) for class_id, term_id in pairs)]
        except (OSError, ValueError, TypeError, IndexError, json.JSONDecodeError):
            continue
    return []


pairs = dashboard.configured_classes()
if not pairs:
    try:
        pairs = dashboard.read_classes()
    except Exception as exc:
        pairs = cached_classes()
        if not pairs:
            raise RuntimeError(f"无法读取钉钉班级配置，且本地没有可用缓存：{exc}") from exc
        print(f"钉钉班级配置暂时读取失败，已使用上次成功缓存继续：{exc}", file=sys.stderr)
dashboard.DATA.mkdir(exist_ok=True)
(dashboard.DATA / "classes.json").write_text(json.dumps(pairs, ensure_ascii=False), encoding="utf-8")
excluded = dashboard.dashboard_config().get("excludedTeachers") or ["薛超"]
out.write_text(json.dumps({"classes": pairs, "excludedTeachers": excluded}, ensure_ascii=False), encoding="utf-8")
