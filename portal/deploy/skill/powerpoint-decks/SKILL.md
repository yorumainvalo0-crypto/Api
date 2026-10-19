---
name: powerpoint-decks
description: Create PowerPoint presentations (.pptx) – pitch decks, overviews, training slides. Use whenever the user wants slides or a presentation file.
---

# PowerPoint presentations (.pptx)

Use `python-pptx` in the code tool and save to `/mnt/data/<meaningful-name>.pptx`.

## Workflow

1. Outline first: title slide, 1 message per slide, closing slide. Usually 5–12 slides.
2. `Presentation()`, set 16:9: `prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`.
3. Layouts: 0 title, 1 title + content, 5 title only, 6 blank. Bullets at most 5 per slide,
   short phrases, 2 levels max (`paragraph.level = 1`).
4. Charts via `slide.shapes.add_chart(XL_CHART_TYPE.…, …, CategoryChartData())`; tables via
   `add_table`; images (e.g. matplotlib PNGs saved to /tmp) via `add_picture`.
5. Consistent colours: pick one accent colour and use it for titles and highlights.
6. Speaker notes with `slide.notes_slide.notes_text_frame.text` when useful.
7. Save, reload with python-pptx and print each slide title to verify.
