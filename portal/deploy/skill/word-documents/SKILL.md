---
name: word-documents
description: Create or edit Word documents (.docx) – letters, offers, reports, minutes, CVs. Use whenever the user wants a Word/DOCX file as the result.
---

# Word documents (.docx)

Use `python-docx` in the code tool and save the result to `/mnt/data/<meaningful-name>.docx`.

## Workflow

1. Clarify the content in your head first (title, sections, tables); write in the user's language.
2. Build the document with python-docx:
   - `Document()`; title with `add_heading(text, 0)`, sections with `add_heading(text, 1..3)`.
   - Paragraphs with `add_paragraph`; bullet lists with `style='List Bullet'`, numbered with `style='List Number'`.
   - Tables: `add_table(rows, cols)`, `table.style = 'Light Grid Accent 1'`, header row bold.
   - Page margins via `section.left_margin = Cm(2.5)` etc.; default font via `styles['Normal'].font`.
   - German dates (`19.10.2026`) and number formats (`1.234,50 €`) for German texts.
3. Save to `/mnt/data/…docx`, then re-open it with python-docx and print the headings to verify.
4. Tell the user briefly what the file contains. Do not paste download links; the chat shows the file.

## Editing an uploaded .docx

Uploaded files are in `/mnt/data/`. Open with `Document(path)`, change paragraphs or tables in place,
keep existing styles, and save under a new name (e.g. `…_bearbeitet.docx`) unless asked to overwrite.
