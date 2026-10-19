# Go-live: A-B Cloud AI Portal auf `ai.dev.a-b-cloud.de`

Schritt-für-Schritt-Anleitung für den Umzug vom alten Portal auf LibreChat + Portal-Gateway
(Plan: [`WEB-HOSTING-PLAN.md`](WEB-HOSTING-PLAN.md), Fortschritt: [`PORTAL-PROGRESS.md`](PORTAL-PROGRESS.md)).
Alle Befehle als `root` auf dem Server (88.99.138.164). Dauer: ca. 1–2 Stunden plus Smoke-Test.

> Platzhalter: `<LC_PORT>` = `LIBRECHAT_HOST_PORT`, `<GW_PORT>` = `PORTAL_HOST_PORT` (Docker-Ports vom Admin).

## 0. Voraussetzungen

- Docker Engine + **Docker Compose v2.24+** (`docker compose version`)
- `inventory.sh` wurde ausgeführt, Ausgabe liegt vor (Ports, alte App, freier Speicher):
  `sudo bash portal/deploy/scripts/inventory.sh > /root/inventory.txt`
- Anthropic-API-Key, OpenRouter-Key (nur Bild/Sprache/Video), Admin-Benutzername + Passwort (≥ 12 Zeichen)
- Empfohlen: 8 vCPU / 16 GB RAM, ≥ 40 GB frei (Images ca. 6 GB)

## 1. Altes Portal sichern

```bash
mkdir -p /root/old-portal
cp -a /etc/nginx/sites-available/ai.dev.a-b-cloud.de* /root/old-portal/   # Name laut inventory.txt
# alte App-Daten/Compose-Datei laut inventory.txt ebenfalls nach /root/old-portal sichern
```

Das alte Portal läuft weiter, bis Schritt 7 nginx umstellt.

## 2. Code holen

```bash
# dieses Repository (privat: mit Deploy-Key/Token); Branch, bis er nach main gemergt ist
git clone --branch ccr-19153869-nd6ntm https://github.com/yorumainvalo0-crypto/Api /opt/portal
git clone --depth 1 --branch v0.8.8 https://github.com/danny-avila/LibreChat /opt/LibreChat
```

LibreChat **v0.8.8** ist die getestete Version (Image-Tag in der Override-Datei fest gepinnt).

## 3. Datenverzeichnisse

```bash
mkdir -p /opt/portal-data/{media,code-work,code-store} /var/backups/portal
chown 1000:1000 /opt/portal-data/media          # Gateway läuft als uid 1000
chmod 700 /var/backups/portal
```

Empfohlen: Code-Ausführungen auf ein eigenes, begrenztes Dateisystem legen, damit ein Programm
nicht die ganze Platte füllen kann:

```bash
fallocate -l 20G /opt/portal-data/code-work.img
mkfs.ext4 -q /opt/portal-data/code-work.img
echo '/opt/portal-data/code-work.img /opt/portal-data/code-work ext4 loop,nodev,nosuid 0 2' >> /etc/fstab
mount /opt/portal-data/code-work
```

## 4. Images bauen

```bash
bash /opt/portal/portal/deploy/scripts/build-images.sh    # sandbox, cad-sandbox, code-runner, gateway (:latest)
```

## 5. Konfiguration

```bash
cd /opt/LibreChat
cp /opt/portal/portal/deploy/librechat.yaml .
cp /opt/portal/portal/deploy/docker-compose.override.yml .
cp -r /opt/portal/portal/deploy/skill .

# Schlüssel nicht in die Shell-History schreiben:
read -rsp 'Anthropic-Key: ' ANTHROPIC_API_KEY; echo
read -rsp 'OpenRouter-Key: ' OPENROUTER_API_KEY; echo
read -rsp 'Admin-Passwort: ' PORTAL_ADMIN_PASSWORD; echo
export ANTHROPIC_API_KEY OPENROUTER_API_KEY PORTAL_ADMIN_PASSWORD
LIBRECHAT_HOST_PORT=<LC_PORT> PORTAL_HOST_PORT=<GW_PORT> PORTAL_ADMIN_USERNAME=<admin> \
  python3 /opt/portal/portal/deploy/scripts/setup-env.py
```

`setup-env.py` schreibt `.env` und `portal-gateway.env` (Rechte 600) mit frischen, zueinander
passenden Geheimnissen. Es meldet, falls noch ein `REPLACE_ME` übrig ist.

## 6. Starten und prüfen

```bash
cd /opt/LibreChat
docker compose up -d
docker compose ps                                  # alle Dienste "running", Gateway "healthy"
curl -s http://127.0.0.1:<LC_PORT>/health          # OK
curl -s http://127.0.0.1:<GW_PORT>/portal/health   # {"ok":true}
```

## 7. nginx umstellen

```bash
cp /opt/portal/portal/deploy/nginx/ai.dev.a-b-cloud.de.conf /etc/nginx/sites-available/ai.dev.a-b-cloud.de
sed -i 's/LIBRECHAT_HOST_PORT/<LC_PORT>/; s/PORTAL_HOST_PORT/<GW_PORT>/' /etc/nginx/sites-available/ai.dev.a-b-cloud.de
grep -n 'HOST_PORT' /etc/nginx/sites-available/ai.dev.a-b-cloud.de   # darf nichts finden
nginx -t && systemctl reload nginx
```

Die Sicherung des alten Site-Files bleibt in `/root/old-portal` (nicht in `sites-enabled`, sonst lädt
nginx beide). Das TLS-Zertifikat (Let's Encrypt) wird weiterverwendet.

## 8. Erster Admin-Login

1. `https://ai.dev.a-b-cloud.de/portal/admin/login` öffnen, Benutzername + Passwort (aus Schritt 5).
2. Danach das Passwort aus `portal-gateway.env` entfernen (wird nur beim allerersten Start gebraucht):
   `sed -i '/^PORTAL_ADMIN_PASSWORD=/d' portal-gateway.env && docker compose up -d portal-gateway`
3. Passwort ändern geht im Admin-Bereich auf deiner eigenen Benutzerseite (Karte „Passwort“).

> Das Passwort ist der einzige Schutz des Admin-Bereichs: lang und nur hier verwenden.
> Nach 10 Fehlversuchen ist der Account 15 Minuten gesperrt. Optional lässt sich ein zweiter Faktor
> (Authenticator-App) mit `ADMIN_TOTP=true` in `portal-gateway.env` einschalten.

## 9. Smoke-Test (ca. 15 Min.)

- [ ] Gruppe anlegen, Einladung für 1 Person / 1 Stunde → QR mit dem Handy scannen, Benutzernamen wählen
- [ ] Im Chat: Opus 5.5 / mittel ist vorausgewählt, Antwort kommt; Guthaben sinkt
- [ ] PDF hochladen und zusammenfassen lassen; Excel-Datei erzeugen und herunterladen
- [ ] „Erstelle ein Bild …“ → Bild im Chat, Kosten im Dashboard (`/portal/admin/usage`)
- [ ] „Halterung 60 × 40 × 10 mm mit zwei 8-mm-Löchern“ → 3D-Ansicht am Handy, STL-Download
- [ ] Login-QR für die Testperson auf einem zweiten Gerät → gleiche Chats sichtbar
- [ ] Von außen nicht erreichbar: `curl -m5 http://88.99.138.164:<LC_PORT>` und `:<GW_PORT>`, `:27017`, `:3000`
- [ ] `curl -s -o /dev/null -w '%{http_code}' -X POST https://ai.dev.a-b-cloud.de/portal/mcp` → `404`

## 10. Betrieb einrichten

```bash
crontab -e
# Backup täglich 03:30 (beide Datenbanken, Uploads, Media, Konfiguration), 14 Tage aufbewahren
30 3 * * * BACKUP_REMOTE=u123456@u123456.your-storagebox.de:portal-backups /opt/portal/portal/deploy/scripts/backup.sh >> /var/log/portal-backup.log 2>&1
# Erreichbarkeit alle 5 Minuten, Alarm per ntfy o. ä.
*/5 * * * * ALERT_URL=https://ntfy.sh/<geheimes-thema> /opt/portal/portal/deploy/scripts/healthcheck.sh >> /var/log/portal-health.log 2>&1
```

- Backup einmal von Hand starten und prüfen: `ls -lh /var/backups/portal`
- Restore (getestet): `docker compose stop api portal-gateway && restore.sh <STAMP>` → `docker compose up -d`
- **Anthropic Console:** monatliches Ausgabenlimit setzen; **Websuche für die Organisation erlauben**
  (sonst lehnt die API Anfragen mit Websuche ab – im Smoke-Test „Wie ist das Wetter heute in Berlin?“ fragen).
- **OpenRouter:** Guthaben-/Key-Limit setzen (Bild/Sprache/Video).

## 11. Altes Portal stoppen

Nach ein paar Tagen ohne Probleme: alte App stoppen (laut `inventory.txt`), Sicherung in
`/root/old-portal` noch 30 Tage aufheben.

## Rollback

```bash
cp /root/old-portal/ai.dev.a-b-cloud.de /etc/nginx/sites-available/ai.dev.a-b-cloud.de
nginx -t && systemctl reload nginx          # altes Portal ist sofort wieder online
cd /opt/LibreChat && docker compose stop    # neues Portal anhalten (Daten bleiben erhalten)
```

## Updates

1. Neue LibreChat-Version zuerst im Test-Stack prüfen (`portal/test-stack`, alle E2E-Tests grün).
2. Tag in `docker-compose.override.yml` ändern, Backup machen, `docker compose pull && docker compose up -d`.
3. Portal-Code: `cd /opt/portal && git pull && bash portal/deploy/scripts/build-images.sh && cd /opt/LibreChat && docker compose up -d`.
