# AI Workbench

Persönliche Windows-Desktop-App für Chat, Coding-Agent, Websuche, Bilder und 3D-Modelle –
mit eigenen API-Keys für **Anthropic**, **OpenRouter** und lokal **Ollama**.
Der Agent-Kern ist das **Claude Agent SDK** (derselbe Kern wie Claude Code).

- Plan: [`docs/PLAN.md`](docs/PLAN.md) · Fortschritt: [`docs/PROGRESS.md`](docs/PROGRESS.md)

## Funktionen

| Bereich              | Was geht                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**             | Anthropic, OpenRouter (alle Modelle) oder Ollama; Live-Modellliste mit Preisen; Streaming; Kosten pro Chat; Chats werden gespeichert, durchsuchbar, als Markdown exportierbar                                   |
| **Dateien senden**   | Drag & Drop, Strg+V (Screenshots), 📎 – Bilder, PDFs, Code/Text, beliebige Dateien                                                                                                                              |
| **Coding-Agent**     | „Projekt öffnen“: Der Agent liest/ändert Dateien und führt Befehle aus – mit Freigaben (Erlauben / Immer / Ablehnen) und vier Modi; Diffs, Dateibaum, Git, Terminal; gefährliche Befehle werden immer blockiert |
| **Internet**         | Websuche (DuckDuckGo/Bing) und Seiten lesen im eingebauten Chromium – kostenlos, ohne Key, ohne Server                                                                                                          |
| **Bilder & 3D**      | Bilder erzeugen/bearbeiten über OpenRouter-Bildmodelle; 3D-Modelle (OBJ/STL/PLY/glTF/GLB) erzeugen und interaktiv ansehen                                                                                       |
| **Skills & Add-ons** | Skills und Plugins aus GitHub (z. B. `anthropics/skills`) oder lokalen Ordnern; MCP-Server aus der offiziellen Registry oder manuell                                                                            |
| **Sicherheit**       | Keys verschlüsselt (Windows DPAPI), Sandbox-Renderer, Dateizugriff nur auf App-Daten und geöffnete Projekte, Kostenlimit pro Anfrage                                                                            |

## Installation (Windows)

**Einfach:** Unter GitHub → _Actions_ → letzter „CI“-Lauf → Artefakt `ai-workbench-windows`
herunterladen und `AI Workbench Setup <version>.exe` ausführen. (Ohne Code-Signatur zeigt
Windows SmartScreen eine Warnung → „Weitere Informationen“ → „Trotzdem ausführen“.)

**Releases & Auto-Update:** Version in `package.json` erhöhen, Tag pushen
(`git tag v0.2.0 && git push --tags`). GitHub baut den Installer und veröffentlicht ihn als
Release; die installierte App aktualisiert sich daraus automatisch (Einstellungen → Updates).
Bei einem privaten Repository funktioniert das automatische Update nicht – dann den Installer
manuell aus dem Release laden.

## Erste Schritte

1. **Einstellungen** (Zahnrad, `Strg+,`): API-Key für Anthropic und/oder OpenRouter speichern →
   „Verbindung testen“. Provider wählen und Modell aus der Liste aussuchen.
2. **Chat:** `Strg+N` neuer Chat. Dateien hineinziehen oder einfügen.
3. **Coding:** „Projekt öffnen (Coding)“ (`Strg+Umschalt+O`) → Ordner wählen → Aufgabe
   beschreiben. Oben im Chat den Freigabe-Modus wählen; rechts Dateien, Git und Terminal.
4. **Bilder/3D:** z. B. „Erzeuge ein Bild von …“ oder „Baue ein 3D-Modell eines Hauses“ –
   Ergebnisse erscheinen im Chat und im Panel „Ergebnisse“.
5. **Add-ons** (Puzzle-Symbol): Unter „Entdecken“ `anthropics/skills` eingeben oder die
   MCP-Registry durchsuchen.

Ollama: Ollama ≥ 0.14 installieren, Modell laden (`ollama pull qwen3:8b`), in den Einstellungen
Provider „Ollama“ und das Modell wählen. Für Werkzeug-Nutzung sind Claude-Modelle am
zuverlässigsten.

## Entwicklung

Voraussetzungen: Node.js ≥ 22.18, Git.

```powershell
npm install
npm run dev        # App mit Hot-Reload
npm run check      # Typecheck + Lint + Tests + Build + Smoke-Test
npm run dist:win   # Installer nach release/<version>/
```

Der Smoke-Test startet die echte App unsichtbar und spielt Chat, Coding (mit Freigabe),
Medien/3D und den Chromium-Loader gegen einen lokalen Mock-Server durch – ohne API-Keys.
Optional: `AIW_LIVE_WEB=1 npx vitest run tests/web.test.ts` testet die echte Websuche.

## Datenablage

`%APPDATA%\AI Workbench\`: `workbench.db` (Chats), `settings.json`, `secrets.json`
(verschlüsselt), `chats\<id>\` (Anhänge und Ergebnisse), `agent-config\skills\` (Skills),
`addons\` (Plugins, MCP-Konfiguration). Bei Coding-Projekten landen erzeugte Medien in
`<Projekt>\ai-output\`.
