# Plan: Claude-Weboberfläche auf Hetzner (LibreChat)

Ziel: Eine eigene, Claude.ai-ähnliche Website auf einem Hetzner-Server, über die ein kleiner
Kreis (Team/Freunde, bis ca. 20 Personen) Claude über die **Anthropic API** nutzt – mit
Accounts, Datei-Upload und Budget-Limits pro Person. Kostenlos für die Nutzer, der Admin
vergibt die Budgets.

Entscheidung: **LibreChat** (Open Source, MIT) statt Eigenentwicklung. Es bringt Chat-UI,
Accounts, Datei-Upload, Token-Guthaben pro User und Rate-Limits bereits mit.

---

## 1. Architektur

```
Browser ──HTTPS──▶ Caddy (TLS, Let's Encrypt)
                     │
                     ▼
                 LibreChat API + UI ──▶ Anthropic API (Claude)
                     │
          ┌──────────┼───────────┐
          ▼          ▼           ▼
       MongoDB   Meilisearch   RAG-API + pgvector (optional, für Dokumentsuche)
```

Alles läuft per **Docker Compose** auf einem Server.

## 2. Voraussetzungen

| Was                | Details                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Hetzner Cloud      | Ubuntu 24.04, 2–4 vCPU, 4–8 GB RAM, 40+ GB SSD (ohne RAG reichen 4 GB), Standort DE, Backups an |
| Domain             | z. B. `chat.example.de`, A-/AAAA-Record auf die Server-IP                                        |
| Anthropic Console  | API-Key in eigenem Workspace, **monatliches Ausgabelimit** im Workspace setzen                    |
| SMTP (optional)    | Für Passwort-Reset und Einladungen per Mail                                                      |

## 3. Phasen

### Phase 1 – Server absichern (≈ 1 h)

- Server mit SSH-Key anlegen, Passwort-Login aus (`PasswordAuthentication no`).
- Hetzner-Firewall: nur 22, 80, 443 eingehend (22 idealerweise nur von eigener IP).
- `ufw`, `fail2ban`, `unattended-upgrades` installieren.
- Nicht-root-User mit `sudo`, Docker + Compose-Plugin installieren.

### Phase 2 – LibreChat installieren (≈ 1–2 h)

```bash
git clone https://github.com/danny-avila/LibreChat.git
cd LibreChat
cp .env.example .env
cp librechat.example.yaml librechat.yaml
```

`.env` – wichtigste Werte:

```ini
DOMAIN_CLIENT=https://chat.example.de
DOMAIN_SERVER=https://chat.example.de

# Only Claude: hide the other providers
ENDPOINTS=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODELS=claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5

# No public sign-up; the admin creates accounts
ALLOW_REGISTRATION=false
ALLOW_SOCIAL_REGISTRATION=false

# Generate fresh secrets (LibreChat offers a credentials generator)
CREDS_KEY=...
CREDS_IV=...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
MEILI_MASTER_KEY=...

# Per-user message rate limit
LIMIT_MESSAGE_USER=true
MESSAGE_USER_MAX=40
MESSAGE_USER_WINDOW=1
```

Start: `docker compose -f deploy-compose.yml up -d` (Produktions-Compose von LibreChat).

### Phase 3 – HTTPS mit Caddy (≈ 30 min)

`Caddyfile`:

```
chat.example.de {
    encode gzip
    reverse_proxy localhost:3080
}
```

Caddy holt das Let's-Encrypt-Zertifikat automatisch. Den Nginx-Container aus
`deploy-compose.yml` dann weglassen (oder stattdessen den mitgelieferten Nginx nutzen –
nur einer von beiden).

### Phase 4 – Limits pro Person (≈ 1 h)

`librechat.yaml`:

```yaml
balance:
  enabled: true
  startBalance: 5000000 # 1,000,000 credits = 1 USD -> 5 USD for new users
  autoRefillEnabled: true
  refillIntervalValue: 30
  refillIntervalUnit: "days"
  refillAmount: 5000000 # 5 USD per month
```

Admin-Befehle (deploy-compose):

```bash
# Create a user (works even with registration disabled)
docker exec -it LibreChat-API /bin/sh -c "cd .. && npm run create-user"
# Top up / overwrite / list balances
docker exec -it LibreChat-API /bin/sh -c "cd .. && npm run add-balance user@example.de 2000000"
docker exec -it LibreChat-API /bin/sh -c "cd .. && npm run set-balance user@example.de 10000000"
docker exec -it LibreChat-API /bin/sh -c "cd .. && npm run list-balances"
```

Drei Ebenen schützen das Budget:

1. **Guthaben pro User** (LibreChat-Balance) – leer = keine weiteren Anfragen.
2. **Rate-Limit pro User** (`MESSAGE_USER_*`) – gegen Spam/Endlosschleifen.
3. **Workspace-Limit in der Anthropic Console** – harte Obergrenze für alle zusammen.

### Phase 5 – Datei-Upload (≈ 1–2 h)

- Bilder und PDFs gehen direkt an Claude (Claude liest sie nativ) – das funktioniert ohne Zusatzdienst.
- Limits in `librechat.yaml`:

```yaml
fileConfig:
  endpoints:
    anthropic:
      fileLimit: 10 # files per message
      fileSizeLimit: 20 # MB per file
      totalSizeLimit: 50 # MB per message
  serverFileSizeLimit: 50
```

- **Optional RAG** (Suche über viele/große Dokumente): RAG-API + pgvector sind in der
  Compose-Datei enthalten, brauchen aber einen **Embedding-Anbieter** (Anthropic bietet keine
  Embeddings). Optionen: OpenAI-Key, Voyage AI oder lokal über Ollama (mehr RAM nötig).
  → Erst ohne RAG starten, bei Bedarf nachrüsten.

### Phase 6 – Betrieb (≈ 1 h einrichten)

- **Backups:** Hetzner-Server-Backups + täglicher `mongodump` per Cron (Chats, Accounts, Guthaben)
  und das Upload-Verzeichnis sichern; Kopie in eine Hetzner Storage Box.
- **Updates:** monatlich `git pull && docker compose -f deploy-compose.yml pull && ... up -d`;
  vorher Backup, Release-Notes lesen.
- **Monitoring:** Uptime-Check (z. B. Uptime Kuma), Kosten in der Anthropic Console wöchentlich prüfen.
- **Admin:** Bekanntgabe von Änderungen und Hinweisen über die LibreChat-Einstellungen
  (Willkommensnachricht, Nutzungsbedingungen-Modal in `librechat.yaml` → `interface`).

### Phase 7 – Recht & Datenschutz

- Auch bei privatem Kreis: Nutzer informieren, dass Inhalte an Anthropic (USA) gehen.
- Anthropic-DPA (Commercial Terms) und Hetzner-AVV abschließen bzw. akzeptieren.
- Bei öffentlich erreichbarer Seite: Impressum + Datenschutzerklärung.
- Usage Policy von Anthropic gilt für alle Nutzer – in den Nutzungsbedingungen verlinken.

## 4. Kosten (grob)

| Posten           | Kosten                                                    |
| ---------------- | --------------------------------------------------------- |
| Hetzner Cloud    | ca. 5–15 €/Monat je nach Größe, + ~20 % für Backups       |
| Domain           | ca. 1 €/Monat                                             |
| Anthropic API    | nutzungsabhängig – gedeckelt durch Budgets und Workspace-Limit |

## 5. Checkliste

- [ ] Hetzner-Server + Firewall + SSH-Key
- [ ] Domain auf Server-IP
- [ ] Anthropic-Workspace, API-Key, Ausgabelimit
- [ ] LibreChat mit `.env` + `librechat.yaml`
- [ ] Caddy/HTTPS
- [ ] Balance + Rate-Limits aktiv, Test mit leerem Guthaben
- [ ] Datei-Upload testen (Bild, PDF, Textdatei)
- [ ] Accounts anlegen, Startguthaben prüfen
- [ ] Backups + Restore einmal testen
- [ ] Datenschutzhinweis / Nutzungsbedingungen

**Gesamtaufwand:** etwa 1 Arbeitstag bis zum ersten Login, plus optional RAG.

## 6. Offene Punkte

- Domain/Subdomain festlegen.
- Budget pro Person (Vorschlag: 5 USD/Monat) und Modell-Auswahl (Opus nur für bestimmte Nutzer?).
- RAG ja/nein – und wenn ja, welcher Embedding-Anbieter.
- SMTP für Passwort-Reset gewünscht?
