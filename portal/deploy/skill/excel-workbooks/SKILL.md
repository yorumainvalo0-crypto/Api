---
name: excel-workbooks
description: Create or analyse Excel files (.xlsx) – tables, calculations, budgets, lists, charts. Use whenever the user wants a spreadsheet or uploads one for analysis.
---

# Excel workbooks (.xlsx)

Use `openpyxl` (formulas, formatting, charts) or `pandas` + `xlsxwriter` (data exports) in the code
tool. Save to `/mnt/data/<meaningful-name>.xlsx`.

## Rules

- Keep live formulas where users expect to change inputs (`ws['C2'] = '=A2*B2'`), not only values.
- Header row bold with a fill colour, freeze panes below the header (`ws.freeze_panes = 'A2'`),
  sensible column widths, number formats (`'#,##0.00 €'`, `'0.0%'`, `'DD.MM.YYYY'`).
- One topic per sheet with a clear sheet name; add a summary sheet for larger workbooks.
- Charts with `openpyxl.chart` (BarChart, LineChart, PieChart) referencing the data ranges.
- After saving, reload with `openpyxl.load_workbook(path, data_only=False)` and print sheet names
  and the first rows to verify.

## Analysing an uploaded file

Read with `pandas.read_excel('/mnt/data/<file>', sheet_name=None)` to see every sheet, print shapes
and the first rows, then answer. Write results to a new workbook if the user wants a file back.
