# A-B Cloud AI Portal – Server-Ordner

Alles für den Server in einem Ordner: Chat (LibreChat), Portal (Login, Einladungen, Budgets,
Dashboard), Code-Ausführung, 3D-Teile – gestartet mit einem Befehl.

## Installieren / Umschalten

Archiv in den Docker-Ordner hochladen (z. B. `~/docker/`), dann auf dem Server (Root nicht nötig,
nur Docker-Rechte):

```bash
cd ~/docker
tar xzf ai-portal-neu.tar.gz
cd ai-portal-neu
./start.sh
```

`start.sh` fragt beim ersten Mal nach dem **Anthropic-API-Key**, deinem **Admin-Benutzernamen** und einem
**Admin-Passwort** (mind. 12 Zeichen), baut alles (beim ersten Mal 10–20 Minuten) und startet es.
Läuft das alte Portal noch auf Port 45012, fragt es, ob es das alte stoppen und umschalten soll.

Danach: `https://ai.dev.a-b-cloud.de/portal/admin/login`

## Wichtige Befehle (im Ordner `ai-portal-neu`)

| Was                        | Befehl                                           |
| -------------------------- | ------------------------------------------------ |
| Starten / Update einspielen | `./start.sh`                                     |
| Zurück zum alten Portal     | `./rollback.sh`                                  |
| Status                      | `docker compose ps`                              |
| Logs                        | `docker compose logs -f --tail 50 api portal-gateway` |
| Backup                      | `scripts/backup.sh`                              |

**Update:** neues `ai-portal-neu.tar.gz` hochladen, im selben Ordner wieder entpacken (Einstellungen in
`librechat.env` / `portal-gateway.env` und alle Daten in `data/`, `uploads/`, `images/` bleiben), `./start.sh`.

Ausführlich: `GO-LIVE.md` im Repository (`docs/GO-LIVE.md`).
