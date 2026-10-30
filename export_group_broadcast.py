"""Render cohort teacher summaries locally; never sends or uploads data."""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
import os

from PIL import Image, ImageDraw, ImageFont
from broadcast_scope import group_rows


def rate(value, denominator):
    return "—" if value is None or not denominator else f"{float(value):.1%}"


def export(snapshot_path: Path, destination: Path):
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for row in group_rows(snapshot, snapshot_path.parent):
        groups[str(row.get("cohort") or "未标注课期")].append(row)
    if not groups or not snapshot.get("updatedAt"):
        raise ValueError("没有有效的老师数据或更新时间，不能生成通晒图片")
    destination.mkdir(parents=True, exist_ok=True)
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 23)
    small = ImageFont.truetype(str(font_path), 20)
    title = ImageFont.truetype(str(font_path), 34)
    headings = ["老师", "直播应到", "直播实到", "直播上座率", "偶数课完课率", "到课未完课"]
    widths = [180, 145, 145, 180, 210, 190]
    manifest = []
    for index, (cohort, rows) in enumerate(sorted(groups.items()), 1):
        rows.sort(key=lambda row: str(row.get("teacher") or ""))
        # Split large cohorts to keep each image readable in a group chat.
        for page, start in enumerate(range(0, len(rows), 20), 1):
            subset = rows[start:start + 20]
            width, height = sum(widths) + 64, 262 + len(subset) * 62
            picture = Image.new("RGB", (width, height), "#f1f5f9")
            draw = ImageDraw.Draw(picture)
            draw.rectangle((0, 0, width, 120), fill="#173451")
            draw.text((32, 22), f"{cohort} · 老师教学数据", font=title, fill="white")
            draw.text((32, 76), f"数据更新：{snapshot['updatedAt']}（北京时间）", font=small, fill="#d2e5f3")
            x = 32
            for label, cell_width in zip(headings, widths):
                draw.text((x + 10, 142), label, font=small, fill="#173451")
                x += cell_width
            for row_index, row in enumerate(subset):
                current = row.get("current") or {}
                cells = [row.get("teacher") or "—", current.get("liveExpected"), current.get("liveAttend"), rate(current.get("liveRate"), current.get("liveExpected")), rate(current.get("finishRate"), current.get("evenExpected")), current.get("arrivedIncomplete")]
                y = 182 + row_index * 62
                draw.rectangle((32, y, width - 32, y + 60), fill="white" if row_index % 2 == 0 else "#e5eef6")
                x = 32
                for cell_index, (value, cell_width) in enumerate(zip(cells, widths)):
                    value = "—" if value is None else str(value)
                    color = "#bf5b17" if cell_index == 5 and value not in ("0", "—") else "#173451"
                    draw.text((x + 10, y + 16), value, font=font, fill=color)
                    x += cell_width
            periods = "、".join(sorted({str(row.get("currentWeek") or "未标注") for row in subset}))
            draw.text((32, height - 62), f"统计周期：{periods}", font=small, fill="#546579")
            draw.text((32, height - 34), "— 表示暂无可计算的比例；图片使用工作台快照数据。", font=small, fill="#546579")
            path = destination / f"cohort-{index:02d}-{page:02d}.png"
            picture.save(path)
            manifest.append({"cohort": cohort, "page": page, "teachers": len(subset), "image": str(path.resolve()), "updatedAt": snapshot["updatedAt"]})
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent / "instances" / "test") / "dashboard-snapshot.json")
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent / "instances" / "test") / "run-data" / "group-broadcast")
    args = parser.parse_args()
    results = export(args.snapshot, args.output)
    print(json.dumps({"images": len(results), "cohorts": len({r['cohort'] for r in results}), "output": str(args.output.resolve())}, ensure_ascii=False))
