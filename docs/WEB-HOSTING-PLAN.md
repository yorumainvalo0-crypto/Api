# Plan: LibreChat ersetzt das A-B Cloud AI Portal (ai.dev.a-b-cloud.de)

Ziel: Das bestehende **A-B Cloud AI Portal** auf `ai.dev.a-b-cloud.de` wird durch **LibreChat**
ersetzt – eine Claude.ai-ähnliche Oberfläche über die **Anthropic API**, mit Accounts,
Datei-Upload und Budget-Limits pro Person. Zielgruppe: Team/Freunde (bis ca. 20 Personen),
kostenlos, der Admin vergibt die Budgets.

Fertige Konfiguration: [`deploy/librechat/`](../deploy/librechat/)

| Datei                                   | Zweck                                                     |
| --------------------------------------- | --------------------------------------------------------- |
| `env.production.example`                | Werte für LibreChats `.env` (Domain, Claude-Key, Limits)  |
| `librechat.yaml`                        | Guthaben pro User, Datei-Limits, Nutzungsbedingungen      |
| `docker-compose.override.yml`           | Ports nur auf `127.0.0.1`, Config einbinden               |
| `nginx/ai.dev.a-b-cloud.de.conf`        | Reverse Proxy 443 → `127.0.0.1:3080`, Streaming, Uploads  |
| `scripts/backup.sh`                     | Tägliches Backup (MongoDB + Uploads + Config)             |

---

## 1. Ist-Zustand (geprüft am 19.10.2026)

- `ai.dev.a-b-cloud.de` → **88.99.138.164** (Hetzner).
- **nginx** auf Port **443** (HTTPS, HTTP/2), Port **80** leitet per 301 auf HTTPS um.
- Dahinter: „A-B Cloud AI Portal“ (React-SPA + eigene API: Login, Benutzerverwaltung,
  API-Keys/Credits, Chats, Bild-/Sprach-/Video-Generierung).
- Interner Port der alten App: von außen nicht sichtbar → auf dem Server prüfen (Phase 0).

## 2. Ziel-Architektur

```
Browser ──443──▶ nginx (bestehend, Let's Encrypt)
                   │  proxy_pass 127.0.0.1:3080
                   ▼
               LibreChat (Docker) ──▶ Anthropic API
                   │
       ┌───────────┼────────────┬──────────────────────┐
       ▼           ▼            ▼                      ▼
    MongoDB    Meilisearch   Admin-Panel          RAG-API + pgvector
                             (127.0.0.1:3000,     (optional, braucht
                              nur per SSH-Tunnel)  Embedding-Anbieter)
```

Wichtig: Docker umgeht `ufw`. Deshalb bindet `docker-compose.override.yml` alle Ports an
`127.0.0.1` – öffentlich ist nur nginx.

## 3. Phasen

### Phase 0 – Bestandsaufnahme & Backup der alten App (≈ 30 min)

```bash
sudo ss -tlnp                                   # which process listens on which port
grep -R "proxy_pass" /etc/nginx/sites-enabled/  # where nginx sends ai.dev.a-b-cloud.de
docker ps; systemctl list-units --type=service | grep -iE "node|pm2|portal"
```

- Alte App, deren Datenbank und die nginx-Site-Datei sichern (für Rollback).
- Benutzerliste der alten App exportieren (Namen/E-Mails) – Passwörter lassen sich nicht
  übernehmen, die Accounts werden in LibreChat neu angelegt.
- Prüfen, ob Ports **3000** oder **3080** schon belegt sind (sonst in der Override-Datei ändern).

### Phase 1 – Server-Basis (≈ 30 min, falls noch nicht vorhanden)

- SSH nur mit Key, Hetzner-Firewall: 22 (eigene IP), 80, 443.
- `fail2ban`, `unattended-upgrades`, Docker + Compose-Plugin (≥ v2.24).
- Anthropic Console: eigener Workspace, API-Key, **monatliches Ausgabelimit** setzen.

### Phase 2 – LibreChat parallel aufsetzen (≈ 1 h)

```bash
sudo git clone https://github.com/danny-avila/LibreChat.git /opt/LibreChat
sudo chown -R $USER: /opt/LibreChat && cd /opt/LibreChat
cp .env.example .env            # then set the values from env.production.example
cp <repo>/deploy/librechat/librechat.yaml .
cp <repo>/deploy/librechat/docker-compose.override.yml .
cp <repo>/deploy/librechat/scripts/backup.sh . && chmod +x backup.sh
docker compose up -d
curl -I http://127.0.0.1:3080   # must answer before nginx is switched
```

Die alte App läuft in dieser Phase noch weiter.

### Phase 3 – Umschalten (≈ 15 min, kurze Downtime)

```bash
sudo cp /etc/nginx/sites-available/ai.dev.a-b-cloud.de{,.old-portal}
sudo cp <repo>/deploy/librechat/nginx/ai.dev.a-b-cloud.de.conf /etc/nginx/sites-available/ai.dev.a-b-cloud.de
sudo nginx -t && sudo systemctl reload nginx
# then stop the old app (docker stop / systemctl stop / pm2 stop)
```

Zertifikatspfade aus der alten Site-Datei übernehmen, falls sie abweichen.
**Rollback:** `.old-portal`-Datei zurückkopieren, `nginx -s reload`, alte App starten.

### Phase 4 – Accounts & Limits (≈ 30 min)

```bash
cd /opt/LibreChat
docker compose exec api npm run create-user                         # per person
docker compose exec api npm run set-balance user@example.de 10000000 # 10 USD
docker compose exec api npm run list-balances
```

- Den ersten Account als Admin anlegen. Admin-Panel per Tunnel:
  `ssh -L 3000:127.0.0.1:3000 <server>` → `http://localhost:3000`.
- Drei Schutzebenen fürs Budget:
  1. **Guthaben pro User** (`balance`: 5 USD Start, monatlich zurückgesetzt auf 5 USD)
  2. **Rate-Limit pro User** (`MESSAGE_USER_MAX=40` pro Minute)
  3. **Workspace-Limit** in der Anthropic Console (harte Obergrenze für alle)

### Phase 5 – Datei-Upload testen (≈ 30 min)

- Bilder und PDFs gehen direkt an Claude (bis 10 Dateien, 20 MB je Datei, 50 MB je Nachricht).
- **Optional RAG** (Suche über viele große Dokumente): braucht einen Embedding-Anbieter
  (OpenAI, Voyage AI oder lokal Ollama), danach `interface.fileSearch: true`.

### Phase 6 – Betrieb

- **Backup:** Cron `30 3 * * * /opt/LibreChat/backup.sh`; Backups zusätzlich in eine
  Hetzner Storage Box kopieren; Restore einmal testen (`mongorestore --archive --gzip`).
- **Updates:** monatlich Backup → `git pull && docker compose pull && docker compose up -d`.
  Nach dem ersten erfolgreichen Test den Image-Tag in der Override-Datei fest pinnen.
- **Monitoring:** Uptime-Check auf `https://ai.dev.a-b-cloud.de`, Kosten wöchentlich in der
  Anthropic Console prüfen.

### Phase 7 – Recht & Datenschutz

- Nutzer informieren, dass Inhalte an Anthropic (USA) gehen (Modal in `librechat.yaml`).
- Anthropic-DPA (Commercial Terms) und Hetzner-AVV.
- Bei öffentlich erreichbarer Seite: Impressum + Datenschutzerklärung verlinken
  (`interface.privacyPolicy` in `librechat.yaml`).

## 4. Was wegfällt

Die alte App hatte Bild-, Sprach- und Video-Generierung. LibreChat mit nur Claude kann das
nicht (Claude erzeugt keine Bilder/Videos). Falls benötigt: später einen weiteren Anbieter
(z. B. OpenRouter) als Endpoint ergänzen.

## 5. Checkliste

- [ ] Phase 0: Ports, alte App, nginx-Site gesichert; Benutzerliste exportiert
- [ ] Anthropic-Workspace, API-Key, Ausgabelimit
- [ ] `.env` mit eigenen Secrets, `librechat.yaml`, Override-Datei
- [ ] LibreChat antwortet auf `127.0.0.1:3080`
- [ ] nginx umgestellt, `nginx -t` ok, alte App gestoppt
- [ ] Ports 3000/3080 von außen **nicht** erreichbar
- [ ] Admin-Account + Nutzer angelegt, Guthaben geprüft, Test mit leerem Guthaben
- [ ] Upload getestet (Bild, PDF, Textdatei)
- [ ] Backup-Cron aktiv, Restore getestet

## 6. Offene Punkte

- Budget pro Person (Vorschlag: 5 USD/Monat) – Opus für alle oder nur einzelne?
- RAG ja/nein und Embedding-Anbieter.
- SMTP für Passwort-Reset.
