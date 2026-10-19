# Go-live: A-B Cloud AI Portal auf `ai.dev.a-b-cloud.de`

Das neue Portal ist **ein Ordner** (`ai-portal-neu`) mit eigener Docker Compose und einem Startbefehl.
Wie das alte Portal hört es auf `127.0.0.1:45012`; der nginx des Servers (TLS auf 443) leitet die Domain
schon dorthin – er bleibt unverändert. `start.sh` stoppt das alte Portal und übernimmt den Port
(ca. 1 Minute Ausfall); `rollback.sh` schaltet zurück.

Plan: [`WEB-HOSTING-PLAN.md`](WEB-HOSTING-PLAN.md) · Fortschritt: [`PORTAL-PROGRESS.md`](PORTAL-PROGRESS.md)

## 1. Vorher kurz prüfen (2 Minuten)

```bash
docker compose version                               # Docker Compose v2 ist da
grep -rln '45012' /etc/nginx/sites-enabled/          # Site-Datei des Server-nginx
grep -nE 'proxy_pass|client_max_body_size|X-Forwarded-For|proxy_buffering|proxy_read_timeout' \
  /etc/nginx/sites-enabled/<site-datei>
df -h /                                              # mind. 20 GB frei
```

Die Site muss `proxy_pass http://127.0.0.1:45012` haben und **`X-Forwarded-For`** setzen. Fehlen
`client_max_body_size 60M`, `proxy_buffering off` oder `proxy_read_timeout 600s` (Uploads, gestreamte
Antworten), die Zeilen aus `nginx/ai.dev.a-b-cloud.de.conf` (im Ordner) ergänzen und
`nginx -t && systemctl reload nginx` – schadet dem alten Portal nicht.

Anthropic Console: **Websuche für die Organisation erlauben** und ein monatliches Ausgabenlimit setzen.

## 2. Hochladen und starten

Vom eigenen Rechner:

```bash
scp ai-portal-neu.tar.gz root@88.99.138.164:/root/
```

Auf dem Server:

```bash
tar xzf /root/ai-portal-neu.tar.gz -C /opt
/opt/ai-portal-neu/start.sh
```

`start.sh` …
1. fragt beim ersten Mal **Anthropic-API-Key**, **Admin-Benutzername** und **Admin-Passwort**
   (mind. 12 Zeichen) und erzeugt alle Geheimnisse (`librechat.env`, `portal-gateway.env`, `.env`, Rechte 600),
2. baut die Portal-Images (beim ersten Mal 10–20 Minuten) und startet Datenbank, Chat, Gateway, Code-Runner,
3. findet das alte Portal auf Port 45012 und fragt: **„Altes Portal jetzt stoppen und auf das neue umschalten?“**
   → `ja` stoppt es (Container und Daten bleiben erhalten) und startet den Eingang des neuen,
4. prüft, dass Chat und Portal antworten, und zeigt die Adressen.

## 3. Erster Admin-Login

1. `https://ai.dev.a-b-cloud.de/portal/admin/login` – Benutzername + Passwort aus Schritt 2.
2. Danach das Passwort aus der Datei entfernen (wird nur beim allerersten Start gebraucht):
   `cd /opt/ai-portal-neu && sed -i '/^PORTAL_ADMIN_PASSWORD=/d' portal-gateway.env && docker compose up -d portal-gateway`
3. Passwort ändern: im Admin-Bereich auf deiner Benutzerseite (Karte „Passwort“).

> Das Passwort ist der einzige Schutz des Admin-Bereichs: lang und nur hier verwenden. Nach 10 Fehlversuchen
> ist der Account 15 Minuten gesperrt. Optional: zweiter Faktor mit `ADMIN_TOTP=true` in `portal-gateway.env`.

## 4. Smoke-Test (ca. 15 Min.)

- [ ] Gruppe anlegen, Einladung für 1 Person / 1 Stunde → QR mit dem Handy scannen, Benutzernamen wählen
- [ ] Im Chat: Opus 5.5 / mittel ist vorausgewählt, Antwort kommt; Guthaben sinkt
- [ ] PDF hochladen und zusammenfassen lassen; Excel-Datei erzeugen und herunterladen
- [ ] „Wie ist das Wetter heute in Berlin?“ → Websuche, 0,01 USD im Dashboard (`/portal/admin/usage`)
- [ ] „Halterung 60 × 40 × 10 mm mit zwei 8-mm-Löchern“ → 3D-Ansicht am Handy, STL-Download
- [ ] Benutzer mit Passwort anlegen → auf einem anderen Gerät mit Benutzername + Passwort anmelden
- [ ] Von außen nicht erreichbar: `curl -m5 http://88.99.138.164:45012`, `:45443`, `:27017`
- [ ] `curl -s -o /dev/null -w '%{http_code}' -X POST https://ai.dev.a-b-cloud.de/portal/mcp` → `404`

## 5. Betrieb einrichten

```bash
crontab -e
# Backup täglich 03:30 (beide Datenbanken, Uploads, Dateien, Einstellungen), 14 Tage aufbewahren
30 3 * * * /opt/ai-portal-neu/scripts/backup.sh >> /var/log/portal-backup.log 2>&1
# Erreichbarkeit alle 5 Minuten, Alarm per ntfy o. ä. (optional ALERT_URL setzen)
*/5 * * * * ALERT_URL=https://ntfy.sh/<geheimes-thema> /opt/ai-portal-neu/scripts/healthcheck.sh >> /var/log/portal-health.log 2>&1
```

- Backups liegen in `/var/backups/portal`; Kopie auf eine Storage Box mit
  `BACKUP_REMOTE=u123456@u123456.your-storagebox.de:portal-backups` vor dem Befehl.
- Restore: `docker compose stop api portal-gateway && scripts/restore.sh <STAMP>` → `docker compose up -d`.
- Bild/Sprache/Video später einschalten: in `portal-gateway.env` `MEDIA_ENABLED=true` und
  `OPENROUTER_API_KEY=…` setzen, `docker compose up -d portal-gateway`; bei OpenRouter ein Key-Limit setzen.

## Zurück zum alten Portal

```bash
/opt/ai-portal-neu/rollback.sh     # stoppt das neue, startet das alte (Daten beider bleiben)
/opt/ai-portal-neu/start.sh        # später wieder umschalten
```

Das alte Portal endgültig entfernen, wenn alles läuft (nach ein paar Tagen): im alten Ordner
`docker compose down` (ohne `-v`, dann bleibt dessen Daten-Volume). Konten und Chats des alten Portals
werden nicht übernommen (andere Software).

## Updates

Neues `ai-portal-neu.tar.gz` hochladen, wieder nach `/opt` entpacken und `./start.sh` ausführen.
Einstellungen (`librechat.env`, `portal-gateway.env`) und Daten (`data/`, `uploads/`, `images/`) bleiben.
Neue LibreChat-Version: erst im Test-Stack prüfen (`portal/test-stack`, alle E2E-Tests grün), dann den
Image-Tag in `docker-compose.yml` ändern.
