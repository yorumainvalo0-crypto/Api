# AI Workbench – Fortschritt

Laufendes Protokoll zur Umsetzung von [`PLAN.md`](./PLAN.md).
Zeiten in UTC. Legende: ✅ fertig · 🔄 in Arbeit · ⏳ offen · ⚠️ Problem/Hinweis

**Letztes Update:** 2026-10-10 13:51

## Gesamtstatus

| Phase | Inhalt                     | Status | Fortschritt |
| ----- | -------------------------- | ------ | ----------- |
| 0     | Fundament & Spike          | ✅     | 100 %       |
| 1     | Chat mit allen Providern   | ✅     | 100 %       |
| 2     | Coding-Agent               | ✅     | 100 %       |
| 3     | Internet                   | ✅     | 100 %       |
| 4     | Medien: Bilder & 3D        | ✅     | 100 %       |
| 5     | Skills & Add-ons           | ✅     | 100 %       |
| 6     | Feinschliff & Distribution | ✅     | 100 %       |

**Gesamt: 100 %** (alle 7 Phasen umgesetzt und getestet)

## Teststand

Befehl: `npm run check` (Typecheck → Lint → Tests → Build → Smoke-Test)

| Prüfung                                                                      | Ergebnis |
| ---------------------------------------------------------------------------- | -------- |
| TypeScript strict + ESLint                                                   | ✅       |
| Unit- und Integrationstests (31 Dateien)                                     | ✅ 254   |
| Integration mit echtem Runtime (Chat, Coding, Web, Medien, Add-ons, ComfyUI) | ✅       |
| Integration: Handschrift-OCR (Ollama) und Office lesen/erstellen             | ✅       |
| Live-Test echte Websuche (optional, `AIW_LIVE_WEB=1`)                        | ✅       |
| Smoke-Test App: Chat, Coding, Medien/3D, Chromium-Loader + Screenshots       | ✅       |
| Windows-CI: Tests, Installer, Smoke-Test der installierten App               | ✅       |

## Protokoll

### 2026-10-10 13:51 – Dunkelmodus, Verbrauchs-Statistik und Kontext-Anzeige ✅

- **Dunkelmodus ist Standard.** Das gilt auch für deine bestehende Installation, wenn dort
  noch „System“ eingestellt war. Neu ist ein Sonne/Mond-Knopf unten links zum Umschalten.
- **Neue Ansicht „Verbrauch“** (Diagramm-Symbol links):
  - Zeiträume: Heute, 7 Tage, 30 Tage, Dieser Monat, Gesamt
  - Summen für Kosten, Anfragen, Eingabe- und Ausgabe-Tokens sowie Cache
  - Verlauf als Balkendiagramm, heute pro Stunde, sonst pro Tag. Umschaltbar zwischen
    Kosten, Tokens und Anfragen, farbig nach Anbieter.
  - Tabelle je Anbieter und je Modell
  - Bleibt erhalten, auch wenn du Chats löschst.
- **Kontext-Anzeige im Chat** (oben rechts): Ein Balken zeigt, wie voll das Gedächtnis des
  Modells ist. Ein Klick zeigt die Aufteilung (Nachrichten, Werkzeuge, System …) und ab
  80 % einen Hinweis.
- ⚠️ **Fehler bei den Kosten behoben:** Die Claude-Laufzeit meldet bei fortgesetzten Chats
  die Gesamtsumme der Sitzung statt der Kosten einer Antwort. Dadurch wurden Kosten pro Chat
  mehrfach gezählt. Jetzt wird nur der Unterschied gespeichert. Bestehende Chats werden beim
  ersten Start automatisch korrigiert.
- **Getestet:**
  - 11 neue Tests, darunter ein echter Agent-Durchlauf mit drei Antworten im selben Chat.
    Jede wird genau einmal gezählt, und der Kontext wird gemeldet.
  - Die Korrektur alter Datenbanken ist ebenfalls getestet.
  - Gesamt: 254 Tests, Smoke-Test OK, Screenshots im Dunkelmodus geprüft.

### 2026-10-10 13:35 – Handschrift-Erkennung, Pinokio und Office-Dateien ✅

- **Handschrift → Text, lokal auf der RTX 4060** (über Ollama):
  - In den Einstellungen unter „Handschrift-Erkennung“ lädst du ein Modell per Knopfdruck
    herunter, mit Fortschrittsbalken. Zur Wahl stehen Qwen3-VL 8B (empfohlen, ~6 GB),
    Qwen3-VL 4B (~3 GB) und Qwen2.5-VL 7B.
  - **Nur aktiv bei Benutzung:** Das Modell wird erst beim Erkennen in die Grafikkarte
    geladen und danach wieder entladen (einstellbar: sofort, 1 Min., 5 Min.).
  - Knopf „Text erkennen“ in der Bildvorschau mit „Kopieren“-Funktion. Der Agent hat
    zusätzlich das Werkzeug `read_handwriting`.
  - Das Modell lässt sich auch wieder entfernen, um Speicher freizugeben.
- **Pinokio:**
  - „Automatisch finden“ sucht laufende Ollama- und ComfyUI-Server auf deinem PC,
    auch auf den von Pinokio vergebenen Ports. Mit „Verwenden“ übernimmst du einen Treffer.
  - Für die Handschrift-Erkennung ist eine eigene Ollama-Adresse möglich.
- **Office-Dateien** _(Teile per Sonnet-Subagent)_:
  - **Lesen:** Word (.docx, .doc, .odt, .rtf), Excel (.xlsx, .xls, .ods, .csv) und
    PowerPoint (.pptx, .odp).
    - Angehängte Dateien gehen als Markdown an die KI, Tabellen bleiben Tabellen. Das
      verstehen alle Modelle, auch lokale.
    - Vorschau direkt in der App.
  - **Erstellen:** Der Agent erzeugt echte Word-, Excel- und PowerPoint-Dateien:
    - Word mit Überschriften, Listen und Tabellen
    - Excel mit Zahlen und Formeln
    - PowerPoint mit Stichpunkten, Notizen und Bildern
  - Klare Meldungen bei passwortgeschützten oder kaputten Dateien.
  - Alles läuft ohne Office-Installation und offline.
- **Getestet:**
  - 48 neue Tests, darunter echte Agent-Durchläufe:
    - Ein angehängtes Word-Dokument kommt als Text bei der KI an, und sie erstellt daraus
      eine Excel-Datei mit Formel.
    - Die Handschrift wird über ein nachgebautes Ollama erkannt, das Modell wird danach
      sofort entladen.
  - Gesamt: 243 Tests, Smoke-Test OK.
- **Windows-CI grün** (Tests, Installer, Smoke-Test der installierten App) → nach `main` gepusht.

### 2026-10-10 11:07 – Veröffentlicht auf `main` ✅

- **Windows-CI grün** für den Stand mit PDF-Vorschau und ComfyUI (Tests, Installer,
  Smoke-Test der installierten App).
- ⚠️ **Zwei Windows-Testprobleme behoben:**
  - Der erste PowerShell-Start ist auf dem CI-Rechner langsam; der Test bekommt jetzt mehr
    Zeit, und das Aufräumen wartet, bis der Ordner frei ist.
  - Der ComfyUI-Test hat Windows-Pfade mit `\` falsch ausgelesen.
  - In der App selbst lag kein Fehler.
- **Branch `main`** auf GitHub neu angelegt; er steht auf genau dem getesteten Stand.
  Entwickelt wird weiterhin auf `claude/ecstatic-bohr-ze5jpk`.
- **Tipp:** Unter GitHub → Settings → General → „Default branch“ auf `main` umstellen.

### 2026-10-10 11:05 – Erweiterungen: PDF-Vorschau und lokale Bild-/3D-Erzeugung ✅

- **PDF-Vorschau in der App** _(Sonnet-Subagent)_ mit pdf.js:
  - Seiten werden erst beim Scrollen gerendert.
  - Zoom und „Seitenbreite“, Seitennavigation „n / N“
  - Verständliche Fehlermeldungen bei kaputten oder passwortgeschützten PDFs
  - Die Sicherheitsregeln (CSP) mussten dafür nicht gelockert werden.
  - pdf.js wird erst geladen, wenn ein PDF geöffnet wird.
  - In einem echten Electron-Fenster mit einem 40-seitigen PDF geprüft.
  - ⚠️ Einige gescannte PDFs mit JPEG2000-/JBIG2-Bildern zeigen diese Bilder evtl. nicht an.
    Das wäre nur mit einer Lockerung für WebAssembly möglich und ist daher bewusst weggelassen.
- **Lokale Erzeugung mit ComfyUI** (kostenlos, auf deiner Grafikkarte):
  - In den Einstellungen wählst du zwischen „OpenRouter (Cloud)“ und „ComfyUI (lokal)“.
    Es gibt „Verbindung testen“, eine Checkpoint-Auswahl und die Auflösung.
  - Eingebauter Text-zu-Bild-Workflow (SD 1.5, SDXL u. a.)
  - Eigene Workflows im API-Format importieren, mit den Platzhaltern `{{prompt}}`,
    `{{input_image}}`, `{{seed}}` und `{{negative}}`.
  - 3D-Workflows (z. B. Hunyuan3D → GLB) stehen dem Agenten als Werkzeug
    `generate_3d_model` zur Verfügung. Das Ergebnis erscheint im 3D-Viewer.
  - Verständliche Fehlermeldungen, z. B. wenn ComfyUI nicht läuft, ein Workflow im falschen
    Format vorliegt oder Nodes/Modelle fehlen.
  - **Getestet** mit einem nachgebauten ComfyUI-Server (11 Tests) und über den echten
    Agenten: Er erzeugt ein Bild, lädt es in ComfyUI hoch und bekommt ein gültiges GLB-Modell
    zurück – ohne Cloud-Key.
- Das GitHub-Repo ist öffentlich, damit funktioniert das Auto-Update über Releases.

### 2026-10-10 10:33 – Phase 6 abgeschlossen ✅ · Projekt komplett

- **Auto-Update** über GitHub Releases. Das Release baut sich automatisch, sobald ein Tag `v*`
  gepusht wird (`.github/workflows/release.yml`). Den Button „Nach Updates suchen“ gibt es in
  den Einstellungen.
- **Kostenlimit pro Anfrage** (Einstellungen). Der Agent stoppt mit einer klaren Meldung.
- **Fehler-Absicherung:** Statt eines leeren Fensters erscheint bei UI-Fehlern ein
  Hinweis mit „Neu laden“.
- **Kleineres Bundle:** Die Oberfläche ist minifiziert, das Haupt-Bundle schrumpft von 3,7 MB
  auf 1,3 MB.
- **README** mit Funktionen, Installation, ersten Schritten und Datenablage.
- **Windows-CI grün** für Phase 4/5 und Phase 6: alle Tests, Installer-Build und Smoke-Test
  der installierten App unter Windows. Der Installer liegt als Artefakt `ai-workbench-windows`
  bereit (~200 MB, inkl. Claude-Code-Runtime).
- **Bewusst offen bzw. Hinweise:**
  - Ein Tray-Icon ist nicht umgesetzt.
  - Es gibt keine Code-Signatur; SmartScreen warnt beim ersten Start.
  - Auto-Update funktioniert nur bei einem öffentlichen Repo.
  - Ein echter Test mit deinen API-Keys steht noch aus.

### 2026-10-10 10:22 – Phase 4 und 5 abgeschlossen ✅, Phase 6 begonnen

**Phase 4 – Bilder & 3D**

- **Bilder erzeugen und bearbeiten:** Werkzeug `generate_image` über OpenRouter, mit
  Eingabebildern zum Bearbeiten und Seitenverhältnis.
  - Standardmodell ist `google/gemini-3.1-flash-lite-image`; in den Einstellungen lässt sich
    jedes OpenRouter-Bildmodell auswählen.
  - Bei reinen Bildmodellen probiert die App automatisch den passenden Modus.
- **Dateien und 3D-Modelle:** Werkzeug `save_file`. Der Agent schreibt OBJ, STL, PLY, glTF,
  SVG, HTML, Markdown usw. – kostenlos, als Code.
- **Anzeige** _(Opus-Subagent)_:
  - Bild-Viewer mit Zoom und Verschieben
  - 3D-Viewer mit three.js (GLB, glTF, OBJ+MTL, STL, PLY), Drehen, Drahtgitter, Auto-Rotation
    und Anzahl der Dreiecke; three.js wird erst bei Bedarf geladen
  - Erzeugte Dateien erscheinen direkt im Chat, zusätzlich im Panel „Ergebnisse“ (öffnet sich
    automatisch)
  - Aktionen: „Speichern unter“, „Im Ordner zeigen“, „Extern öffnen“, „Als Eingabe verwenden“
  - Das Projekt-Panel zeigt Bilder und 3D-Dateien ebenfalls als Vorschau.
- **Speicherorte:** Im Chat landen Ergebnisse im Chat-Ordner, beim Coding unter
  `<Projekt>/ai-output/`.
- **Sicherheit:** Ausführbare Dateien (.exe, .ps1 usw.) werden nie automatisch geöffnet.
- **Getestet:**
  - Der Agent erzeugt über den echten Runtime ein Bild (über einen nachgebauten OpenRouter)
    und ein 3D-Modell.
  - Der Screenshot zeigt die gerenderte 3D-Pyramide im Chat.

**Phase 5 – Skills & Add-ons** (Seite „Skills & Add-ons“, UI vom Sonnet-Subagent)

- **Skills** (`SKILL.md`) aus GitHub-Repos installieren, z. B. `anthropics/skills`: Das Repo wird
  durchsucht, und du wählst aus, was installiert wird.
- **Plugins** (Claude-Code-Format) aus GitHub oder einem lokalen Ordner.
- **MCP-Server** aus der offiziellen MCP-Registry (npm, pypi, Remote) oder manuell.
  Zugangsdaten werden verschlüsselt gespeichert und nie an die Oberfläche geschickt.
- Alles lässt sich einzeln an- und abschalten. Werkzeuge fremder MCP-Server fragen vor der
  Nutzung um Erlaubnis, auch im normalen Chat.
- **Getestet:**
  - Ein echter MCP-Server läuft im Agenten, mit verschlüsseltem Geheimnis und Freigabe.
  - Der installierte Skill ist für das Modell sichtbar.
  - Archive mit unsicheren Pfaden („Zip-Slip“) werden abgelehnt.

**Phase 6 (begonnen)**

- Chat-Suche (Strg+K) und Export als Markdown
- Backup aller Chats (JSON)
- Tastenkürzel: Strg+N, Strg+Umschalt+O, Strg+,
- App-Icon
- Protokollierung unerwarteter Fehler

**Windows-Fixes aus der CI**

- ⚠️ Kurze 8.3-Pfadnamen (`RUNNER~1`) brachten den Agenten dazu, bei Projektdateien trotzdem
  nachzufragen. Projektpfade werden jetzt normalisiert.
- ⚠️ Zwei Terminal-Tests nutzten Linux-Syntax bzw. erwarteten `\n`; sie sind jetzt
  plattformgerecht.
- ⚠️ Ohne GPU-Treiber (z. B. in VMs) startete der 3D-Viewer nicht. Jetzt gibt es eine
  Software-Rendering-Ausweichlösung.

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
