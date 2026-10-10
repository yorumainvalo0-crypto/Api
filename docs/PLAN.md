# AI Workbench – Projektplan

Persönliche Windows-Desktop-App für KI-gestütztes Coding, Chat, Websuche und Medien
(Bilder, 3D-Modelle) – mit Anthropic, OpenRouter und (gelegentlich) Ollama.

> Status: Planung · Zielplattform: Windows 10/11 x64 · Nutzung: nur privat

---

## 1. Ziele & Nicht-Ziele

**Ziele**
- Eigene API-Keys nutzen: **Anthropic**, **OpenRouter**, optional **Ollama** (lokal).
- **Echter Coding-Agent** wie Claude Code: Dateien lesen/schreiben, Terminal, Git, Diffs, Rückfragen vor riskanten Aktionen.
- **Internetzugriff** (Suche + Seiten lesen) – **kostenlos, ohne eigenen Server, ohne API-Key**.
- **Dateien senden**: Bilder, PDFs, Code/Text per Drag & Drop oder Einfügen.
- **Dateien empfangen**: generierte Bilder, 3D-Modelle (GLB/GLTF/OBJ/STL), Code-Dateien – mit Vorschau in der App.
- **Skills & Add-ons** (MCP-Server, Agent-Skills, Plugins) aus der App heraus installieren.
- **Durchgehend typsicher** (TypeScript strict + Zod an jeder Grenze).
- Echte Windows-App mit Installer.

**Nicht-Ziele (vorerst)**
- Multi-User, Cloud-Sync, Verkauf/Verteilung, Code-Signing-Zertifikat, macOS/Linux-Builds.

---

## 2. Architektur-Entscheidungen (mit Begründung)

| Thema | Entscheidung | Warum |
|---|---|---|
| App-Framework | **Electron** + **electron-vite** | Der Agent-Kern (Claude Agent SDK) ist ein Node/TypeScript-Paket. Electron hat Node eingebaut → kein Sidecar-Prozess, eine Sprache überall. Tauri wäre kleiner, aber das Einbetten wäre umständlicher. Die Größe (~150 MB) ist für eine private App egal. |
| UI | **React 19 + TypeScript + Tailwind + shadcn/ui** | Schnell zu bauen, gute Komponenten (Dialoge, Tabs, Command-Palette). |
| Agent-Kern | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | Derselbe Kern wie Claude Code: Tool-Loop, Datei-/Bash-/Edit-Tools, Permissions, Subagents, Skills, MCP, Kontext-Kompaktierung. Das selbst nachzubauen würde Monate kosten. |
| Provider-Umschaltung | Über **Base-URL + Token pro Session** | Anthropic direkt; OpenRouter bietet einen Anthropic-kompatiblen Endpunkt (`https://openrouter.ai/api`); Ollama ab v0.14 ebenfalls (`http://localhost:11434`). Ein Agent-Kern für alle drei. |
| Bildgenerierung | **OpenRouter Chat Completions mit `modalities: ["image","text"]`** als eigenes Tool | Anthropic-Modelle erzeugen keine Bilder; über OpenRouter gehen Gemini-Image, Flux usw. mit demselben Key. |
| Typsicherheit | **Zod** für Settings, IPC, Tool-Schemas, DB; **tRPC über IPC** (`electron-trpc`) | Main↔Renderer-Kommunikation komplett typisiert; Fehler fallen beim Kompilieren auf. |
| Speicher | **SQLite** (`better-sqlite3`) + **Drizzle ORM** | Lokal, schnell, typisierte Queries; Chats/Projekte/Add-on-Registry. |
| Secrets | **Electron `safeStorage`** (Windows DPAPI) | API-Keys verschlüsselt an das Windows-Benutzerkonto gebunden, nie im Klartext auf der Platte. |
| Websuche | **Eigene MCP-Tools** `web_search` + `web_fetch` über ein **verstecktes Chromium-Fenster** | Kostenlos, kein Key, kein Server. Die eingebaute `WebSearch` des SDK wird deaktiviert (kostenpflichtig und nur mit Anthropic direkt). |
| 3D-Vorschau | **three.js** via `@react-three/fiber` + `drei` | Lädt GLB/GLTF/OBJ/STL/PLY direkt im Renderer. |
| Installer | **electron-builder (NSIS)** + `electron-updater` über GitHub Releases | Klassischer Windows-Installer, Startmenü-Eintrag, Auto-Update aus dem eigenen Repo. |

### Hintergrund: Wie das Claude Agent SDK eingebettet wird
- Das SDK startet intern den Claude-Code-Runtime-Prozess und streamt Nachrichten (`query()` liefert einen Async-Iterator).
- In Electron läuft das im **Main-Prozess** (bzw. einem `utilityProcess`), **nie im Renderer** → Keys und Dateisystemzugriff bleiben vom UI getrennt.
- Pro Chat-Session werden die Umgebungsvariablen gesetzt:
  - Anthropic: `ANTHROPIC_API_KEY=<key>`
  - OpenRouter: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<or-key>`, `ANTHROPIC_API_KEY=""` (muss explizit leer sein)
  - Ollama: `ANTHROPIC_BASE_URL=http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama` (Kontext ≥ 32k empfohlen)
- Eigene Tools (Websuche, Bildgenerierung, 3D) werden als **In-Process-MCP-Server** (`createSdkMcpServer` + `tool()` mit Zod-Schema) registriert.
- Permissions: `canUseTool`-Callback → UI-Dialog „Erlauben / Immer erlauben / Ablehnen“ (wie Claude Code).
- **Wichtig:** Nur API-Keys verwenden, kein Claude.ai-Abo-Login – das ist für Drittanwendungen nicht vorgesehen.
- **Risiko:** Das Packaging des SDK-Runtimes in Electron (asar-Unpack, Node-Binary/`ELECTRON_RUN_AS_NODE`) wird in Phase 0 per Spike geprüft.

---

## 3. Funktionsumfang im Detail

### 3.1 Provider & Modelle
- Einstellungen: Key je Provider, „Verbindung testen“-Button.
- **Modelllisten dynamisch** laden (nicht hartcodieren):
  - Anthropic `GET /v1/models`
  - OpenRouter `GET /api/v1/models` (inkl. Filter nach Input/Output-Modalitäten, Preis, Kontextlänge)
  - Ollama `GET /api/tags`
- Pro Chat wählbar: Provider + Modell; Favoriten-Liste.
- Kostenanzeige pro Nachricht/Session (Token-Usage aus der SDK-Antwort × Preis aus Modellliste).

### 3.2 Modi
1. **Chat** – normales Gespräch, Dateien anhängen, Websuche optional.
2. **Code** – an einen Projektordner gebunden; Agent darf lesen/schreiben/Befehle ausführen (mit Freigaben). Diff-Ansicht, integriertes Terminal (xterm.js + node-pty), Git-Status.
3. **Media** – Bildgenerierung/-bearbeitung und 3D-Erstellung mit Galerie.

(Technisch sind alle drei derselbe Agent mit unterschiedlichen Tool-Sets und System-Prompts.)

### 3.3 Dateien senden
| Typ | Behandlung |
|---|---|
| Bilder (PNG/JPG/WEBP/GIF) | Base64-Image-Block an das Modell; bei Ollama nur mit Vision-Modell (UI warnt) |
| PDF | Document-Block (Anthropic/OpenRouter); Fallback: Text-Extraktion mit `pdfjs-dist` |
| Code/Text | Inline als Text, bei großen Dateien → in Workspace kopiert, Agent liest per `Read`-Tool |
| 3D-Modelle | Datei in Workspace + Metadaten (Vertices, Bounding Box) als Text; optional gerendertes Vorschaubild als Image-Block |
| Sonstige | In Workspace abgelegt, Pfad wird dem Agent mitgeteilt |

UI: Drag & Drop, Strg+V (Screenshots), Büroklammer-Button; Vorschau-Chips vor dem Senden; Größenlimits werden vorher geprüft.

### 3.4 Dateien empfangen
- Jede Session hat einen **Workspace-Ordner** (`%USERPROFILE%\AIWorkbench\sessions\<id>\` bzw. das Projekt im Code-Modus).
- Ein **File-Watcher** (`chokidar`) erkennt neue/geänderte Dateien → erscheinen im **Artefakt-Panel** rechts:
  - Bilder → Viewer mit Zoom, „Speichern unter“, „Als Input weiterverwenden“
  - 3D (GLB/GLTF/OBJ/STL/PLY) → three.js-Viewer mit Orbit, Wireframe, Export
  - Code/Markdown → Monaco-Editor (read-only oder editierbar), HTML → sandboxed Vorschau
  - PDF → pdf.js-Viewer
- Eigene Tools:
  - `generate_image(prompt, model?, size?, input_images?)` → OpenRouter-Bildmodell → PNG in Workspace.
  - `create_3d_model(...)`: Der Agent erzeugt 3D **per Code** (kostenlos): three.js-Skript → GLB-Export, oder OpenSCAD → STL (OpenSCAD optional lokal installiert). Ergebnis landet im Workspace.
  - Später optional: Bild→3D über lokale Modelle (z. B. via ComfyUI) oder bezahlte Dienste – nur wenn gewünscht.

### 3.5 Internet (kostenlos, lokal)
- **`web_search(query, max_results)`**: Ein unsichtbares Electron-`BrowserWindow` (eigene Session-Partition, keine Cookies vom Nutzer) lädt die DuckDuckGo-HTML-Suche und extrahiert Titel/URL/Snippet. Fallback-Kette: DuckDuckGo → Bing → Wikipedia-API. Rate-Limit + Cache (SQLite) gegen Sperren.
- **`web_fetch(url)`**: Seite im versteckten Chromium rendern (funktioniert auch bei JS-lastigen Seiten), Inhalt mit `@mozilla/readability` extrahieren, mit `turndown` zu Markdown, auf N Tokens kürzen.
- Quellen werden im Chat als anklickbare Links angezeigt.
- Kein eigener Server, kein Key, keine Kosten. Einschränkung: Scraping kann bei sehr vielen Anfragen gedrosselt werden → Cache + Pausen.

### 3.6 Skills, Plugins & Add-ons
- **MCP-Server**: Konfiguration pro Server (stdio-Befehl oder HTTP-URL), an-/abschaltbar, wird an `query({ mcpServers })` übergeben.
- **Agent-Skills** (`SKILL.md`-Ordner) und **Plugins**: abgelegt unter `%APPDATA%\AIWorkbench\addons\`, über die SDK-Optionen (Skills-Verzeichnisse / `plugins`) geladen.
- **Add-on-Browser** in der App:
  - Quelle 1: offizielle **MCP-Registry** (`registry.modelcontextprotocol.io`) – kostenlos, durchsuchbar.
  - Quelle 2: **GitHub-Repos** (z. B. `anthropics/skills` oder beliebige URL) → Download als ZIP, Manifest prüfen, installieren.
  - Quelle 3: lokaler Ordner importieren.
- Jedes Add-on hat ein Zod-validiertes Manifest; vor der Installation werden die angeforderten Rechte/Befehle angezeigt (Sicherheit: fremder Code läuft lokal!).
- Updates: Versionsvergleich gegen die Quelle, „Alle aktualisieren“.

### 3.7 Typsicherheit (Konzept)
- `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- `src/shared/schemas/*` = **Single Source of Truth** (Zod) für: Settings, Provider-Configs, Nachrichten, Attachments, Add-on-Manifeste, Tool-Inputs/Outputs.
- IPC ausschließlich über tRPC-Router → Renderer bekommt automatisch typisierte Clients.
- Strukturierte Ausgaben: Für interne Aufgaben (z. B. Chat-Titel, Add-on-Analyse) wird ein Zod-Schema an das Modell gegeben und die Antwort validiert.
- ESLint (typescript-eslint strict) + Prettier + Vitest; CI-Typecheck auf GitHub Actions.

### 3.8 Sicherheit
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` im Renderer; nur das tRPC-Preload-API ist exponiert.
- Keys nur im Main-Prozess, verschlüsselt per `safeStorage`.
- Agent-Rechte pro Projekt: „Nur lesen“, „Bearbeiten mit Freigabe“, „Auto“ (wie Claude-Code-Permission-Modi); gefährliche Befehle (z. B. `rm -rf`, `format`) immer mit Rückfrage.
- Web-Fetch in isolierter Session-Partition, Downloads blockiert.
- Generiertes HTML nur in sandboxed `<iframe>` ohne Node-Zugriff.

---

## 4. Projektstruktur

```
ai-workbench/
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ package.json
├─ src/
│  ├─ main/                    # Electron main process (Node)
│  │  ├─ index.ts              # App lifecycle, windows
│  │  ├─ ipc/router.ts         # tRPC router (typed API for renderer)
│  │  ├─ agent/
│  │  │  ├─ session.ts         # Wraps Claude Agent SDK query() per chat
│  │  │  ├─ providers.ts       # Env/base-URL mapping per provider
│  │  │  └─ permissions.ts     # canUseTool -> UI approval flow
│  │  ├─ tools/                # In-process MCP tools
│  │  │  ├─ web-search.ts
│  │  │  ├─ web-fetch.ts
│  │  │  ├─ generate-image.ts
│  │  │  └─ create-3d.ts
│  │  ├─ addons/               # Registry client, installer, manifest validation
│  │  ├─ storage/              # Drizzle schema, migrations, secrets (safeStorage)
│  │  └─ workspace/            # File watcher, attachment handling
│  ├─ preload/index.ts         # Exposes tRPC IPC link only
│  ├─ renderer/                # React UI
│  │  ├─ features/chat/
│  │  ├─ features/code/        # Diff view, terminal, file tree
│  │  ├─ features/media/       # Image gallery, 3D viewer
│  │  ├─ features/addons/
│  │  └─ features/settings/
│  └─ shared/
│     ├─ schemas/              # Zod schemas (single source of truth)
│     └─ types.ts
└─ docs/
   └─ PLAN.md
```

---

## 5. Phasen & Meilensteine

Jede Phase endet mit einer lauffähigen, installierbaren Version.

### Phase 0 – Fundament & Spike (≈ 2–3 Tage)
- Projekt-Setup: electron-vite, React, Tailwind, shadcn, ESLint/Prettier, Vitest.
- **Spike:** Claude Agent SDK im Electron-Main starten, eine Anfrage streamen, mit electron-builder als `.exe` packen und auf Windows testen. *(größtes technisches Risiko → zuerst klären)*
- tRPC-über-IPC, `safeStorage`-Secrets, Settings-Seite mit Key-Eingabe.
- **Ergebnis:** Installierbare App, die mit Anthropic-Key eine Streaming-Antwort zeigt.

### Phase 1 – Chat mit allen Providern (≈ 1 Woche)
- Provider-Umschaltung (Anthropic / OpenRouter / Ollama), dynamische Modelllisten.
- Chat-UI: Markdown, Code-Highlighting, Streaming, Abbrechen, Verlauf in SQLite, Session-Liste.
- **Dateien senden:** Bilder, PDFs, Text (Drag & Drop, Einfügen).
- Kosten-/Token-Anzeige.
- **Ergebnis:** Vollwertiger Multi-Provider-Chat mit Anhängen.

### Phase 2 – Coding-Agent (≈ 1–2 Wochen)
- Projektordner öffnen, Code-Modus mit SDK-Tools (Read/Write/Edit/Bash/Glob/Grep).
- Permission-Dialoge + Permission-Modi.
- Datei-Baum, Monaco-Diff-Ansicht für Änderungen, integriertes Terminal (xterm.js + node-pty), Git-Status/Commit.
- `CLAUDE.md`-Unterstützung pro Projekt.
- **Ergebnis:** „Claude Code mit GUI“.

### Phase 3 – Internet (≈ 3–4 Tage)
- `web_search` + `web_fetch` als MCP-Tools (verstecktes Chromium, Readability, Markdown).
- Cache, Rate-Limit, Fallback-Kette, Quellenanzeige im Chat.
- **Ergebnis:** Agent kann kostenlos im Netz recherchieren.

### Phase 4 – Medien: Bilder & 3D (≈ 1 Woche)
- Artefakt-Panel mit File-Watcher.
- `generate_image` über OpenRouter-Bildmodelle (inkl. Bildbearbeitung mit Eingabebild).
- 3D-Viewer (GLB/GLTF/OBJ/STL/PLY); `create_3d_model` per three.js-Skript/OpenSCAD.
- Galerie, „Speichern unter“, „Als Input verwenden“.
- **Ergebnis:** Bilder & 3D-Modelle senden und empfangen.

### Phase 5 – Skills & Add-ons (≈ 1 Woche)
- MCP-Server-Verwaltung (hinzufügen, testen, an/aus).
- Add-on-Browser: MCP-Registry + GitHub-Quellen, Installation, Updates, Deinstallation.
- Skills/Plugins-Ordner an das SDK anbinden.
- **Ergebnis:** Erweiterbar wie Claude Code.

### Phase 6 – Feinschliff & Distribution (≈ 3–4 Tage)
- NSIS-Installer, Auto-Update über GitHub Releases (privates Repo → Token im Updater oder manuell).
- Tastenkürzel, Command-Palette (Strg+K), Dark/Light-Theme, Tray-Icon.
- Logging (`electron-log`), Crash-Handling, Backup/Export von Chats.

**Gesamtaufwand grob: 5–7 Wochen** (bei Umsetzung mit KI-Unterstützung eher schneller).

---

## 6. Risiken & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| SDK-Runtime lässt sich schwer in Electron packen | Spike in Phase 0; Fallback: Node-Binary mitliefern bzw. `ELECTRON_RUN_AS_NODE` |
| Nicht-Claude-Modelle über OpenRouter/Ollama sind beim Tool-Calling schwächer | Für Coding Claude-Modelle empfehlen; UI-Hinweis bei schwachen Modellen |
| DuckDuckGo/Bing drosseln Scraping | Cache, Pausen, Fallback-Kette; optional später SearXNG lokal |
| Add-ons führen fremden Code aus | Manifest + Rechteanzeige vor Installation, nur vertrauenswürdige Quellen, Deaktivieren per Klick |
| API-Kosten laufen aus dem Ruder | Kostenanzeige, optionales Budget-Limit pro Session/Tag |
| Windows Defender/SmartScreen warnt (kein Code-Signing) | Für private Nutzung akzeptabel („Trotzdem ausführen“) |

---

## 7. Voraussetzungen auf dem Windows-PC
- Node.js 22 LTS, Git, Visual Studio Build Tools (für native Module wie `node-pty`, `better-sqlite3`).
- Optional: Ollama ≥ 0.14, OpenSCAD (für STL-Erzeugung).
- API-Keys: Anthropic (console.anthropic.com), OpenRouter (openrouter.ai/keys).

---

## 8. Quellen
- Ollama – Anthropic-Kompatibilität: https://docs.ollama.com/api/anthropic-compatibility
- Ollama-Blog „Claude Code with Anthropic API compatibility“: https://registry.ollama.ai/blog/claude
- OpenRouter – Anthropic Agent SDK: https://openrouter.ai/docs/guides/community/anthropic-agent-sdk
- OpenRouter – Claude Code Tutorial: https://openrouter.ai/blog/tutorials/claude-code-openrouter/
- OpenRouter – Image Generation: https://openrouter.ai/docs/features/multimodal/image-generation
