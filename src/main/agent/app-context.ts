import type { Effort, JevSource, ProviderId } from '@shared/schemas/settings'
import { EFFORT_LABELS, PROVIDER_LABELS } from '@shared/schemas/settings'

/** What is set up in this session; drives the "what the app can do" part of the system prompt. */
export interface AppCapabilities {
  mode: 'chat' | 'code'
  provider: ProviderId
  model: string
  effort: Effort
  webAccess: boolean
  image:
    { backend: 'openrouter'; ready: boolean; model: string } | { backend: 'comfyui'; url: string }
  /** Names of imported ComfyUI 3D workflows (generate_3d_model). */
  workflows3d: string[]
  ocr: { enabled: boolean; model: string }
  jev: { active: true; source: JevSource } | { active: false; reason: string }
  skills: string[]
  plugins: number
  mcpServers: string[]
}

const SOURCE_LABELS: Record<JevSource, string> = {
  typesafe: 'TypeSafe direkt',
  openrouter: 'OpenRouter',
}

/**
 * Describes the app and the tools available right now, so the model can use them proactively,
 * answer questions about the app and tell the user where to switch on what is missing.
 */
export function describeAppCapabilities(c: AppCapabilities): string {
  const on = (active: boolean, text: string, howTo: string) =>
    active ? `${text} – aktiv.` : `${text} – NICHT aktiv. Einschalten: ${howTo}.`
  const tool = (name: string) => (c.mode === 'code' ? `mcp__media__${name}` : name)

  const jev = c.jev.active
    ? `**Jev von TypeSafe AI** (Werkzeug mcp__jev__evaluate, über ${SOURCE_LABELS[c.jev.source]}) – aktiv. ` +
      'Jev ist ein schnelles, typsicheres Entscheidungsmodell: Du stellst in einem Aufruf mehrere ' +
      'getypte Fragen zu einem Text oder JSON und bekommst kalibrierte Wahrscheinlichkeiten zurück – ' +
      'choice (eine von bis zu 255 Optionen), score (Stufe 2–10) und noul (Ja/Nein als ' +
      'Wahrscheinlichkeit 0–1). Nutze es, wenn der Nutzer Jev/TypeSafe erwähnt, und von dir aus ' +
      'zum Klassifizieren, Bewerten, Routen, für Duplikat-Prüfungen oder um deine eigene Antwort zu ' +
      'prüfen. Jev schreibt keine Texte; die Formulierung übernimmst du.'
    : `**Jev von TypeSafe AI** (typsichere Entscheidungen) – NICHT aktiv: ${c.jev.reason} ` +
      'Einschalten: Einstellungen → „Jev (TypeSafe)“ → TypeSafe-Key von console.typesafe.ai ' +
      'eintragen oder Zugang „Über OpenRouter“ wählen. Behaupte nicht, Jev zu nutzen, solange es ' +
      'nicht aktiv ist.'

  const image =
    c.image.backend === 'comfyui'
      ? `Bilder erzeugen/bearbeiten mit ${tool('generate_image')} – aktiv, lokal über ComfyUI (${c.image.url}).`
      : on(
          c.image.ready,
          `Bilder erzeugen/bearbeiten mit ${tool('generate_image')} über OpenRouter (${c.image.model})`,
          'OpenRouter-Key in den Einstellungen speichern oder „ComfyUI (lokal)“ wählen',
        )

  const lines = [
    '## Was die AI Workbench kann (Stand dieser Anfrage)',
    `Du läufst in der Desktop-App „AI Workbench“ des Nutzers (Windows). Aktiv: ${PROVIDER_LABELS[c.provider]}, ` +
      `Modell ${c.model || 'Standard'}, Effort ${EFFORT_LABELS[c.effort]}, Modus ${c.mode === 'code' ? 'Coding-Projekt' : 'Chat'}.`,
    '',
    '### Deine Werkzeuge',
    `- ${jev}`,
    `- ${on(c.webAccess, 'Internet: web_search (Websuche) und web_fetch (Seite lesen), kostenlos', 'Einstellungen → Internet')}`,
    `- ${image}`,
    `- 3D: ${tool('save_file')} speichert Dateien, auch 3D-Modelle (.obj, .stl, .ply, .gltf), die die App interaktiv zeigt.` +
      (c.workflows3d.length > 0
        ? ` Echte 3D-Modelle (GLB) mit ${tool('generate_3d_model')} über ComfyUI (${c.workflows3d.join(', ')}).`
        : ' generate_3d_model gibt es, sobald ein ComfyUI-3D-Workflow importiert ist.'),
    `- Office: ${tool('read_document')} liest Word/Excel/PowerPoint, ${tool('create_word_document')}, ` +
      `${tool('create_spreadsheet')} und ${tool('create_presentation')} erstellen echte .docx/.xlsx/.pptx. ` +
      'Angehängte Office-Dateien bekommst du schon als Markdown.',
    `- ${on(c.ocr.enabled, `Handschrift/Scans lokal lesen mit ${tool('read_handwriting')} (Ollama, ${c.ocr.model})`, 'Einstellungen → Handschrift-Erkennung → Modell herunterladen')}`,
    c.skills.length > 0 ? `- Skills (Werkzeug Skill): ${c.skills.join(', ')}.` : null,
    c.mcpServers.length > 0 ? `- Zusätzliche MCP-Server: ${c.mcpServers.join(', ')}.` : null,
    c.plugins > 0 ? `- ${c.plugins} Plugin(s) installiert.` : null,
    c.mode === 'code'
      ? '- Coding: Dateien lesen/ändern, Befehle ausführen (mit Freigaben des Nutzers), Git.'
      : null,
    '',
    '### Weitere App-Funktionen (zum Erklären, keine Werkzeuge)',
    '- Coding: „Projekt öffnen (Coding)“ startet einen Agenten mit Dateizugriff, Terminal, Git und Freigabe-Modi.',
    '- Modell- und Effort-Auswahl oben im Chat; Kontext-Anzeige zeigt, wie voll das Kontextfenster ist.',
    '- „Verbrauch“ (Diagramm-Symbol links): Tokens, Cache und Kosten je Anbieter/Modell, Verlauf pro Stunde/Tag.',
    '- Skills, Plugins und MCP-Server unter „Skills & Add-ons“ (Puzzle-Symbol) installieren.',
    '- Dateien anhängen per Drag & Drop, Strg+V oder 📎; Ergebnisse im Panel „Ergebnisse“; Chats werden gespeichert und sind durchsuchbar/exportierbar.',
    '- Lokale Dienste (Ollama, ComfyUI, auch über Pinokio) findet „Automatisch finden“ in den Einstellungen.',
    '- Dunkel/Hell unten links, Updates unter Einstellungen → Updates.',
    'Wenn etwas nicht aktiv ist, sag dem Nutzer kurz, wo er es einschaltet.',
  ]
  return lines.filter((l) => l !== null).join('\n')
}
