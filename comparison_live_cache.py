"""Keep verified comparison rosters across ordinary group refreshes."""
import copy
import json
from pathlib import Path


def identity(block):
    return (str(block.get('classId')), str(block.get('termId')), str(block.get('info', {}).get('teacherName')))


def lesson_identity(block, number):
    return next(((str(x.get('course_id')), str(x.get('unlock_time'))) for x in block.get('lessons', []) if str(x.get('course_number')) == str(number)), None)


def merge_verified(incoming, saved, names):
    old = {identity(b): b for b in saved}
    result = copy.deepcopy(incoming)
    for block in result:
        name = str(block.get('info', {}).get('teacherName', '')).rsplit('-C', 1)[0]
        if name not in names:
            continue
        previous = old.get(identity(block), {})
        live = block.setdefault('liveAttendance', {})
        for number, roster in previous.get('liveAttendance', {}).items():
            if number in live or not roster.get('expectedIds'):
                continue
            if lesson_identity(block, number) is not None and lesson_identity(block, number) == lesson_identity(previous, number):
                live[number] = copy.deepcopy(roster)
    return result


def preserve(root):
    root = Path(root)
    config = json.loads((root / 'dashboard-config.json').read_text(encoding='utf-8-sig'))
    names = set(config.get('comparisonTeachers', []))
    if not names:
        return
    raw = root / 'run-data/group-lessons-raw.json'
    cache = root / 'run-data/comparison-teachers-verified.json'
    incoming = json.loads(raw.read_text(encoding='utf-8-sig'))
    saved = json.loads(cache.read_text(encoding='utf-8-sig')) if cache.exists() else []
    merged = merge_verified(incoming, saved, names)
    cached = [b for b in merged if str(b.get('info', {}).get('teacherName', '')).rsplit('-C', 1)[0] in names]
    # Keep only class/lesson identities present in this batch; removed classes
    # must not silently reappear from a historical cache.
    for path, value in ((cache, cached), (raw, merged)):
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        temp.replace(path)
