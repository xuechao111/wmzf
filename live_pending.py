"""Limit unavailable live-room data to the affected generated live cells."""


def is_pending(metrics):
    return bool(metrics.get("livePending") or metrics.get("missingLiveBoards") or metrics.get("detailLiveFallbacks"))


def apply_live_pending(tables, snapshot):
    pending_classes = {str(row.get("classId")) for row in snapshot.get("classes", []) if is_pending(row.get("current") or {})}
    pending_teachers = {str(row.get("teacher")) for row in snapshot.get("rows", []) if is_pending(row.get("current") or {})}
    pending_pairs = {(str(row.get("teacher")), str(row.get("cohort"))) for row in snapshot.get("rows", []) if is_pending(row.get("current") or {})}
    for name, table in tables.items():
        columns = table.get("columns", [])
        class_index = next((i for i, col in enumerate(columns) if col in ("班级ID", "班级id")), None)
        teacher_index = next((i for i, col in enumerate(columns) if col in ("老师", "老师姓名")), None)
        cohort_index = next((i for i, col in enumerate(columns) if col in ("主课期", "课期")), None)
        if name == "班级直播上座":
            existing = {str(row[class_index]) for row in table.get("data", [])} if class_index is not None else set()
            for row in snapshot.get("classes", []):
                if str(row.get("classId")) in pending_classes and str(row.get("classId")) not in existing:
                    values = {"老师姓名": row.get("teacher", ""), "班型": row.get("slot", ""), "班级ID": row.get("classId"), "班级": row.get("className", ""), "课期": row.get("cohort", ""), "统计周期": row.get("currentWeek", "")}
                    table["data"].append([values.get(column, "待更新") for column in columns])
        for row in table.get("data", []):
            pending = class_index is not None and class_index < len(row) and str(row[class_index]) in pending_classes
            if class_index is None and teacher_index is not None and teacher_index < len(row):
                teacher = str(row[teacher_index])
                pending = (teacher, str(row[cohort_index])) in pending_pairs if cohort_index is not None else teacher in pending_teachers
            if not pending:
                continue
            for i, col in enumerate(columns):
                if i >= len(row):
                    continue
                if any(word in col for word in ("直播", "参播", "回放", "回看")) and col not in ("直播课名", "直播课程名"):
                    row[i] = "待更新"
                elif col == "同期异常":
                    row[i] = "直播待更新" + ("；" + row[i] if row[i] not in ("", "正常") else "")
