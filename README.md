# AI Workbench

Persönliche Windows-Desktop-App für Chat, Coding-Agent, Websuche, Bilder und 3D-Modelle –
mit eigenen API-Keys für **Anthropic**, **OpenRouter** und lokal **Ollama**.
Der Agent-Kern ist das **Claude Agent SDK** (derselbe Kern wie Claude Code).

- Plan: [`docs/PLAN.md`](docs/PLAN.md) · Fortschritt: [`docs/PROGRESS.md`](docs/PROGRESS.md)

## Funktionen

| Bereich              | Was geht                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**             | Anthropic, OpenRouter (alle Modelle) oder Ollama; Live-Modellliste mit Preisen; Streaming; Kosten pro Chat; Chats werden gespeichert, durchsuchbar, als Markdown exportierbar                                                                     |
| **Dateien senden**   | Drag & Drop, Strg+V (Screenshots), 📎 – Bilder, PDFs, Code/Text, beliebige Dateien                                                                                                                                                                |
| **Coding-Agent**     | „Projekt öffnen“: Der Agent liest/ändert Dateien und führt Befehle aus – mit Freigaben (Erlauben / Immer / Ablehnen) und vier Modi; Diffs, Dateibaum, Git, Terminal; gefährliche Befehle werden immer blockiert                                   |
| **Cowork**           | Jev (TypeSafe) wählt pro Anfrage die passende Rolle (Modell + Effort); Subagents mit eigenem Modell übernehmen Teilaufgaben parallel; Verbrauch je Agent in der Statistik                                                                         |
| **Terminal**         | Echtes Terminal (PowerShell/Bash) als eigene Ansicht und im Projekt-Panel; „Claude Code starten“ nutzt Provider, Modell und Skills der App; Verbrauch in der Statistik                                                                            |
| **Internet**         | Websuche (DuckDuckGo/Bing) und Seiten lesen im eingebauten Chromium – kostenlos, ohne Key, ohne Server                                                                                                                                            |
| **Bilder & 3D**      | Bilder erzeugen/bearbeiten über OpenRouter **oder lokal mit ComfyUI** (kostenlos); echte 3D-Modelle (GLB) über ComfyUI-Workflows wie Hunyuan3D oder vom Agenten als OBJ/STL/PLY/glTF geschrieben; interaktiver 3D-Viewer, PDF-Vorschau in der App |
| **Office**           | Word, Excel, PowerPoint (auch .doc/.xls/.odt/.ods/.rtf/.csv) lesen, in der App ansehen und vom Agenten neu erstellen lassen – ohne Office-Installation                                                                                            |
| **Handschrift**      | Handschrift und Scans lokal in Text umwandeln (Ollama-Vision-Modell, z. B. auf einer RTX 4060); das Modell belegt die Grafikkarte nur während der Erkennung                                                                                       |
| **Skills & Add-ons** | Skills und Plugins aus GitHub (z. B. `anthropics/skills`) oder lokalen Ordnern; MCP-Server aus der offiziellen Registry oder manuell                                                                                                              |
| **Jev (TypeSafe)**   | Typsichere Entscheidungen (Auswahl, Bewertung, Ja/Nein mit Wahrscheinlichkeiten) als Werkzeug für jedes aktive Modell – mit TypeSafe-Key oder über OpenRouter                                                                                     |
| **Verbrauch**        | Statistik je Anbieter und Modell: Tokens (inkl. Cache), Kosten, Anfragen; Verlauf pro Stunde/Tag; Kontext-Anzeige im Chat                                                                                                                         |
| **Sicherheit**       | Keys verschlüsselt (Windows DPAPI), Sandbox-Renderer, Dateizugriff nur auf App-Daten und geöffnete Projekte, Kostenlimit pro Anfrage                                                                                                              |

## Installation (Windows)

**Einfach:** Unter GitHub → _Actions_ → letzter „CI“-Lauf → Artefakt `ai-workbench-windows`
herunterladen und `AI-Workbench-Setup-<version>.exe` ausführen. (Ohne Code-Signatur zeigt
Windows SmartScreen eine Warnung → „Weitere Informationen“ → „Trotzdem ausführen“.)

**Releases & Auto-Update:** Version in `package.json` erhöhen und nach `main` pushen. GitHub
baut den Installer und veröffentlicht ihn als Release `v<version>`. Die installierte App
aktualisiert sich daraus automatisch (Einstellungen → Updates). Neueste Version zum
Herunterladen: GitHub → _Releases_.
Bei einem privaten Repository funktioniert das automatische Update nicht – dann den Installer
manuell aus dem Release laden.

## Erste Schritte

1. **Einstellungen** (Zahnrad, `Strg+,`): API-Key für Anthropic und/oder OpenRouter speichern →
   „Verbindung testen“. Provider wählen und Modell aus der Liste aussuchen.
2. **Chat:** `Strg+N` neuer Chat. Dateien hineinziehen oder einfügen.
3. **Coding:** „Projekt öffnen (Coding)“ (`Strg+Umschalt+O`) → Ordner wählen → Aufgabe
   beschreiben. Oben im Chat den Freigabe-Modus wählen; rechts Dateien, Git und Terminal.
4. **Terminal** (Symbol unter Chat): Shell im Home-Ordner oder über „Ordner wählen …“; „Claude
   Code starten“ tippt `claude` ein. `claude` nutzt Provider, Modell und Skills der App.
5. **Bilder/3D:** z. B. „Erzeuge ein Bild von …“ oder „Baue ein 3D-Modell eines Hauses“ –
   Ergebnisse erscheinen im Chat und im Panel „Ergebnisse“.
6. **Add-ons** (Puzzle-Symbol): Unter „Entdecken“ `anthropics/skills` eingeben oder die
   MCP-Registry durchsuchen.

**Lokale Bilder & 3D mit ComfyUI:** [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
installieren und starten (Port 8188), ein Checkpoint-Modell laden. In den Einstellungen unter
„Bild- und 3D-Generierung“ auf „ComfyUI (lokal)“ stellen und „Verbindung testen“. Eigene
Workflows: in ComfyUI „Workflow → Export (API)“, im Prompt-Feld `{{prompt}}` eintragen
(optional `{{input_image}}`, `{{seed}}`, `{{negative}}`) und als Bild- oder 3D-Workflow
importieren. Ein 3D-Workflow (z. B. Hunyuan3D mit „Save GLB“) wird dem Agenten automatisch als
Werkzeug angeboten.

**Handschrift-Erkennung:** Ollama installieren und starten (direkt oder über Pinokio).
Einstellungen → „Handschrift-Erkennung“ → Modell wählen (Qwen3-VL 8B passt in 8 GB VRAM) →
„Herunterladen“. Danach in jeder Bildvorschau „Text erkennen“ oder im Chat z. B. „Was steht auf
dem Zettel?“. Das Modell wird nach der eingestellten Zeit wieder aus der Grafikkarte entladen.

**Pinokio:** Ollama und ComfyUI in Pinokio starten, dann Einstellungen → „Lokale KI-Dienste“ →
„Automatisch finden“ → „Verwenden“. Die App findet die von Pinokio vergebenen Ports selbst.

**Office:** Word-, Excel- oder PowerPoint-Dateien einfach anhängen; die KI bekommt den Inhalt
als Text. Neue Dateien z. B. mit „Erstelle daraus eine Excel-Tabelle mit Summen“.

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
