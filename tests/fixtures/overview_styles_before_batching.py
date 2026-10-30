def style_overview_sheet(sheet_id: str, table: dict, initialize_layout: bool = True) -> None:
    """Apply a compact, dashboard-like visual system to the overview sheet."""
    row_count = len(table.get("data", []))
    if not row_count:
        return
    columns = list(table.get("columns", []))
    col_count = max(1, len(columns))
    end_col = col_letter(col_count - 1)
    end_row = row_count + 1
    matrix = lambda rows, cols, value: [[value] * cols for _ in range(rows)]
    try:
        if initialize_layout:
            mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1, "frozenColumnCount": 2})
            mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
            try:
                mcp_call("delete_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id})
            except Exception:
                pass
            mcp_call("create_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A1:{end_col}{end_row}"})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A1:{end_col}1",
                     "backgroundColors": matrix(1, col_count, "#173F5F"), "fontColors": matrix(1, col_count, "#FFFFFF"),
                     "fontWeights": matrix(1, col_count, "bold"), "fontSizes": matrix(1, col_count, 12),
                     "horizontalAlignments": matrix(1, col_count, "center"), "verticalAlignments": matrix(1, col_count, "middle"), "wordWrap": "autoWrap"})
        term_colors = ["#EAF3F8", "#EDF6E8", "#FFF1E6", "#F1EDFA"]
        terms = []
        body_backgrounds, body_fonts, body_weights, body_alignments = [], [], [], []
        warning_index = columns.index("同期异常") if "同期异常" in columns else -1
        for row in table["data"]:
            term = str(row[0])
            if term not in terms:
                terms.append(term)
            color = term_colors[terms.index(term) % len(term_colors)]
            normal = warning_index < 0 or str(row[warning_index] or "") == "正常"
            backgrounds, fonts, weights, alignments = [], [], [], []
            for column in columns:
                if column in {"主课期", "老师", "班级数"}:
                    fill = color
                elif column == "到课率":
                    fill = "#FFF6DF"
                elif column == "直播上座率":
                    fill = "#E6F1F7"
                elif column == "偶数课完课率":
                    fill = "#E9F4E7"
                elif column in {"未完课", "未准时参播", "观看回放", "到课未完课"}:
                    fill = {"未完课": "#FCE8E6", "未准时参播": "#FFF0E4", "观看回放": "#F1EDFA", "到课未完课": "#FFF6DF"}[column]
                elif column == "同期异常":
                    fill = "#E8F7F2" if normal else "#FADBD8"
                else:
                    fill = "#FFFFFF"
                backgrounds.append(fill)
                fonts.append("#116F5E" if column == "同期异常" and normal else "#A3322E" if column == "同期异常" else "#233746")
                weights.append("bold" if column in {"主课期", "老师", "班级数", "同期异常"} else "normal")
                alignments.append("left" if column == "同期异常" else "center")
            body_backgrounds.append(backgrounds)
            body_fonts.append(fonts)
            body_weights.append(weights)
            body_alignments.append(alignments)
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A2:{end_col}{end_row}",
                 "backgroundColors": body_backgrounds, "fontColors": body_fonts, "fontWeights": body_weights,
                  "fontSizes": matrix(row_count, col_count, 11), "horizontalAlignments": body_alignments,
                  "verticalAlignments": matrix(row_count, col_count, "middle"), "wordWrap": "autoWrap"})
        for index, column in enumerate(columns):
            letter = col_letter(index)
            if column in {"到课率", "直播上座率", "偶数课完课率", "IM 3分钟回复率", "企微2小时回复率"}:
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{letter}2:{letter}{end_row}", "numberFormat": "0.0%"})
            elif column in {"班级数", "未完课", "未准时参播", "观看回放", "到课未完课"}:
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{letter}2:{letter}{end_row}", "numberFormat": "#,##0"})
        if initialize_layout:
            width_by_name = {"主课期": 120, "老师": 96, "班级数": 72, "同期异常": 320, "统计周期": 150, "教学服务更新时间": 170}
            dimensions = [("ROWS", "1", 1, 52), ("ROWS", "2", row_count, 38)]
            dimensions.extend(("COLUMNS", col_letter(index), 1, width_by_name.get(column, 104)) for index, column in enumerate(columns))
            for dimension, start, length, size in dimensions:
                mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": dimension,
                         "startIndex": start, "length": length, "pixelSize": size})
    except Exception as exc:
        print(f"组内概览样式更新警告：{exc}", flush=True)

def style_overview_total_sheet(sheet_id: str, table: dict, initialize_layout: bool = True) -> None:
    """Style the console total-board export as a scannable table."""
    row_count = len(table.get("data", []))
    if not row_count:
        return
    columns = list(table.get("columns", []))
    col_count = max(1, len(columns))
    end_col = col_letter(col_count - 1)
    end_row = row_count + 1
    matrix = lambda rows, cols, value: [[value] * cols for _ in range(rows)]
    try:
        if initialize_layout:
            mcp_call("update_sheet", {"nodeId": WORKBOOK, "sheetId": sheet_id, "frozenRowCount": 1, "frozenColumnCount": 2})
            mcp_call("set_gridline_visibility", {"nodeId": WORKBOOK, "sheetId": sheet_id, "visibility": "hidden"})
            try:
                mcp_call("delete_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id})
            except Exception:
                pass
            mcp_call("create_filter", {"nodeId": WORKBOOK, "sheetId": sheet_id, "range": f"A1:{end_col}{end_row}"})
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A1:{end_col}1",
                     "backgroundColors": matrix(1, col_count, "#173F5F"), "fontColors": matrix(1, col_count, "#FFFFFF"),
                     "fontWeights": matrix(1, col_count, "bold"), "fontSizes": matrix(1, col_count, 12),
                     "horizontalAlignments": matrix(1, col_count, "center"), "verticalAlignments": matrix(1, col_count, "middle"), "wordWrap": "autoWrap"})
        backgrounds, font_colors, font_weights, alignments = [], [], [], []
        fills = {
            "课期": "#EAF3F8", "老师": "#EAF3F8", "最近开课": "#EAF3F8",
            "第一节课到课率": "#FFF6DF", "第一节课到课": "#FFF6DF",
            "准时直播上座率": "#E6F1F7", "准时直播": "#E6F1F7",
            "偶数课完课率": "#E9F4E7", "偶数课完课": "#E9F4E7",
            "今日IM电话接通率": "#EEF3FF", "IM电话接通/拨打": "#EEF3FF", "语音接通/拨打": "#EEF3FF", "视频接通/拨打": "#EEF3FF",
            "今日新增补课": "#E8F7F2", "今日新增补课明细": "#E8F7F2",
            "上周准时本周未到": "#FCE8E6", "上周准时本周未到明细": "#FCE8E6",
            "上周未到本周准时": "#E8F7F2", "上周未到本周准时明细": "#E8F7F2",
            "未完课学员": "#FCE8E6", "未准时参播": "#FFF0E4", "观看回放": "#F1EDFA", "到课未完课": "#FFF6DF",
        }
        detail_columns = {"今日新增补课明细", "上周准时本周未到明细", "上周未到本周准时明细"}
        def gap_style(value, default_fill: str) -> tuple[str, str, str]:
            try:
                number = float(value)
            except (TypeError, ValueError):
                return default_fill, "#233746", "normal"
            if number >= 0.05:
                return "#DDF4EA", "#08745E", "bold"
            if number <= -0.05:
                return "#FADBD8", "#A3322E", "bold"
            return default_fill, "#233746", "normal"
        def gap_number(value: object) -> float | None:
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
        row_meta = table.get("rowMeta", [])
        for row_index, row in enumerate(table.get("data", [])):
            row_fills, row_fonts, row_weights = [], [], []
            meta = row_meta[row_index] if row_index < len(row_meta) else {}
            live_gap = meta.get("liveGap") if isinstance(meta, dict) else None
            finish_gap = meta.get("finishGap") if isinstance(meta, dict) else None
            live_gap_number, finish_gap_number = gap_number(live_gap), gap_number(finish_gap)
            for col_index, column in enumerate(columns):
                default_fill = fills.get(column, "#F7FAFB" if row_index % 2 else "#FFFFFF")
                if column in {"准时直播上座率", "准时直播"}:
                    fill, font, weight = gap_style(live_gap, default_fill)
                elif column in {"偶数课完课率", "偶数课完课"}:
                    fill, font, weight = gap_style(finish_gap, default_fill)
                elif column == "老师" and (
                    (live_gap_number is not None and live_gap_number <= -0.05)
                    or (finish_gap_number is not None and finish_gap_number <= -0.05)
                ):
                    fill, font, weight = "#FCE8E6", "#A3322E", "bold"
                else:
                    fill, font, weight = default_fill, "#233746", "normal"
                row_fills.append(fill)
                row_fonts.append(font)
                row_weights.append(weight)
            backgrounds.append(row_fills)
            font_colors.append(row_fonts)
            font_weights.append(row_weights)
            alignments.append(["left" if column in {"课期", "老师", "最近开课"} or column in detail_columns else "center" for column in columns])
        mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"A2:{end_col}{end_row}",
                 "backgroundColors": backgrounds, "fontColors": font_colors, "fontWeights": font_weights,
                 "fontSizes": matrix(row_count, col_count, 11), "horizontalAlignments": alignments,
                 "verticalAlignments": matrix(row_count, col_count, "middle"), "wordWrap": "autoWrap"})
        for index, column in enumerate(columns):
            letter = col_letter(index)
            if column in {"第一节课到课率", "准时直播上座率", "偶数课完课率", "今日IM电话接通率"}:
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{letter}2:{letter}{end_row}", "numberFormat": "0.0%"})
            elif column in {"今日新增补课", "上周准时本周未到", "上周未到本周准时", "未完课学员", "未准时参播", "观看回放", "到课未完课"}:
                mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{letter}2:{letter}{end_row}", "numberFormat": "#,##0"})
        for index, column in enumerate(columns):
            if column not in detail_columns:
                continue
            letter = col_letter(index)
            mcp_call("update_range", {"nodeId": WORKBOOK, "sheetId": sheet_id, "rangeAddress": f"{letter}2:{letter}{end_row}",
                     "horizontalAlignments": matrix(row_count, 1, "left"), "wordWrap": "autoWrap"})
        if initialize_layout:
            width_by_name = {
                "课期": 120, "老师": 96, "最近开课": 126, "统计周期": 110,
                "第一节课到课率": 116, "准时直播上座率": 122, "偶数课完课率": 122, "今日IM电话接通率": 128,
                "第一节课到课": 104, "准时直播": 104, "偶数课完课": 104,
                "IM电话接通/拨打": 124, "语音接通/拨打": 112, "视频接通/拨打": 112,
                "今日新增补课明细": 320, "上周准时本周未到明细": 260, "上周未到本周准时明细": 260,
                "上周准时本周未到": 112, "上周未到本周准时": 112,
            }
            for index, column in enumerate(columns):
                mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": "COLUMNS",
                         "startIndex": col_letter(index), "length": 1, "pixelSize": width_by_name.get(column, 96)})
            mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": "ROWS",
                     "startIndex": "1", "length": 1, "pixelSize": 48})
        else:
            width_by_name = {"今日新增补课明细": 320, "上周准时本周未到明细": 260, "上周未到本周准时明细": 260}
            for index, column in enumerate(columns):
                if column in width_by_name:
                    mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": "COLUMNS",
                             "startIndex": col_letter(index), "length": 1, "pixelSize": width_by_name[column]})
        if row_count:
            mcp_call("update_dimension", {"nodeId": WORKBOOK, "sheetId": sheet_id, "dimension": "ROWS",
                     "startIndex": "2", "length": row_count, "pixelSize": 58})
    except Exception as exc:
        print(f"组内教学总看板样式更新警告：{exc}", flush=True)