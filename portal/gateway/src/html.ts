/** Minimal auto-escaping HTML templating for the server-rendered pages. */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | Interpolation[]

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return ''
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  return escapeHtml(String(value))
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? ''
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '')
  })
  return new SafeHtml(out)
}

/** Trusted markup (e.g. a generated SVG QR code). */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value)
}

const STYLE = `
:root { --bg:#f7f7f5; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e4e4df; --accent:#0f766e; --danger:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#1b1b19; --card:#252523; --text:#ececea; --muted:#a3a39d; --line:#3a3a37; --accent:#2dd4bf; --danger:#f97066; } }
* { box-sizing: border-box; }
body { margin:0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
main.narrow { max-width: 440px; }
h1 { font-size: 1.5rem; margin: 8px 0 16px; } h2 { font-size: 1.15rem; margin: 24px 0 8px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin: 12px 0; }
label { display:block; font-weight:600; margin: 12px 0 4px; }
input, select { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:1rem; }
button, .button { display:inline-block; margin-top:16px; padding:10px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; font-size:1rem; cursor:pointer; text-decoration:none; }
button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
button.danger { background:var(--danger); }
.muted { color:var(--muted); font-size:.9rem; }
.error { color:var(--danger); font-weight:600; }
.ok { color:var(--accent); font-weight:600; }
table { width:100%; border-collapse:collapse; font-size:.95rem; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align: top; }
th { color:var(--muted); font-weight:600; }
.table-wrap { overflow-x:auto; }
nav { display:flex; gap:16px; flex-wrap:wrap; padding: 12px 16px; border-bottom:1px solid var(--line); background:var(--card); }
nav a { color:var(--text); text-decoration:none; font-weight:600; } nav a.active { color:var(--accent); }
.qr svg { width: 260px; max-width: 100%; height: auto; background:#fff; padding: 8px; border-radius: 8px; }
.row { display:flex; gap:12px; flex-wrap:wrap; } .row > * { flex: 1 1 200px; }
code { word-break: break-all; }
form.inline { display:inline; } form.inline button { margin-top:0; padding:4px 10px; font-size:.85rem; }
`

export function page(title: string, body: SafeHtml, options: { narrow?: boolean; nav?: SafeHtml } = {}): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · A-B Cloud AI Portal</title>
<style>${STYLE}</style>
</head>
<body>
${options.nav?.value ?? ''}
<main${options.narrow ? ' class="narrow"' : ''}>
${body.value}
</main>
</body>
</html>`
}
