"""Use the workbench's group membership rules for every broadcast."""
import json
from pathlib import Path


def group_rows(snapshot, root=None):
    root = Path(root) if root else Path(__file__).parent
    # Fail closed if membership configuration cannot be read.
    config = json.loads((root / 'dashboard-config.json').read_text(encoding='utf-8'))
    excluded = {'薛超'}
    for field in ('comparisonTeachers', 'excludedTeachers'):
        names = config.get(field, [])
        if not isinstance(names, list):
            raise ValueError(f'Invalid membership configuration: {field}')
        excluded.update(str(name).strip() for name in names)
    return [row for row in snapshot.get('rows', []) if str(row.get('teacher') or '').strip() and str(row['teacher']).strip() not in excluded]
