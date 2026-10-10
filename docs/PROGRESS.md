# AI Workbench – Fortschritt

Laufendes Protokoll zur Umsetzung von [`PLAN.md`](./PLAN.md).
Zeiten in UTC. Legende: ✅ fertig · 🔄 in Arbeit · ⏳ offen · ⚠️ Problem/Hinweis

**Letztes Update:** 2026-10-10 09:49

## Gesamtstatus

| Phase | Inhalt                     | Status | Fortschritt |
| ----- | -------------------------- | ------ | ----------- |
| 0     | Fundament & Spike          | ✅     | 100 %       |
| 1     | Chat mit allen Providern   | ✅     | 100 %       |
| 2     | Coding-Agent               | 🔄     | 0 %         |
| 3     | Internet                   | ⏳     | 0 %         |
| 4     | Medien: Bilder & 3D        | ⏳     | 0 %         |
| 5     | Skills & Add-ons           | ⏳     | 0 %         |
| 6     | Feinschliff & Distribution | ⏳     | 0 %         |

**Gesamt: ~29 %** (2 von 7 Phasen)

## Teststand

Befehl: `npm run check` (Typecheck → Lint → Unit-/Integrationstests → Build → Smoke-Test)

| Prüfung                                                                        | Ergebnis     |
| ------------------------------------------------------------------------------ | ------------ |
| TypeScript strict (main, preload, renderer, tests)                             | ✅           |
| ESLint (typescript-eslint strict, React-Hooks)                                 | ✅           |
| Unit-Tests (Provider, Settings, Secrets, Normalisierung, Modelle, DB, Dateien) | ✅ 43/43     |
| Integration: echter Runtime ↔ Mock-API (Streaming, Bilder, Fortsetzen)         | ✅ 4/4       |
| Build (electron-vite)                                                          | ✅           |
| Smoke-Test App (UI, IPC, Anhang → API, Speicherung, Datei-Schutz)              | ✅           |
| Smoke-Test gepackte App                                                        | ✅ Linux     |
| Windows: Tests + Installer + Smoke-Test der installierten App (GitHub CI)      | ✅ (Phase 0) |

## Protokoll

### 2026-10-10 09:49 – Phase 1 abgeschlossen ✅

- **Modellauswahl live:** Modelllisten werden direkt von Anthropic, OpenRouter und Ollama
  geladen (durchsuchbar, mit Kontextlänge, Preis pro 1M Tokens und Bild-Fähigkeit). Eigene
  Modell-IDs sind weiterhin möglich. Button „Verbindung testen“ in den Einstellungen.
  _(Umgesetzt von einem Sonnet-Subagent, 13 Tests.)_
- **Chats werden gespeichert:** SQLite über das in Electron eingebaute `node:sqlite`
  (keine nativen Module, keine Build-Tools auf Windows nötig). Chat-Liste mit Umbenennen und
  Löschen, Gesamtkosten pro Chat. Unterhaltungen lassen sich auch nach einem Neustart fortsetzen.
- **Dateien senden:** Drag & Drop, Strg+V (Screenshots) und 📎-Dateiauswahl.
  - Bilder → Bild-Block, PDFs → Dokument-Block (bei Ollama als Dateipfad), Code/Text → inline.
  - Andere Dateien werden im Chat-Ordner abgelegt und dem Agenten per Pfad genannt.
  - Größenlimits werden vorher geprüft; Vorschau-Chips mit Bild-Thumbnails.
- **Sicherheit:** Eigenes `aiw-file://`-Protokoll liefert nur Dateien aus dem App-Datenordner
  (alles andere → 403). Anhänge außerhalb des Chat-Ordners werden ignoriert.
- **Darstellung:** Syntax-Highlighting in Code-Blöcken, Tabellen, Überschriften.
- **Getestet:**
  - Ein Bild kommt wirklich bei der API an und bleibt beim Fortsetzen im Verlauf erhalten.
  - Ein zweites Senden während einer laufenden Antwort wird abgelehnt.
  - Fehlende Keys werden als Fehler gespeichert.
  - Der Screenshot der App wurde geprüft.
- **Behoben:** Die Chat-Liste aktualisierte sich nicht, wenn ein anderer Chat im Hintergrund fertig wurde.
- ⚠️ Der Runtime schickt eine eigene Umgebungs-Nachricht mit. Das hat keine Auswirkung, ist
  aber in den Tests berücksichtigt.

### 2026-10-10 09:38 – Phase 0 abgeschlossen ✅

- **Projekt-Setup:** Electron 44 + electron-vite 5 + React 19 + Tailwind 4, TypeScript 6 strict
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint, Prettier, Vitest.
- **Typsichere IPC:** gemeinsamer Vertrag in `src/shared/ipc.ts` (Zod-Schemas). Eingaben werden im
  Main-Prozess validiert, der Renderer bekommt automatisch typisierte `invoke`/`on`-Funktionen.
  _(Statt tRPC eine eigene, schlanke Lösung – weniger Abhängigkeiten, gleiche Typsicherheit.)_
- **Sicherheit:** `contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP, externe Links im
  Browser. API-Keys verschlüsselt per `safeStorage` (DPAPI), Renderer sieht nur „Key vorhanden“.
- **Agent-Kern:** Claude Agent SDK 0.3.296 eingebettet. Provider-Umschaltung (Anthropic /
  OpenRouter / Ollama) über Umgebungsvariablen; geerbte `ANTHROPIC_*`-Variablen werden entfernt,
  eigener Config-Ordner (berührt nie dein `~/.claude`), Telemetrie aus.
- **UI:** Chat mit Streaming, Markdown, Abbrechen, Kosten/Dauer; Einstellungen für Keys, Modelle,
  Ollama-URL, Theme.
- **Spike erfolgreich:** Der native Claude-Code-Runtime läuft aus der gepackten App
  (`app.asar.unpacked`). Größtes technisches Risiko aus dem Plan ist damit geklärt.
- **CI:** `.github/workflows/ci.yml` baut auf `windows-latest`, testet und erzeugt den
  NSIS-Installer als Artefakt.
- ⚠️ Electron-Download über npm brach im Container ab → Binary manuell geladen und per SHA256
  verifiziert. Betrifft nur diese Umgebung, nicht deinen PC.
- ⚠️ Im Linux-Container gibt es keinen Schlüsselbund → Keys speichern dort nicht möglich
  (erwartet). Unter Windows ist DPAPI immer verfügbar.

### 2026-10-10 09:27 – Start Phase 0

- Fortschrittsdatei angelegt.
- Umgebung geprüft: Node 22.22, npm 10.9, Electron 44.7 und Claude Agent SDK 0.3.296 verfügbar.
