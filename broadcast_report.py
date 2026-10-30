"""Readable, color-coded teacher broadcasts using the authorized snapshot."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path
import os
from PIL import Image, ImageDraw, ImageFont
from broadcast_scope import group_rows

SOURCE_ROOT = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("HF_DASHBOARD_ROOT") or SOURCE_ROOT / "instances" / "test")
OUT = ROOT / 'run-data' / 'group-broadcast-colored'
THRESHOLD = 0.03


def cohort_title(cohort):
    return re.sub(r'\b\d{4}-(\d{2}-\d{2})', r'\1', str(cohort)).replace('·', '').replace(' ', '')
COLORS = {'异常': ('#fee2e2', '#b91c1c', '🟥'), '优秀': ('#dcfce7', '#15803d', '🟩'), '正常': ('#e8eef5', '#334155', '⬜'), '待核对': ('#fef3c7', '#92400e', '🟨'), '无数据': ('#f1f5f9', '#64748b', '⬜')}


def metric(row, kind):
    c = row.get('current') or {}
    live = kind == 'live'
    den = c.get('liveExpected' if live else 'evenExpected')
    val = c.get('liveRate' if live else 'finishRate')
    gap = row.get('cohortLiveGap' if live else 'cohortFinishGap')
    done = c.get('liveAttend' if live else 'evenDone')
    if live and (c.get('detailLiveFallbacks') or c.get('missingLiveBoards')):
        return '待核对', '待核对', '缺可靠直播记录'
    if not den or val is None:
        return '无数据', '—', '暂无可计算比例'
    status = '正常'
    if isinstance(gap, (int, float)) and math.isfinite(gap):
        status = '优秀' if gap >= THRESHOLD - 1e-10 else '异常' if gap <= -THRESHOLD + 1e-10 else '正常'
    detail = f'{done}/{den} 人次'
    detail += f' · 同期 {gap * 100:+.1f}pp' if gap is not None else ' · 暂无同期对比'
    return status, f'{val:.1%}', detail


def order(row):
    # Within each cohort, show the lowest peer-relative result first.
    gaps = [row.get(k) for k in ('cohortLiveGap', 'cohortFinishGap')]
    numeric = [g for g in gaps if isinstance(g, (int, float))]
    weakest = min(numeric) if numeric else 999
    abnormal = sum(metric(row, k)[0] == '异常' for k in ('live', 'finish'))
    return (weakest, -abnormal, row.get('teacher', ''))


def describe(row):
    flags = []
    for kind, label in [('live', '直播'), ('finish', '完课')]:
        status, val, detail = metric(row, kind)
        if status in ('异常', '优秀', '待核对'):
            flags.append(f'{label}{status}')
    return ' / '.join(flags) or '正常'


def build():
    snapshot = json.loads((ROOT / 'dashboard-snapshot.json').read_text(encoding='utf-8'))
    if not snapshot.get('updatedAt') or not snapshot.get('rows'):
        raise ValueError('没有有效快照')
    groups = defaultdict(list)
    for row in group_rows(snapshot, ROOT):
        groups[row.get('cohort') or '未标注课期'].append(row)
    if not groups:
        raise ValueError('没有本组老师数据，停止通晒')
    OUT.mkdir(parents=True, exist_ok=True)
    fonts = {size: ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', size) for size in (19, 21, 23, 26, 32, 38, 44)}
    manifest = []
    for index, (cohort, rows) in enumerate(sorted(groups.items()), 1):
        rows.sort(key=order)
        periods = '、'.join(sorted({r.get('currentWeek') or '未标注' for r in rows}))
        abnormal = sum(any(metric(r,k)[0]=='异常' for k in ('live','finish')) for r in rows)
        excellent = sum(any(metric(r,k)[0]=='优秀' for k in ('live','finish')) for r in rows)
        text = [f'## {cohort_title(cohort)}', f'数据 {snapshot["updatedAt"]}｜统计 {periods}']
        for row in rows:
            c = row.get('current') or {}
            lines = [f'#### 【{row["teacher"]}】']
            for kind, label in [('live', '直播上座率'), ('finish', '完课率')]:
                status, val, _ = metric(row, kind)
                marker = COLORS[status][2] + ' ' if status in ('异常', '优秀', '待核对') else ''
                suffix = f'（{status}）' if status != '正常' else ''
                lines.append(f'{marker}{label}：{val}{suffix}')
            lines.append(f'🟧 当前未完课 {c.get("incompleteStudents", "—")} 人')
            text.append('\n\n'.join(lines))
        message = '\n\n'.join(text)
        md = OUT / f'cohort-{index:02d}.md'
        md.write_text(message, encoding='utf-8')
        for page, start in enumerate(range(0,len(rows),5),1):
            subset = rows[start:start+5]
            image = Image.new('RGB', (1200, 310+len(subset)*315), '#f1f5f9')
            draw = ImageDraw.Draw(image)
            def put(x,y,value,size=23,color='#19334d'):
                draw.text((x,y),str(value),font=fonts[size],fill=color)
            draw.rectangle((0,0,1200,140),fill='#173451')
            put(32,20,cohort_title(cohort),38,'white')
            put(32,82,f'教学更新 {snapshot["updatedAt"]}  |  统计 {periods}',21,'#dce9f3')
            put(32,158,f'{len(rows)} 位老师  |  异常 {abnormal} 位  |  优秀 {excellent} 位（可重叠）',26)
            put(32,202,'红：低于同期均值≥3pp    绿：高于同期均值≥3pp    灰：正常/无数据',21)
            for position,row in enumerate(subset):
                y=245+position*315
                c=row.get('current') or {}
                draw.rounded_rectangle((24,y,1176,y+300),radius=14,fill='white')
                put(44,y+16,row['teacher'],32)
                
                for col,(kind,label) in enumerate([('live','直播上座率'),('finish','完课率')]):
                    status,val,detail=metric(row,kind)
                    bg,fg,_=COLORS[status]
                    x=44+col*556
                    draw.rounded_rectangle((x,y+95,x+530,y+199),radius=10,fill=bg)
                    put(x+14,y+103,label,23)
                    put(x+300,y+96,val,44,fg)
                    put(x+14,y+157,status,21,fg)
                put(44,y+230,f'当前未完课学员 {c.get("incompleteStudents","—")} 人',26,'#a64b13')
            put(32,image.height-50,f'仅本组老师  |  pp=百分点  |  {page}/{math.ceil(len(rows)/5)}',19,'#64748b')
            path=OUT/f'cohort-{index:02d}-{page:02d}.png'
            image.save(path)
            manifest.append({'cohort':cohort,'page':page,'image':str(path.resolve()),'markdown':str(md.resolve()),'updatedAt':snapshot['updatedAt']})
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--send',action='store_true')
    parser.add_argument('--force',action='store_true')
    args=parser.parse_args()
    manifest=build()
    if args.send:
        from dingtalk_group_sender import send_markdown
        receipt_path=OUT/'send-receipts.local.json'
        receipts=json.loads(receipt_path.read_text(encoding='utf-8')) if receipt_path.exists() else []
        sent = 0
        for file in dict.fromkeys(m['markdown'] for m in manifest):
            item=next(m for m in manifest if m['markdown']==file)
            content=Path(file).read_text(encoding='utf-8')
            digest=hashlib.sha256(content.encode('utf-8')).hexdigest()[:16]
            key=f'{item["cohort"]}|{item["updatedAt"]}|3pp|low-to-high-v2|{digest}'
            if any(r['key']==key for r in receipts) and not args.force:
                continue
            if len(content.encode('utf-8'))>18000:
                raise ValueError('消息过长，尚未发送')
            result=send_markdown(cohort_title(item['cohort']),content)
            receipts.append({'key':key,'ok':result['ok'],'format':'markdown','imagesSent':0})
            receipt_path.write_text(json.dumps(receipts,ensure_ascii=False,indent=2),encoding='utf-8')
            sent += 1
        print(json.dumps({'cohortsSentThisRun':sent,'imagesSent':0}))
    else:
        print(json.dumps({'images':len(manifest),'cohorts':len({m['cohort'] for m in manifest})}))
