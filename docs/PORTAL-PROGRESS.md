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
| M4      | Gruppen + Einladungs-QR                              | ⏳ in Arbeit    |      |
| M5      | Budgets in USD                                       | offen          |      |
| M6      | Admin-Dashboard                                      | offen          |      |
| M7      | Media (Bild/Sprache/Video via OpenRouter)            | offen          |      |
| M7b     | CAD-Dienst + 3D-Viewer                               | offen          |      |
| M8      | Härtung, Backup/Restore, Go-live-Anleitung           | offen          |      |

## Wartet auf dich

- **Docker-Port** für LibreChat (`LIBRECHAT_HOST_PORT`) und Gateway (`PORTAL_HOST_PORT`) – Platzhalter sind gesetzt.
- Server-Bestandsaufnahme ausführen (siehe M0) und Ausgabe schicken.
- **Websuche** (Schalter „Web Search“ in LibreChat): ja oder nein? LibreChat bucht die Suchkosten
  **nicht** vom Guthaben ab. Bis zur Entscheidung: in der Anthropic Console für den Workspace abschalten.

## Log

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
