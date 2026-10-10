# AI Workbench – Fortschritt

Laufendes Protokoll zur Umsetzung von [`PLAN.md`](./PLAN.md).
Zeiten in UTC. Legende: ✅ fertig · 🔄 in Arbeit · ⏳ offen · ⚠️ Problem/Hinweis

**Letztes Update:** 2026-10-10 10:06

## Gesamtstatus

| Phase | Inhalt                     | Status | Fortschritt |
| ----- | -------------------------- | ------ | ----------- |
| 0     | Fundament & Spike          | ✅     | 100 %       |
| 1     | Chat mit allen Providern   | ✅     | 100 %       |
| 2     | Coding-Agent               | ✅     | 100 %       |
| 3     | Internet                   | ✅     | 100 %       |
| 4     | Medien: Bilder & 3D        | 🔄     | 0 %         |
| 5     | Skills & Add-ons           | ⏳     | 0 %         |
| 6     | Feinschliff & Distribution | ⏳     | 0 %         |

**Gesamt: ~57 %** (4 von 7 Phasen)

## Teststand

Befehl: `npm run check` (Typecheck → Lint → Tests → Build → Smoke-Test)

| Prüfung                                                                 | Ergebnis           |
| ----------------------------------------------------------------------- | ------------------ |
| TypeScript strict + ESLint                                              | ✅                 |
| Unit-Tests (Provider, Speicher, Dateien, Freigaben, Diff, Web, Projekt) | ✅ 122             |
| Integration mit echtem Claude-Runtime (Chat, Bilder, Coding, Websuche)  | ✅ 9               |
| Live-Test echte Websuche (optional, `AIW_LIVE_WEB=1`)                   | ✅                 |
| Smoke-Test App: Chat + Anhang, Coding mit Freigabe, Chromium-Loader     | ✅                 |
| Windows-CI (Tests, Installer, Smoke-Test der installierten App)         | ⚠️ siehe Protokoll |

## Protokoll

### 2026-10-10 10:06 – Phase 2 und 3 abgeschlossen ✅

**Phase 2 – Coding-Agent**

- **Projekt öffnen (Coding):** Ein Chat wird an einen Ordner gebunden. Der Agent hat dort alle
  Claude-Code-Werkzeuge (Lesen, Schreiben, Bearbeiten, Bash/PowerShell, Suche) und liest die
  `CLAUDE.md` des Projekts.
- **Freigaben wie bei Claude Code:** Karten mit „Erlauben“, „Für diese Sitzung immer erlauben“
  und „Ablehnen“. Vier Modi lassen sich auch während einer laufenden Antwort umschalten:
  „Immer fragen“, „Dateiänderungen erlauben“, „Nur planen“ und „Alles erlauben“.
- **Schutz vor gefährlichen Befehlen:** Blockiert wird auch bei „Alles erlauben“:
  - Löschen von Laufwerk, Home- oder Systemordnern (Linux und Windows)
  - Formatieren
  - Herunterfahren
  - Fork-Bomben
  - Eingriffe in die Registry bzw. den Bootloader
- **Tool-Anzeige:** Jede Aktion erscheint als aufklappbare Karte, für Bearbeitungen mit
  farbigem Diff. Text und Aktionen stehen in der richtigen Reihenfolge und werden mitgespeichert.
- **Projekt-Panel** _(Opus-Subagent)_:
  - Dateibaum mit Syntax-Highlighting
  - Git: Status, Diff, Commit
  - Terminal: xterm.js, PowerShell unter Windows, ohne native Module
  - Pfade außerhalb des Projekts werden abgelehnt
- **Getestet:**
  - Mit echtem Runtime, wobei der Agent wirklich Dateien schreibt:
    - Freigabe führt zur Datei.
    - Ablehnen führt zu keiner Datei.
    - Im Auto-Modus wird nicht gefragt.
    - `rm -rf /` wird blockiert.
  - Dazu 26 Fälle für gefährliche bzw. harmlose Befehle.
  - 25 Tests für das Projekt-Panel inklusive eines echten Git-Repos.

**Phase 3 – Internet (kostenlos, ohne Server, ohne Key)**

- **Werkzeuge** `web_search` und `web_fetch` als eingebauter MCP-Server, in Chat und Coding-Modus.
  Sie brauchen keine Freigabe, weil sie nur lesen.
- **Suchkette:** DuckDuckGo Lite → Bing → DuckDuckGo → Wikipedia. Bot-Abfragen werden erkannt und
  übersprungen. Dazu kommen 15 Minuten Cache und mindestens 1 Sekunde Abstand pro Website.
- **Seiten lesen:** Zuerst schnell per HTTP. Bei JavaScript-Seiten wird im versteckten Chromium
  gerendert, ohne Downloads und ohne Berechtigungen. Readability extrahiert den Hauptinhalt
  als Markdown.
- **Einstellung „Internet“** zum Ein- und Ausschalten.
- **Getestet:**
  - Parser mit echten, mitgeschnittenen Suchseiten
  - Live-Suche im Internet
  - Der Agent nutzt die Suche über den echten Runtime.
  - Chromium rendert eine JavaScript-Seite in der App.

**Behobene Fehler**

- ⚠️ **Einstellungen:** Ein Teil-Update setzte andere Einstellungen auf den Standard zurück,
  z. B. wechselte die Modellwahl unter OpenRouter zurück zu Anthropic. Ist behoben und durch
  einen Regressionstest abgesichert.
- ⚠️ **Windows-CI (Phase 1):** Alle Tests liefen grün, nur das Aufräumen scheiterte, weil
  Windows die offene Datenbankdatei sperrt. Die Tests schließen die Datenbank jetzt vorher.
- **Optik:** Der Platzhalter im Eingabefeld wurde gekürzt (Screenshot geprüft).

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
