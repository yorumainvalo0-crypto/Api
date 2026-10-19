---
name: pdf-documents
description: Create PDF files (reports, invoices, forms, handouts) or work with uploaded PDFs (extract text, merge, split, rotate). Use whenever the user wants a PDF as the result.
---

# PDF documents

## Creating PDFs

Use `reportlab.platypus` (`SimpleDocTemplate`, `Paragraph`, `Table`, `Spacer`, `Image`) for
documents with flowing text and tables; save to `/mnt/data/<meaningful-name>.pdf`.

- A4 (`from reportlab.lib.pagesizes import A4`), margins 2–2.5 cm.
- Use the DejaVu fonts for umlauts and €:
  `pdfmetrics.registerFont(TTFont('DejaVu', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))`
  and `DejaVu-Bold` from `DejaVuSans-Bold.ttf`; set them in the paragraph styles.
- Tables with `TableStyle` (grid, bold header, alternating row colours).
- Charts: render with matplotlib to a PNG in /tmp and embed with `Image`.
- Page numbers via an `onPage` callback.

## Working with uploaded PDFs

`pypdf`: `PdfReader('/mnt/data/<file>.pdf')` for text (`page.extract_text()`), `PdfWriter` to merge,
split, rotate or remove pages. Save results under new names in `/mnt/data/`.

Always reopen the result with pypdf and print the page count to verify.
