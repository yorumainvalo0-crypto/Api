# Plan: A-B Cloud AI Portal neu – LibreChat + Portal-Gateway auf ai.dev.a-b-cloud.de

Stand: 19.10.2026 · Status: Planung (noch nichts auf dem Server umgesetzt)

## 0. Ziel in einem Satz

Das bestehende „A-B Cloud AI Portal“ auf `ai.dev.a-b-cloud.de` wird durch eine Claude.ai-ähnliche
Oberfläche ersetzt, in der eingeladene Personen per **QR-Code** beitreten, Claude (Anthropic API) und
nutzen, **Dateien hochladen und erzeugen**, **Bilder/Sprache/Video**
generieren und **technische 3D-Modelle (3D-Druck/CAD) mit 3D-Vorschau** erstellen – jeweils mit einem **Budget in US-Dollar**, das der Admin festlegt und überwacht.

## 1. Anforderungen

| #   | Anforderung                                                                                                        | Umsetzung (Kapitel)                     |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| A1  | Chat wie Claude.ai, Datei-Upload, Chats online gespeichert (auf jedem Gerät verfügbar)                             | LibreChat (§4)                          |
| A2  | Admin erstellt **Gruppen** mit **Einladungs-QR/Link**: max. Anzahl Personen (z. B. 3) und Gültigkeitszeitraum      | Gateway: Einladungen (§6.2)             |
| A3  | Eingeladene Person wählt beim Beitritt **selbst einen Benutzernamen** (keine E-Mail nötig)                         | Gateway: Beitritt (§6.2)                |
| A4  | Admin erstellt pro Benutzer einen **Login-QR-Code** (neues Gerät / erneute Anmeldung)                              | Gateway: Login-Links (§6.3)             |
| A5  | **Budget pro Person in USD**, vom Admin festgelegt, jederzeit **erweiterbar**                                      | Gateway: Budgets (§6.4)                 |
| A6  | **Admin-Dashboard**: wer hat wann wie viel verbraucht – USD und Tokens                                             | Gateway: Dashboard (§6.5)               |
| A7  | Jeder wählt **Modell und Aufwand (Effort)** selbst, Standard **Claude Opus 5.5, Effort „medium“**                  | LibreChat Model-Specs (§4.3)            |
| A8  | **Ausgabe aller Dateitypen** (docx, xlsx, pptx, pdf, csv, zip, Bilder, Code …)                                     | Code-Interpreter + Skills (§5)          |
| A9  | **Bild-, Sprach- und Video-Generierung** über **OpenRouter-Key**, aus dem USD-Budget bezahlt – **vorerst aus** (`MEDIA_ENABLED`) | Media-Dienst (MCP) (§6.6)               |
| A10 | OpenRouter-Modelle im Chat **vorerst nicht anzeigen** (später zuschaltbar)                                         | Konfiguration (§4.1)                    |
| A11 | Docker-Port nach Vorgabe des Admins                                                                                | Port **45012** des alten Portals (§3)   |
| A12 | AI erzeugt **technische 3D-Teile** (maßgenau, für 3D-Druck) mit **interaktiver 3D-Vorschau** im Web                | CAD-Dienst + 3D-Viewer (§6.7)           |
| A13 | Claude Fable **nicht** freischalten                                                                                | Modellliste (§4.1)                      |

## 2. Ist-Zustand (geprüft am 19.10.2026)

- `ai.dev.a-b-cloud.de` → 88.99.138.164 (Hetzner), **nginx** auf 443 (HTTP/2, Let's Encrypt), 80 → 301 auf HTTPS.
- Dahinter das alte Portal (React-SPA + API mit `/api/generate/image|speech|video|transcription`,
  `/api/admin/users`, `/api/keys/credits`) als Docker Compose: App, SearXNG (Websuche) und ein eigener
  nginx-Container auf **`127.0.0.1:45012`** (HTTP), zu dem der Server-nginx weiterleitet
  (zusätzlich `0.0.0.0:45443` HTTPS für Betrieb ohne Proxy).
- **Wiederverwendbar:** Die OpenRouter-Aufrufe der alten App für Bild/Sprache/Video (Modelle, Parameter)
  → in Phase 0 aus deren Code/Config übernehmen.

## 3. Gesamtarchitektur

```
                  https://ai.dev.a-b-cloud.de  (Server-nginx, 443, TLS – bleibt unverändert)
                                       │
                         portal-nginx (127.0.0.1:45012, wie das alte Portal)
              ┌────────────────────────┴─────────────────────────┐
              │ /                                                │ /portal/…
              ▼                                                  ▼
   LibreChat (api:3080, nur intern)                    Portal-Gateway (portal-gateway:8080, nur intern)
   ─ Chat-UI, Chats, Uploads                           ─ OIDC-Login-Server (IdP) für LibreChat
   ─ Endpoints: Anthropic, Agents                      ─ Gruppen, Einladungs-QR, Benutzernamen
   ─ Guthaben-Prüfung pro Anfrage                      ─ Login-QR pro Benutzer, Geräte-Sitzungen
   ─ Model-Specs (Standard Opus 5.5 / medium)          ─ Budgets USD (setzen, aufladen, Monats-Reset)
              │            │                           ─ Admin-Dashboard (USD/Tokens)
              │            └── MCP (HTTP) ───────────▶ ─ Media-Dienst: Bild/Sprache/Video via OpenRouter
              │                                        ─ CAD-Dienst + 3D-Viewer (/portal/view/…)
              │                                                  │──▶ CAD-Runner (Sandbox, kein Netz)
              ├──▶ Code-Interpreter (Sandbox, Dateiausgabe)      │
              ▼                                                  ▼
          MongoDB  ◀──────── liest transactions / schreibt balances ┘
          (DB „LibreChat“ + DB „portal“)        Meilisearch, (optional RAG + pgvector)

   Externe APIs: Anthropic (Claude) · OpenRouter (nur Bild/Sprache/Video)
```

**Grundsatz:** LibreChat bleibt **unverändert** (kein Fork) – alles Fehlende kommt in das eigene
**Portal-Gateway**, das nur über offizielle Schnittstellen andockt (OIDC-Login, MCP, MongoDB-Collections
`balances`/`transactions`). So bleiben LibreChat-Updates einfach.

**Ports:** Veröffentlicht wird nur `portal-nginx` auf `127.0.0.1:45012` – derselbe Port wie beim alten
Portal, daher bleibt der Server-nginx unverändert und Umschalten/Rollback ist ein Compose-Stop/-Start.

**Auslieferung:** ein Ordner `ai-portal-neu` (gebaut mit `portal/deploy/make-bundle.sh`): eigene
`docker-compose.yml` (MongoDB, LibreChat, Gateway, Code-Runner, portal-nginx), Quellcode unter `src/`,
`start.sh` (Ersteinrichtung, Images bauen, starten, altes Portal stoppen) und `rollback.sh`.
LibreChat und Gateway sind nur im Docker-Netz erreichbar (Docker umgeht sonst `ufw`).

## 4. LibreChat (Chat, Modelle, Effort, Guthaben)

### 4.1 Endpoints

| Endpoint     | Zweck                                                  | Preise für Abrechnung                                        |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------ |
| `anthropic`  | Claude direkt (Opus 5.5, Sonnet 5.5, Haiku 5.5)         | eingebaute Tabelle: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0,10/$0,50 pro 1 M Tokens |
| `agents`     | Claude **mit Werkzeugen** (Code/Dateien, Media, Skills) | wie das zugrunde liegende Modell                             |
| ~~Fable~~    | **bewusst nicht freigeschaltet** (`claude-fable-5-1` fehlt in `ANTHROPIC_MODELS`)          | – |
| `OpenRouter` | **vorerst ausgeblendet** – andere Chat-Modelle (GPT, Gemini …), später per Config zuschaltbar | automatisch aus OpenRouters `/models`-Preisliste |

### 4.2 Guthaben (technische Basis für §6.4)

- `balance.enabled: true`, `startBalance: 0`, **`autoRefillEnabled: false`** – Aufladen und Monats-Reset
  macht das Gateway (pro Person unterschiedlich, LibreChat kann das nur global).
- LibreChat prüft **vor jeder Anfrage** das Guthaben und bucht danach exakt ab
  (`transactions`: 1 USD = 1.000.000 Credits). Leeres Guthaben → Anfrage wird abgelehnt.
- Anzeige für Nutzer: `balance.display: currency`, `interface.currency: USD`,
  `interface.contextCost: true` (Kosten pro Chat sichtbar).

### 4.3 Modell- und Effort-Auswahl (A7)

- **Model-Specs** in `librechat.yaml`, `enforce: false` → Nutzer dürfen frei wechseln.
- Standard-Spec (`default: true`): **„Claude Opus 5.5“** = Agent mit Modell `claude-opus-5-5`,
  `effort: medium` und allen Werkzeugen (Datei-Ausgabe, Media).
- Weitere Specs: „Claude Sonnet 5.5“, „Claude Haiku 5.5“ (ebenfalls Agents mit Werkzeugen).
  Im Chat erscheinen **nur Claude-Modelle**; OpenRouter dient vorerst ausschließlich dem Media-Dienst (§6.6).
- **Effort:** Regler im Parameter-Panel und „Thinking“-Auswahl pro Nachricht
  (`low` · `medium` · `high` · `xhigh` · `max`). LibreChat sendet ihn als `output_config.effort`.
  Bei Opus 5.5 ist Thinking immer an; Effort steuert Tiefe **und** Kosten.
- ✅ Getestet (M1): Specs nutzen das `anthropic`-Endpoint und schalten die Werkzeuge direkt ein
  (`executeCode`, `skills`, `artifacts`, `mcpServers`) – keine vorab angelegten Agenten nötig.
  Effort-Regler im Parameter-Panel funktioniert (Medium → High kommt bei Claude an).
- Chat-Titel werden mit Haiku 5.5 erzeugt (spart Kosten).
- Websuche (Anthropic-Werkzeug `web_search`) ist in allen Specs an; Claude entscheidet, wann gesucht wird.
  LibreChat bucht nur die Tokens ab – das Gateway zählt die Suchen in den gespeicherten Antworten und bucht
  0,01 USD pro Suche vom Budget (`WEB_SEARCH_USD`), sichtbar im Dashboard als Modell `web_search`.

### 4.4 Login nur über das Gateway

`ALLOW_SOCIAL_LOGIN=true` (nötig für OIDC), `OPENID_AUTO_REDIRECT=true` → LibreChats Login-Seite leitet
sofort zum Gateway. `ALLOW_REGISTRATION=false`, `ALLOW_EMAIL_LOGIN=false`.
LibreChat legt den Benutzer beim ersten OIDC-Login automatisch an
(Zuordnung über `openidId` = `sub` des Gateways). `REFRESH_TOKEN_EXPIRY` = 90 Tage.

## 5. Dateiausgabe aller Typen (A8)

> **Umgesetzt (M2):** eigener Code-Runner `portal/code-runner/` statt ClickHouse/code-interpreter
> (der braucht `/dev/kvm` für sichere Isolation). Jede Ausführung in einem frischen Container ohne
> Netzwerk; die Tabelle unten beschreibt das ursprüngliche Konzept.

| Baustein                                          | Was er liefert                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Code-Interpreter** (selbst gehostet, Open Source: ClickHouse/code-interpreter) | Claude führt Python/Node/… in einer Sandbox aus; erzeugte Dateien erscheinen als **Download** im Chat (bis 10 je Lauf). Vorschau für PDF, PPTX, CSV, Text, Bilder. |
| **Skills** (LibreChat „Deployment Skills“, Ordner `./skill`) | Eigene Anleitungen für saubere **docx, xlsx, pptx, pdf**-Erzeugung (python-docx, openpyxl, python-pptx, reportlab) – Claude nutzt sie automatisch. |
| **Artifacts**                                     | HTML/React/Mermaid live im Chat (Vorschau, kein Download-Ersatz).                                      |
| **Media-Dienst** (§6.6)                           | Bilder, Audio, Video als Datei/Link.                                                                   |

- Agent-Capabilities: `execute_code`, `skills`, `artifacts`, `tools`, `file_search` (optional), `web_search` (optional).
- Sandbox-Image um Bibliotheken ergänzen: `python-docx openpyxl python-pptx reportlab pypdf matplotlib pandas pillow`.
- ⚠ Im PoC prüfen: Ressourcenbedarf und Sandbox-Anforderungen des Code-Interpreters (Docker-Rechte).
  Fallback: Code-Interpreter auf eigenem kleinen Hetzner-Server.

## 6. Portal-Gateway (Eigenentwicklung)

### 6.1 Technik

| Bereich        | Wahl                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| Sprache        | TypeScript, Node.js 22                                                                 |
| Server         | Fastify, `oidc-provider` (zertifizierte OIDC-Bibliothek), MongoDB-Treiber, zod          |
| Sicherheit     | argon2 (Passwörter), otplib (TOTP für Admin), `qrcode` (QR als SVG/PNG), Rate-Limits    |
| Admin-Oberfläche | React + Vite, Recharts für Diagramme, unter `/portal/admin`                           |
| Media          | MCP-Server (`@modelcontextprotocol/sdk`, Streamable HTTP) unter `/portal/mcp` (nur intern) |
| Tests          | Vitest (Unit + Integration gegen Mongo im Container)                                    |
| Betrieb        | eigenes Docker-Image, Service im selben Compose-Projekt wie LibreChat                   |

**Routen** (alles unter `/portal/`, damit nichts mit LibreChat kollidiert):

| Route                       | Zweck                                                     |
| --------------------------- | --------------------------------------------------------- |
| `/portal/join/:token`       | Einladung einlösen, Benutzernamen wählen                  |
| `/portal/l/:token`          | Login per QR-Code                                         |
| `/portal/oidc/*`            | OIDC-Endpunkte für LibreChat (Discovery, Auth, Token)     |
| `/portal/admin/*`           | Admin-Oberfläche + Admin-API                              |
| `/portal/files/:id`         | signierte Download-Links für Media- und 3D-Dateien        |
| `/portal/view/:id`          | interaktive 3D-Vorschau eines Modells (§6.7)              |
| `/portal/mcp`               | MCP für Media + CAD (nur aus dem Docker-Netz erreichbar, nicht über nginx) |

### 6.2 Gruppen & Einladungs-QR (A2, A3)

**Admin-Ablauf:**
1. Gruppe anlegen (Name, Standard-Budget pro Person in USD, z. B. 5 USD/Monat).
2. Einladung erzeugen: **max. Personen** (z. B. 3), **gültig von/bis** (z. B. heute 18:00 – 22:00),
   Startbudget, Monatsbudget.
3. Gateway zeigt **QR-Code + Link** (`https://ai.dev.a-b-cloud.de/portal/join/<token>`),
   Download als PNG/SVG und Druckansicht. Zähler „2 von 3 eingelöst“, jederzeit **widerrufbar**.

**Beitritt (Person scannt QR):**
1. Gateway prüft: Token gültig, nicht widerrufen, im Zeitfenster, noch Plätze frei.
2. Person wählt **Benutzernamen** (3–32 Zeichen, `a-z 0-9 . _ -`, eindeutig, Groß/klein egal).
3. **Atomar** einen Platz belegen (`findOneAndUpdate` mit Bedingung `uses < maxUses`) → keine
   Überbuchung, auch wenn mehrere gleichzeitig scannen.
4. Benutzer + Geräte-Sitzung (Cookie, 180 Tage) anlegen → Weiterleitung zu LibreChat → OIDC-Login
   läuft automatisch durch → LibreChat legt den Account an.
5. Gateway bucht das Startbudget (§6.4) und die Person kann sofort chatten.

Keine E-Mail-Adresse nötig: Das Gateway liefert LibreChat eine technische Adresse
`<benutzername>@users.ai.dev.a-b-cloud.de` (LibreChat verlangt ein E-Mail-Format), Anzeige­name = Benutzername.

### 6.3 Login-QR pro Benutzer (A4)

- Admin öffnet Benutzer → „Login-QR erstellen“: **gültig bis** (Standard 24 h), **einmalig** oder
  **n-mal**, optional Notiz („Tablet“). QR → `https://ai.dev.a-b-cloud.de/portal/l/<token>`.
- Scannen → neue Geräte-Sitzung → automatisch in LibreChat angemeldet. **Alle Chats, Dateien und
  Einstellungen** liegen auf dem Server und sind auf jedem Gerät da.
- Liste „Geräte“ pro Benutzer mit „abmelden“; Login-Links jederzeit widerrufbar.
- Optional (später): Benutzer kann selbst „Weiteres Gerät verbinden“ (QR aus der eigenen Sitzung).
- Admin-Login: Benutzername + Passwort (Entscheidung: keine Authenticator-App; TOTP optional per
  `ADMIN_TOTP=true`); Sperre nach 10 Fehlversuchen für 15 Min.; bekommt Admin-Rolle auch in LibreChat
  (`OPENID_ADMIN_ROLE`).
- **Benutzer mit Passwort:** Der Admin kann beim Anlegen oder später ein Passwort vergeben (Vorschlag wird
  erzeugt, mind. 10 Zeichen). Anmeldung dann mit Benutzername + Passwort auf der Anmeldeseite, die LibreChat
  ohne Gerätesitzung zeigt (`/portal/login`); der Login-QR funktioniert weiterhin.

### 6.4 Budgets in USD (A5)

| Aktion (Admin-UI)           | Technik                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Startbudget beim Beitritt   | `balances.tokenCredits += USD × 1.000.000` + `transactions`-Eintrag (`tokenType: credits`, `context: admin`) – wie LibreChats `add-balance` |
| **Limit erweitern** (+ X USD) | gleiche Buchung, sofort wirksam                                                          |
| Monatsbudget ändern         | Feld am Benutzer; gilt ab nächstem Reset                                                   |
| Monats-Reset                | Job im Gateway (stündlich): fällige Benutzer auf ihr Monatsbudget zurücksetzen, Buchung protokollieren |
| Sperren / Entsperren        | Gateway verweigert Login, Guthaben auf 0, LibreChat-Sitzungen des Benutzers löschen         |

- Alle Buchungen zusätzlich im Gateway-Protokoll (`budgetEvents`: wer, wann, wie viel, warum).
- Geschützt doppelt: LibreChat-Guthaben pro Person **und** Ausgabelimits bei Anthropic (Workspace)
  und OpenRouter (Key-Limit) als harte Obergrenze für alle zusammen.

### 6.5 Admin-Dashboard (A6)

Quelle: LibreChats `transactions` (pro Anfrage: Benutzer, Modell, Tokens Ein-/Ausgabe, Cache, Kosten,
Zeitpunkt, Art) + Media-Buchungen aus §6.6.

| Ansicht              | Inhalt                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Übersicht            | Kosten USD und Tokens heute / 7 Tage / Monat; Verlauf als Diagramm (Stunde/Tag/Woche)       |
| Nach Benutzer        | Tabelle: Benutzer, Gruppe, Budget, verbraucht, Rest, letzte Aktivität; Klick → Verlauf      |
| Nach Modell/Anbieter | Anteil Opus/Sonnet/Haiku/Media an Kosten und Tokens                               |
| Nach Gruppe          | Verbrauch je Gruppe und Einladung                                                           |
| Export               | CSV für beliebigen Zeitraum                                                                 |

- Umrechnung: USD = |tokenValue| / 1.000.000; Tokens = |rawAmount| (getrennt nach Eingabe, Ausgabe, Cache).
- MongoDB-Indizes auf `transactions(user, createdAt)` und `(createdAt)` für schnelle Auswertungen.
- Monatlicher Abgleich mit der Abrechnung von Anthropic/OpenRouter (Abweichung anzeigen).

### 6.6 Media-Dienst: Bild, Sprache, Video über OpenRouter (A9)

LibreChat kann über OpenRouter keine Bilder/Videos erzeugen → eigener **MCP-Server** im Gateway, den
Claude als Werkzeug nutzt („Erstelle ein Bild von …“).

| Werkzeug         | Funktion                                                     | Ergebnis im Chat                     |
| ---------------- | ------------------------------------------------------------ | ------------------------------------ |
| `generate_image` | Bild aus Text (OpenRouter-Bildmodell, wie im alten Portal)   | Bild direkt im Chat                  |
| `edit_image`     | hochgeladenes Bild verändern                                 | Bild direkt im Chat                  |
| `text_to_speech` | Text → Audio                                                 | Download-Link (MP3)                  |
| `generate_video` | Text/Bild → Video                                            | Download-Link (MP4), ggf. asynchron  |

- **Wer ruft auf?** LibreChat schickt pro Aufruf den Header `X-User-ID: {{LIBRECHAT_USER_ID}}` plus ein
  geheimes Token → das Gateway weiß, wessen Budget belastet wird.
- **Abrechnung:** Vorher Guthaben prüfen (geschätzte Kosten), nach dem Aufruf echte Kosten aus
  OpenRouters Antwort (`usage.cost`) als `transactions`-Eintrag abbuchen → alles in **einem** USD-Budget.
- Dateien im Gateway-Speicher, Download über signierte Links (gültig 7 Tage, nur für den Ersteller).
- Spracheingabe (Mikrofon): zunächst Browser-Spracherkennung; optional OpenAI-kompatibler STT-Proxy.
- ⚠ Im PoC prüfen: Welche Sprach-/Video-Modelle OpenRouter aktuell anbietet – Modelle und Parameter
  aus dem alten Portal übernehmen.

### 6.7 CAD-Dienst: technische 3D-Teile mit 3D-Vorschau (A12)

**Idee:** Claude beschreibt das Teil als **CAD-Code** (Python mit **build123d**, alternativ CadQuery) –
maßgenau in Millimetern, parametrisch, beliebig oft änderbar („Wand 2 mm dicker“, „Loch auf M4“).
Ein eigener, abgeschotteter **CAD-Runner** führt den Code aus und erzeugt Dateien + Vorschau.
Kosten: nur die Claude-Tokens, keine Gebühr pro Modell.

**Werkzeuge (im MCP-Server des Gateways):**

| Werkzeug        | Eingabe                                         | Ergebnis im Chat                                                                 |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `cad_build`     | CAD-Code, Name, gewünschte Formate              | **Vorschaubild** (4 Ansichten) direkt im Chat, Maße (B × T × H mm), Volumen, Link „**In 3D ansehen**“, Downloads |
| `cad_inspect`   | Modell-ID                                       | Maße, Volumen, Oberfläche, wasserdicht ja/nein, dünne Wände/Überhänge-Hinweis (3D-Druck) |
| `model_preview` | hochgeladene STL/3MF/STEP-Datei                 | Vorschaubild + Viewer-Link für vorhandene Modelle                                |

**Ausgabeformate:** **STL** (3D-Druck), **3MF** (3D-Druck mit Einheiten), **STEP** (Weiterbearbeitung in
Fusion/FreeCAD/SolidWorks), **GLB** (für den Viewer) und der **CAD-Quellcode** (`.py`) zum Nachbauen.

**3D-Viewer (`/portal/view/:id`):**
- three.js (STL-/3MF-/GLB-Loader), Drehen/Zoomen/Verschieben mit Maus und Touch (auch am Handy).
- Anzeige: Maße als Bounding-Box in mm, Raster in mm, Drahtgitter, Schnittansicht, Standardansichten
  (oben/vorne/seitlich/iso), Farbe/Material, Vollbild.
- **Versionen:** Jede Änderung im Chat erzeugt eine neue Version; im Viewer zwischen v1, v2, … wechseln.
- Download-Buttons für alle Formate. Zugriff nur für den Ersteller (Sitzung) bzw. per signiertem Link.
- Im PoC zusätzlich testen: Viewer **direkt im Chat** als LibreChat-Artifact einbetten
  (HTML mit three.js lädt GLB vom Gateway). Klappt das, erscheint die 3D-Ansicht ohne Klick im Chat;
  sonst bleibt es beim Vorschaubild + Link.

**Ablauf:**
```
Nutzer: „Halterung für ein 25-mm-Rohr, 3 mm Wand, zwei M4-Schraublöcher“
  → Claude schreibt build123d-Code → cad_build(code, formats=[stl, step, 3mf])
  → CAD-Runner: Code ausführen (Timeout 60 s) → Export STL/STEP/3MF/GLB → Vorschaubilder rendern
  → Gateway speichert Version, liefert Bild + Maße + Viewer-Link + Downloads an den Chat
Nutzer: „Löcher auf M5 und 10 mm höher“ → Claude ändert Parameter → neue Version
```

**CAD-Runner (eigener Container):**
- Image mit Python, build123d, CadQuery, OCP/OpenCascade, trimesh, numpy, pyrender/OSMesa (Rendern ohne GPU).
- **Abschottung:** kein Netzwerk, Nur-Lese-Dateisystem außer `/out`, nicht-root, CPU 2 / RAM 2 GB / 60 s
  pro Auftrag, max. 2 Aufträge gleichzeitig, Ausgabe max. 100 MB. Code wird vor dem Start nicht
  vertraut – die Sandbox ist die Sicherheitsgrenze.
- Gateway ↔ Runner über interne Warteschlange (einfacher HTTP-Job-Endpunkt im Docker-Netz).

**Skill „CAD für 3D-Druck“** (LibreChat Deployment Skill): Anleitung für Claude – build123d-Muster,
Einheiten mm, Toleranzen für FDM (z. B. +0,2 mm bei Passungen), Mindestwandstärke, Druckausrichtung,
Gewinde/Senkungen, immer parametrisch mit benannten Variablen oben im Code.

### 6.8 Datenmodell (DB „portal“)

```text
admins        { _id, username, passwordHash, totpSecret, createdAt }
groups        { _id, name, defaultMonthlyBudgetUsd, createdAt }
invites       { _id, groupId, tokenHash, maxUses, uses, validFrom, validUntil,
                startBudgetUsd, monthlyBudgetUsd, revokedAt, createdBy, createdAt }
users         { _id (= OIDC sub), username (unique), groupId, inviteId, librechatUserId,
                status: active|blocked, monthlyBudgetUsd, nextResetAt, createdAt }
loginLinks    { _id, userId, tokenHash, maxUses, uses, expiresAt, note, revokedAt, createdAt }
devices       { _id, userId, createdAt, lastSeenAt, userAgent, revokedAt }
budgetEvents  { _id, userId, type: start|topup|reset|block|media, amountUsd, by, at, note }
mediaFiles    { _id, userId, kind, model, costUsd, path, mime, size, expiresAt }
cadModels     { _id, userId, conversationId, name, createdAt }
cadVersions   { _id, modelId, version, code, status: ok|error, error, bbox, volumeMm3,
                files: { stl, step, threemf, glb, previewPng }, createdAt }
```

Tokens (Einladung, Login) sind 128 Bit zufällig und werden **nur gehasht** gespeichert.

### 6.9 Sicherheit

- QR-Codes sind Zugangsschlüssel → kurze Laufzeit, Einmal-Nutzung als Standard, Widerruf, Hinweis im UI.
- Rate-Limits auf `/portal/join`, `/portal/l`, Admin-Login; Benutzernamen-Sperrliste (admin, root …).
- Admin-API nur mit Admin-Sitzung + CSRF-Schutz; Audit-Log aller Admin-Aktionen.
- MongoDB, Code-Interpreter, CAD-Runner und MCP nur im Docker-Netz; öffentlich ist ausschließlich nginx.
- CAD-Runner ohne Netzwerkzugang, mit Ressourcen- und Zeitlimits (§6.7).
- Umgesetzt in M8 (nach Sicherheitsprüfung des Codes):
  - Client-IP nur aus dem von nginx angehängten Eintrag (gefälschte `X-Forwarded-For` hebeln Rate-Limits nicht aus).
  - Passwort-Login: Sperre pro Account nach 10 Fehlversuchen (15 Min.); bei aktiviertem TOTP jeder Code nur einmal.
  - Login-Links werden erst per Knopfdruck eingelöst (Link-Vorschauen in Messengern verbrauchen sie nicht).
  - Abmelden mit CSRF-Schutz beendet die Gerätesitzung serverseitig.
  - 3D-Viewer: Modelldaten aus der Sandbox werden streng geprüft, Seite mit Content-Security-Policy.
  - Code-Runner liest Sandbox-Ausgaben nie über Symlinks, mit Größenlimit; Container-Logs auf 1 MB begrenzt.
  - Code-Runner nur im internen Docker-Netz `code` (nur LibreChat und Gateway).
  - Media-Kosten werden vor dem Aufruf atomar reserviert (parallele Anfragen können das Budget nicht überziehen),
    höchstens 2 laufende Videos pro Person.
  - CSV-Export entschärft Excel-Formeln.

## 7. Server & Betrieb

- **Größe:** Mit Code-Interpreter mind. 8 vCPU / 16 GB RAM / 160 GB SSD empfohlen
  (aktuelle Servergröße in Phase 0 prüfen).
- **Backup:** täglich `mongodump` (beide DBs) + Uploads + Media-Dateien + Config → Hetzner Storage Box;
  Restore-Test vor Go-live.
- **Updates:** LibreChat-Image-Tag pinnen, monatlich auf Testinstanz prüfen, dann aktualisieren.
- **Monitoring:** Uptime-Check, Gateway-Health `/portal/health`, Warnung wenn Tageskosten > Schwelle.
- ⚠ **Gateway = kritischer Dienst:** Ist der MCP-Server nicht erreichbar, lehnt LibreChat alle Chats ab
  (in M1 getestet). Daher `restart: always`, Health-Check und Alarm.
- **Recht:** Hinweis-Modal (Daten gehen an Anthropic/OpenRouter), Anthropic-DPA, Hetzner-AVV,
  Impressum/Datenschutz verlinkt.

## 8. Umsetzung in Meilensteinen

| M  | Inhalt                                                                                                   | Aufwand  | Fertig, wenn …                                                                 |
| -- | -------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| M0 | Bestandsaufnahme: Ports, Servergröße, alte App sichern, OpenRouter-Modelle der alten App notieren        | 0,5 Tag  | Backup + Notizen liegen vor, Ports festgelegt                                  |
| M1 | LibreChat-Basis: Compose, nginx (Testpfad), Anthropic, Model-Specs (nur Claude), Guthaben-Anzeige        | 1 Tag    | Chat mit Opus 5.5/medium läuft, Effort wählbar, Kosten werden gebucht          |
| M2 | Code-Interpreter + Skills für docx/xlsx/pptx/pdf                                                          | 1–2 Tage | Claude erzeugt alle vier Formate als Download                                  |
| M3 | Gateway-Kern: OIDC-IdP, Admin-Login mit TOTP, Benutzer, Login-QR, Geräte                                  | 3–4 Tage | Login per QR auf zweitem Gerät zeigt dieselben Chats                           |
| M4 | Gruppen + Einladungs-QR (Anzahl, Zeitfenster, Benutzername)                                               | 2 Tage   | QR für 3 Personen: 3 Beitritte klappen, der 4. und nach Ablauf wird abgelehnt  |
| M5 | Budgets: Start, Aufladen, Monats-Reset, Sperren                                                           | 1–2 Tage | leeres Budget blockiert, Aufladen schaltet sofort frei                         |
| M6 | Admin-Dashboard (USD/Tokens, Benutzer/Modell/Gruppe, CSV)                                                 | 2–3 Tage | Zahlen stimmen mit Stichprobe aus `transactions` und Anthropic-Console überein |
| M7 | Media-Dienst (Bild, Sprache, Video via OpenRouter) inkl. Abrechnung                                       | 2–3 Tage | Bild im Chat, Kosten im Budget und Dashboard sichtbar                          |
| M7b | CAD-Dienst: CAD-Runner, `cad_build`/`cad_inspect`/`model_preview`, 3D-Viewer mit Versionen, CAD-Skill | 3–4 Tage | „Halterung …“ ergibt STL/STEP/3MF mit korrekten Maßen, Viewer läuft am Handy |
| M8 | Härtung, Tests, Backup/Restore, Umschalten auf `ai.dev.a-b-cloud.de`, altes Portal stoppen               | 1–2 Tage | Checkliste §9 vollständig                                                       |

**Gesamt: ca. 17–24 Arbeitstage.** M1–M2 liefern schon ein nutzbares System (Accounts per CLI),
M3–M5 ersetzen dann CLI durch QR-Codes, M6–M7 runden ab.

**Rollback** jederzeit: neue Compose stoppen, alte starten (beide nutzen Port 45012) – siehe [GO-LIVE.md](GO-LIVE.md).

## 9. Abnahme-Checkliste

- [ ] Ports 3000/3080/45012/45443/27017 von außen **nicht** erreichbar
- [ ] Standard-Modell Opus 5.5 / medium; Wechsel auf Sonnet/Haiku und Effort; keine OpenRouter-Modelle im Chat sichtbar `high` funktioniert
- [ ] Upload: Bild, PDF, Word, Excel; Ausgabe: docx, xlsx, pptx, pdf, csv, zip, Bild
- [ ] Einladungs-QR: Limit Personen + Zeitfenster greifen, Widerruf greift
- [ ] Login-QR: einmalig, Ablauf, Widerruf, Geräteliste
- [ ] Budget: leer → blockiert; +5 USD → sofort frei; Monats-Reset korrekt
- [ ] Dashboard-Summen = Anthropic-/OpenRouter-Abrechnung (±2 %)
- [ ] Media: Bild/Audio/Video werden erzeugt und abgebucht
- [ ] 3D: Teil mit Maßvorgabe → STL/3MF/STEP stimmen (Maße im Slicer geprüft), Viewer zeigt Maße und Versionen
- [ ] CAD-Runner: Code mit Netzwerkzugriff/Endlosschleife wird blockiert bzw. nach 60 s abgebrochen
- [ ] Fable ist im Chat nicht auswählbar
- [ ] Backup + Restore getestet, Monitoring aktiv (Restore lokal getestet ✅, Skripte: [GO-LIVE.md](GO-LIVE.md))

## 10. Offene Punkte

1. ~~Docker-Port~~ → aus der alten Compose: 45012 (portal-nginx übernimmt ihn).
2. Wo soll der Gateway-Code liegen: eigenes Repository (empfohlen) oder Ordner in diesem Repo?
3. Standardbudgets: pro Person z. B. 5 USD/Monat? Reset monatlich zum 1. oder 30 Tage ab Beitritt?
4. ~~Media-Modelle~~ → Bild/Sprache/Video vorerst aus (fertig gebaut und getestet, einschaltbar mit `MEDIA_ENABLED=true`).
5. ~~Websuche~~ → entschieden: Anthropic-Websuche an, 0,01 USD pro Suche vom Budget.
6. ~~3D-Drucker/Slicer~~ → Slicen macht der Admin selbst; der CAD-Skill bleibt bei allgemeinen FDM-Regeln.

Code und Konfiguration: [`portal/`](../portal/) · Fortschritt: [`PORTAL-PROGRESS.md`](PORTAL-PROGRESS.md) · Inbetriebnahme: [`GO-LIVE.md`](GO-LIVE.md)
