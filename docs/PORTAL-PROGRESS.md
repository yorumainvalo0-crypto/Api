# Fortschritt: A-B Cloud AI Portal

Plan: [WEB-HOSTING-PLAN.md](WEB-HOSTING-PLAN.md) · Code: [`portal/`](../portal/)

Alles wird zuerst **lokal in Docker** gebaut und getestet (komplette Testumgebung mit LibreChat,
MongoDB und Test-Doubles für Anthropic/OpenRouter). Auf dem Hetzner-Server ist noch **nichts** geändert.

## Übersicht

| Schritt | Inhalt                                               | Status         | Test |
| ------- | ---------------------------------------------------- | -------------- | ---- |
| M0      | Repo-Struktur `portal/`, Server-Bestandsaufnahme     | ✅ fertig       | ✅    |
| M1      | LibreChat-Basis (Claude, Model-Specs, Guthaben)      | ✅ fertig       | ✅ 5/5 |
| M2      | Code-Ausführung + Datei-Skills                       | ✅ fertig       | ✅ 11 + 2 |
| M3      | Gateway-Kern: Login, Admin, Login-QR, Geräte         | ✅ fertig       | ✅ 25 + 5 |
| M4      | Gruppen + Einladungs-QR                              | ✅ fertig       | ✅ 6 + 4 |
| M5      | Budgets in USD                                       | ✅ fertig       | ✅ 6 + 3 |
| M6      | Admin-Dashboard                                      | ✅ fertig       | ✅ 6 + 3 |
| M7      | Media (Bild/Sprache/Video via OpenRouter)            | ✅ fertig       | ✅ 8 + 4 |
| M7b     | CAD-Dienst + 3D-Viewer                               | ✅ fertig       | ✅ 6 + 3 + 2 |
| M8      | Härtung, Backup/Restore, Go-live-Anleitung           | ✅ fertig       | ✅ 4 + 1 + Restore |

**Nächster Schritt:** Inbetriebnahme auf dem Server nach [GO-LIVE.md](GO-LIVE.md) – alles Nötige liegt vor.

## Wartet auf dich

- Nichts mehr für die Inbetriebnahme. Später optional: Bild/Sprache/Video einschalten (`MEDIA_ENABLED=true` + OpenRouter-Key).

## Log

### 19.10.2026 – Bild/Sprache/Video vorerst aus

- Neue Einstellung `MEDIA_ENABLED` (Standard: aus). Claude bekommt dann nur Kontostand und 3D-Teile als
  Portal-Werkzeuge, ein OpenRouter-Key ist nicht nötig. Einschalten später mit `MEDIA_ENABLED=true` +
  `OPENROUTER_API_KEY` – die Funktionen bleiben im Test-Stack eingeschaltet und weiter getestet.
- 3D-Druck: Slicen machst du selbst, der CAD-Skill bleibt bei allgemeinen FDM-Regeln.
- **Tests:** 65 Gateway-Tests grün (neu: ohne Einstellung bietet das Gateway keine Bild-/Video-Werkzeuge an).

### 19.10.2026 – Port 45012 aus der alten Compose übernommen

- Das alte Portal läuft mit eigenem nginx-Container auf `127.0.0.1:45012`, der Server-nginx (TLS) leitet dorthin.
- Das neue Portal bekommt dafür ebenfalls einen nginx-Container (`portal-nginx`) auf **demselben Port**:
  der Server-nginx bleibt unverändert. **Umschalten** = alte Compose stoppen, neue starten (ca. 1 Minute);
  **Rollback** umgekehrt. Die beiden Port-Platzhalter entfallen, LibreChat und Gateway sind nur noch intern erreichbar.
- Der Test-Stack läuft jetzt genauso (Server-nginx → portal-nginx → LibreChat/Gateway); dabei geprüft:
  echte Client-IP kommt an, eine gefälschte `X-Forwarded-For` wird ignoriert, `/portal/mcp` bleibt von außen 404.
- [GO-LIVE.md](GO-LIVE.md) entsprechend umgeschrieben (Prüfung des Server-nginx, Sicherung des alten Volumes,
  Start ohne Eingang, Umschalten, Rollback). **Tests:** 30 Browser-Tests grün über die neue Kette.

### 19.10.2026 – Anmeldung mit Passwort (ohne Authenticator-App)

- **Admin-Login nur mit Passwort** (keine Authenticator-App nötig). Schutz: Sperre nach 10 Fehlversuchen
  für 15 Minuten, zusätzlich Rate-Limit pro IP. Zweiter Faktor lässt sich später mit `ADMIN_TOTP=true` einschalten.
- **Benutzer mit Passwort:** Beim Anlegen im Admin-Bereich optional ein Passwort vergeben (ein zufälliger
  Vorschlag wird angezeigt); auf der Benutzerseite ändern oder entfernen. Wer auf diesem Gerät nicht
  angemeldet ist, sieht im Chat jetzt ein Anmeldeformular (Benutzername + Passwort) – QR-Codes gehen weiterhin.
- **Tests:** 65 Gateway- + 18 Runner- + 30 Browser-Tests grün (neu: Passwort-Login im Browser mit falschem und
  richtigem Passwort, Sperre nach Fehlversuchen, Passwort ändern/entfernen).

### 19.10.2026 – Websuche über Anthropic

- Claude kann bei Bedarf im Web suchen (Anthropic-Websuche, in allen drei Modellen an).
- LibreChat bucht dafür nur die Tokens ab. Das Gateway zählt deshalb alle 15 s die Suchen in neuen
  Antworten und bucht **0,01 USD pro Suche** vom Budget der Person – jede Suche genau einmal,
  auch bei fortgesetzten Antworten. Im Dashboard erscheint das als Modell `web_search`.
- **Tests:** 3 Gateway-Tests (Zählen, keine Doppelbuchung bei parallelen Läufen, Dashboard) + 1 Browser-Test
  (zwei Suchen im Chat → 0,02 USD abgebucht). Gesamt: 62 Gateway- + 18 Runner- + 29 Browser-Tests grün.

### 19.10.2026 – M8 fertig (Härtung, Backup/Restore, Go-live-Anleitung)

- **Sicherheitsprüfung** des gesamten Portal-Codes, alle wichtigen Funde behoben und mit Tests belegt:
  - 3D-Viewer: Modelldaten aus der Sandbox werden streng geprüft (kein Einschleusen von Skript),
    Seite mit Content-Security-Policy.
  - Code-Runner: liest Ausgaben der Sandbox nie über Symlinks (Test: untergeschobener Link wird ignoriert),
    Größenlimits, Container-Logs auf 1 MB begrenzt, nur noch im internen Docker-Netz `code`.
  - Rate-Limits ließen sich mit gefälschtem `X-Forwarded-For` umgehen → behoben (Test zeigte vorher 5× durchgelassen).
  - Admin-TOTP: jeder Code nur einmal, nach 5 falschen Codes 15 Min. Sperre.
  - Media-Kosten werden **vor** dem Aufruf reserviert: drei parallele Bilder bei Guthaben für zwei → eins wird
    abgelehnt; Videos max. 2 gleichzeitig pro Person; bei Fehlern wird die Reservierung erstattet.
  - Login-Links: erst Knopf „Auf diesem Gerät anmelden“ – Link-Vorschauen (WhatsApp, Mail-Scanner)
    verbrauchen den QR-Code nicht mehr.
  - Abmelden beendet die Gerätesitzung serverseitig (mit CSRF-Schutz); CSV-Export entschärft Excel-Formeln.
- **Backup/Restore** (`backup.sh`, `restore.sh`): beide Datenbanken, Uploads, Media, Konfiguration,
  Prüfsummen, optional Kopie auf die Storage Box. **Restore-Test:** Backup → beide DBs und Media
  gelöscht → Restore → alle Zahlen identisch (13 Benutzer, 70 Buchungen, 12 Chats, 8 Media-Dateien),
  Login- und Budget-Tests danach wieder grün.
- **`setup-env.py`** erzeugt `.env` und `portal-gateway.env` mit frischen, passenden Geheimnissen (Rechte 600).
- **`healthcheck.sh`** für Cron: prüft Chat, Gateway, Container und dass `/portal/mcp` von außen gesperrt ist;
  Alarm einmal pro Störung (z. B. ntfy aufs Handy).
- **[GO-LIVE.md](GO-LIVE.md):** Schritt-für-Schritt-Anleitung für den Server inkl. Rollback.
- **Stand gesamt:** 59 Gateway- + 18 Runner- + 28 Browser-Tests grün.

### 19.10.2026 – M7b fertig (technische 3D-Teile + 3D-Vorschau)

- **Werkzeug `cad_erstellen`:** Claude schreibt parametrischen **build123d**-Code (Millimeter);
  ein eigener CAD-Container (OpenCascade, kein Netzwerk, 2 GB RAM, 90 s Zeitlimit) baut das Teil.
  Zurück kommen: **Vorschaubild mit 4 Ansichten im Chat**, Maße, Volumen, Oberfläche,
  „wasserdicht/druckbar“, **STL, 3MF, STEP** zum Download und ein Link zur **3D-Ansicht**.
- **Versionen:** gleicher Name im selben Chat = neue Version („Löcher auf M5“ → Version 2).
  Fehler im Code gehen lesbar an Claude zurück, Claude korrigiert selbst.
- **3D-Viewer** `/portal/view/…`: drehen/zoomen (Maus und Touch), mm-Raster, Maß-Box,
  Ansichten Iso/Vorne/Oben/Rechts, Drahtgitter, Schnitt in der Höhe, Versionsauswahl, Downloads,
  Vollbild, Hell/Dunkel. three.js wird vom Gateway selbst ausgeliefert (kein externes CDN).
- **Skill „cad-3d-printing“:** build123d-Muster und FDM-Regeln (Wandstärken, Toleranzen,
  Schraubenlöcher, Überhänge, Druckausrichtung).
- **Tests:** 6 Runner-Tests mit echtem CAD-Kern (Halterung mit Löchern: Maße und Volumen exakt,
  alle Formate gültig, Fehler lesbar, Endlosschleife abgebrochen, kein Netzwerk) + 3 Gateway-Tests
  (Versionen, Fehler, Viewer-Signatur, three.js ohne Pfad-Ausbruch) + 2 Browser-Tests
  (Rohrschelle 25 mm → exakt 55 × 20 × 15,5 mm, wasserdicht, STEP gültig; Viewer rendert per WebGL).
- Beim Anschauen gefunden und behoben: Modell im Viewer war schwarz (fehlende Normalen),
  Vorschau zu klein; Rate-Limit des Admin-Logins jetzt konfigurierbar (Test: 4. Fehlversuch → gesperrt).
- **Stand gesamt:** 55 Gateway- + 17 Runner- + 28 Browser-Tests grün.
- Screenshots: [Chat mit CAD-Vorschau](screenshots/chat-cad.png) · [3D-Viewer](screenshots/viewer-3d.png)


### 19.10.2026 – M7 fertig (Bild, Sprache, Video über OpenRouter)

- Neue Werkzeuge für Claude im Gateway (MCP), bezahlt aus dem **USD-Budget** der Person:
  - `bild_erstellen` – Bild aus Beschreibung, **erscheint direkt im Chat**, plus Download-Link.
  - `bild_bearbeiten` – ein zuvor erzeugtes Bild verändern (nur eigene Bilder).
  - `sprache_erstellen` – Text → MP3 zum Anhören/Herunterladen.
  - `video_erstellen` + `video_status` – Video läuft im Hintergrund (dauert Minuten); das Gateway
    holt es ab, rechnet ab und Claude liefert auf Nachfrage den Link.
- Abrechnung mit den **echten Kosten von OpenRouter** (bei Sprache Schätzung nach Zeichen, falls
  OpenRouter keine Kosten meldet). Vor jeder Anfrage Prüfung, ob genug Guthaben da ist; bei
  Fehlern von OpenRouter wird nichts abgebucht. Media-Kosten erscheinen im Dashboard.
- Dateien 30 Tage gespeichert; Download-Links sind signiert und laufen nach 7 Tagen ab.
- **Tests:** 8 Gateway-Tests (mit OpenRouter-Test-Double: Kosten, zu wenig Guthaben, Fehler ohne
  Abbuchung, fremde Bilder, Sprache echt/geschätzt, Video asynchron genau einmal / Fehlschlag kostenlos)
  + 4 Browser-Tests (Bild im Chat, MP3-Link, Video-Ablauf, Kosten im Dashboard).
  **Gesamt: 51 Gateway- + 26 Browser-Tests grün.**
- Screenshot: [Bild im Chat](screenshots/chat-bild.png)


### 19.10.2026 – M6 fertig (Verbrauchs-Dashboard)

- Admin-Bereich **Verbrauch** (`/portal/admin/usage`):
  - Filter: Zeitraum (heute, 7/30/90 Tage, dieser/letzter Monat) und Gruppe.
  - Kacheln: **Kosten in USD**, Tokens rein/raus, Anfragen, aktive Personen.
  - Diagramm **Kosten pro Tag** (bei „heute“ pro Stunde), Tooltip beim Zeigen auf einen Balken
    (Kosten + Tokens), Hell- und Dunkelmodus.
  - Tabellen **nach Person** (inkl. Gruppe und Restguthaben), **nach Modell**, **nach Gruppe**.
  - **CSV-Export** (pro Tag, Person, Modell; deutsches Zahlenformat, öffnet direkt in Excel).
- Quelle sind LibreChats eigene Buchungen; Gutschriften und Monatsresets zählen nicht als Verbrauch,
  Media-Kosten (M7) schon. Tagesgrenzen in deutscher Zeit.
- **Tests:** 6 Gateway-Tests (Summen je Person/Modell/Gruppe, Filter, leere Tage, Tagesgrenzen,
  CSV) + 3 Browser-Tests: Tagessumme im Dashboard = Summe der LibreChat-Buchungen; Tooltip; CSV.
- Beim Anschauen gefunden und behoben: Tooltip erschien nicht, wenn man direkt auf den Balken
  zeigte; Balken in der Tabelle überdeckten die Beträge.
- Screenshots: [hell](screenshots/dashboard-light.png) · [dunkel](screenshots/dashboard-dark.png)


### 19.10.2026 – M5 fertig (Budgets in US-Dollar)

- **Startbudget** aus der Einladung (oder beim direkten Anlegen) wird beim ersten Login automatisch
  gebucht – innerhalb von ~2 Sekunden, genau einmal.
- **Monatsbudget:** am 1. jedes Monats um 0:00 Uhr (deutsche Zeit) wird das Guthaben auf das
  Monatsbudget gesetzt (kein Übertrag). Monatsbudget 0 = kein automatisches Aufladen.
- **Admin, Benutzerseite → Budget:** verbleibendes Guthaben, Monatsbudget, nächstes Zurücksetzen,
  **„Limit erweitern“** (+ USD, sofort wirksam), Monatsbudget ändern, Verlauf aller Buchungen.
  Benutzerliste zeigt das Guthaben jeder Person.
- Buchungen laufen genau wie LibreChats eigenes Aufladen (Transaktion + Guthaben) → LibreChat zeigt
  das Guthaben korrekt an und blockiert bei 0.
- **Tests:** 6 neue Gateway-Tests (einmalige Startbuchung trotz paralleler Läufe, Aufladen vor/nach
  erstem Login, Monatsreset ohne Übertrag und nur einmal, Monatswechsel mit Sommer-/Winterzeit und
  Jahreswechsel, Admin-Formulare) + 3 Browser-Tests (Startbudget sofort nutzbar und korrekt
  abgebucht; ohne Budget blockiert → Admin lädt auf → geht sofort; Claude nennt per `konto_status`
  das eigene Guthaben). **Gesamt: 37 Gateway- + 19 Browser-Tests grün.**


### 19.10.2026 – M4 fertig (Gruppen + Einladungs-QR)

- Admin-Bereich **Gruppen & Einladungen**: Gruppe anlegen (mit Standard-Start- und Monatsbudget),
  Einladung erstellen mit **Anzahl Personen**, **gültig ab / bis** (deutsche Zeit), Budgets und Notiz.
  Der **QR-Code** kann jederzeit wieder angezeigt und **gedruckt** werden; Einladungen lassen sich
  zurückziehen. Pro Gruppe: Liste der Einladungen (z. B. „2 / 3 Plätze“) und der Mitglieder.
- **Beitritt per QR:** Handy scannt → Seite „Du wurdest in die Gruppe … eingeladen“ → Benutzername
  wählen → direkt im Chat. Der Account bekommt Gruppe und Budgets der Einladung.
- Sicher gegen gleichzeitiges Scannen: Plätze werden atomar vergeben. Ist der Name schon vergeben
  oder ungültig, wird der Platz zurückgegeben.
- **Tests:** 6 neue Gateway-Tests (5 gleichzeitige Beitritte bei 3 Plätzen → genau 3; Zeitfenster;
  Widerruf; vergebener Name; Sommer-/Winterzeit) + 4 Browser-Tests auf Handy-Größe (2 Personen treten
  bei, die 3. wird abgewiesen, vergebener Name kostet keinen Platz). Alles grün.
- Screenshots: [Handy – Beitritt](screenshots/handy-beitritt.png) ·
  [Admin – Einladung](screenshots/admin-einladung.png)


### 19.10.2026 – M2 fertig (Code-Ausführung, Dateiausgabe, Skills)

- Statt des offiziellen Code-Interpreters (braucht `/dev/kvm`, Redis, S3, viele Images) ein eigener,
  schlanker **Code-Runner** `portal/code-runner/`, der LibreChats Code-Schnittstelle spricht.
  - **Jede Ausführung in einem frischen Container:** kein Netzwerk, max. 1 GB RAM / 1 CPU / 256
    Prozesse, Zeitlimit, nur `/mnt/data` beschreibbar, kein root, Container danach gelöscht.
  - Sandbox-Image mit Python, Node, python-docx, openpyxl, python-pptx, reportlab, pypdf,
    matplotlib, pandas, Schriften mit Umlauten/€.
  - Hochgeladene Dateien landen in `/mnt/data`, neue/geänderte Dateien kommen als Download zurück.
- **4 Skills** für Claude (`portal/deploy/skill/`): Word, Excel, PowerPoint, PDF – Anleitungen für
  saubere Dateien (Formatierung, Formeln, Diagramme, deutsche Zahlen-/Datumsformate).
- **Tests:** 11 Runner-Tests mit echten Containern (docx/xlsx/pptx/pdf erzeugen, Uploads verarbeiten,
  kein Netzwerk, Zeitlimit, kein Schreiben außerhalb, schreibgeschützte Skill-Dateien, Umlaute im PDF)
  + 2 Browser-Tests: Claude erzeugt eine Word-Datei → erscheint im Chat → Download ist eine echte
  `.docx`; die 4 Skills werden Claude angeboten. **Gesamt jetzt 12/12 Browser-Tests grün.**
- Produktions-Compose ergänzt (Gateway + Code-Runner, alle Ports nur lokal) und mit
  `docker compose config` gegen LibreChats Original-Datei geprüft; Build-Skript für die Images.
- ⚠ **Sicherheitshinweis:** Der Code-Runner steuert Docker über den Docker-Socket (nötig, um pro
  Ausführung einen Container zu starten). Er ist nur intern erreichbar; der Code selbst läuft
  ohne Netzwerk und Rechte. Für einen Kreis vertrauenswürdiger Nutzer angemessen.


### 19.10.2026 – M3 fertig (Gateway: Login, Admin, Login-QR, Geräte)

- Neues **Portal-Gateway** `portal/gateway/` (TypeScript, Fastify, Docker-Image):
  - **Login-Server für LibreChat (OIDC):** LibreChat leitet automatisch zum Gateway; wer auf dem
    Gerät angemeldet ist, landet ohne Klick im Chat.
  - **Admin-Login** mit Passwort + **Zwei-Faktor-Code** (Authenticator-App; Einrichtung per QR beim
    ersten Login). Der erste Admin wird beim Start aus der Konfiguration angelegt.
  - **Admin-Bereich** `/portal/admin`: Benutzer anlegen, **Login-QR-Code** erzeugen (Gültigkeit in
    Stunden, wie oft nutzbar, Notiz), Login-Links widerrufen, **Geräte** sehen und abmelden,
    **Sperren/Entsperren**, Protokoll aller Admin-Aktionen.
  - **MCP-Server** für LibreChat mit erstem Werkzeug `konto_status` („Wie viel Guthaben habe ich noch?“).
  - Sicherheit: Tokens nur gehasht gespeichert, CSRF-Schutz, Rate-Limits beim Admin-Login,
    Cookies `HttpOnly`/`Secure`.
- Testumgebung jetzt wie der Server: **nginx mit HTTPS** (Test-Zertifikat für `portal.test`) vor
  LibreChat und Gateway.
- **Tests:** 25 Unit-/Integrationstests im Gateway + 10 Browser-Tests (M1 + M3) – **alle bestanden**:
  - ohne Anmeldung → Hinweis „QR-Code scannen“; Admin-Login mit TOTP; Admin ist auch in LibreChat Admin;
  - Login-QR → direkt im Chat mit dem gewählten Benutzernamen; zweiter Scan desselben QR abgelehnt;
  - zweites Gerät sieht dieselben Chats; Admin sieht beide Geräte;
  - Sperren beendet die LibreChat-Sitzung sofort.
- **Befunde und Entscheidungen:**
  - LibreChat spricht mit dem Login-Server **nur über HTTPS** – auf dem Server ohnehin gegeben.
  - Die Gerätesitzung ist die einzige Quelle der Wahrheit: LibreChat meldet sich **täglich unsichtbar**
    neu an. „Gerät abmelden“ wirkt dadurch spätestens nach einem Tag, „Sperren“ sofort.
  - Admin-Oberfläche serverseitig gerendert (statt React) – weniger Abhängigkeiten, leichter abzusichern.
- CI: `.github/workflows/portal.yml` prüft das Gateway bei jedem Push (Typen, Tests, Build, Docker-Image).


### 19.10.2026 – M1 fertig

- Lokale Testumgebung `portal/test-stack/` (Start: `./up.sh`): LibreChat **v0.8.8** mit der echten
  Produktions-Konfiguration, MongoDB und einem Test-Double für die Anthropic API (zählt Anfragen,
  liefert feste Token-Zahlen → Kosten exakt prüfbar). Kein echter API-Key nötig.
- Automatische Tests `portal/test-stack/e2e` (Browser + Datenbank), **5/5 bestanden**:
  1. Im Chat gibt es nur Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5, Standard = Opus 5.5 mit Effort „medium“.
  2. Neuer Account hat 0 USD → Anfrage wird blockiert, nichts geht an Anthropic.
  3. Nach Aufladen: Anfrage geht mit `claude-opus-5-5` + `effort: medium` + Werkzeugen
     (Code-Ausführung, Datei-Erstellung, Skills, Portal-MCP) raus; abgebucht werden exakt
     0,014 USD (1000 Eingabe- × 4 $ + 500 Ausgabe-Tokens × 20 $ pro Mio.).
  4. Chat-Titel werden mit dem günstigen **Haiku 5.5** erzeugt (vorher: Opus → unnötige Kosten).
  5. Effort-Regler im Parameter-Panel: Medium → High kommt als `effort: high` bei Claude an.
- Änderungen an der Konfiguration durch die Tests:
  - Werkzeuge direkt in den Model-Specs statt vorab angelegter Agenten (einfacher, keine IDs nötig).
  - `mcpSettings.allowedAddresses`: LibreChat blockiert interne Adressen; nur das Gateway ist freigegeben.
  - Titel-Modell Haiku 5.5; Text der Nutzungsbedingungen korrigiert; Image-Version gepinnt.
- **Befunde:**
  - ⚠ Ist der MCP-Server (Gateway) nicht erreichbar, **schlagen alle Chats fehl**. → Gateway mit
    automatischem Neustart + Überwachung betreiben (in M8 eingeplant).
  - ⚠ Websuche wird nicht vom Guthaben abgebucht (siehe „Wartet auf dich“).


### 19.10.2026 – M0 fertig

- Ordner `portal/` angelegt: `deploy/` (Server-Konfiguration), `gateway/`, `cad-runner/`, `test-stack/`.
  Die Electron-App bleibt unberührt (`portal/` ist aus deren Lint ausgenommen).
- **Server-Bestandsaufnahme:** `portal/deploy/scripts/inventory.sh` – ändert nichts, liest nur
  Ports, nginx-Weiterleitungen, Zertifikate, Docker-Container, Dienste, Firewall.
  Auf dem Server: `sudo bash inventory.sh > inventory.txt` und die Datei schicken.
- **Test:** `bash -n` + `shellcheck` (Inventar- und Backup-Skript) ohne Befund; Probelauf in der
  Testumgebung erfolgreich.
- Testumgebung: Docker läuft, LibreChat- und MongoDB-Images lassen sich laden.
