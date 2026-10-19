# Fortschritt: A-B Cloud AI Portal

Plan: [WEB-HOSTING-PLAN.md](WEB-HOSTING-PLAN.md) · Code: [`portal/`](../portal/)

Alles wird zuerst **lokal in Docker** gebaut und getestet (komplette Testumgebung mit LibreChat,
MongoDB und Test-Doubles für Anthropic/OpenRouter). Auf dem Hetzner-Server ist noch **nichts** geändert.

## Übersicht

| Schritt | Inhalt                                               | Status         | Test |
| ------- | ---------------------------------------------------- | -------------- | ---- |
| M0      | Repo-Struktur `portal/`, Server-Bestandsaufnahme     | ✅ fertig       | ✅    |
| M1      | LibreChat-Basis (Claude, Model-Specs, Guthaben)      | ⏳ in Arbeit    |      |
| M2      | Code-Interpreter + Datei-Skills                      | offen          |      |
| M3      | Gateway-Kern: Login, Admin, Login-QR, Geräte         | offen          |      |
| M4      | Gruppen + Einladungs-QR                              | offen          |      |
| M5      | Budgets in USD                                       | offen          |      |
| M6      | Admin-Dashboard                                      | offen          |      |
| M7      | Media (Bild/Sprache/Video via OpenRouter)            | offen          |      |
| M7b     | CAD-Dienst + 3D-Viewer                               | offen          |      |
| M8      | Härtung, Backup/Restore, Go-live-Anleitung           | offen          |      |

## Wartet auf dich

- **Docker-Port** für LibreChat (`LIBRECHAT_HOST_PORT`) und Gateway (`PORTAL_HOST_PORT`) – Platzhalter sind gesetzt.
- Server-Bestandsaufnahme ausführen (siehe M0) und Ausgabe schicken.

## Log

### 19.10.2026 – M0 fertig

- Ordner `portal/` angelegt: `deploy/` (Server-Konfiguration), `gateway/`, `cad-runner/`, `test-stack/`.
  Die Electron-App bleibt unberührt (`portal/` ist aus deren Lint ausgenommen).
- **Server-Bestandsaufnahme:** `portal/deploy/scripts/inventory.sh` – ändert nichts, liest nur
  Ports, nginx-Weiterleitungen, Zertifikate, Docker-Container, Dienste, Firewall.
  Auf dem Server: `sudo bash inventory.sh > inventory.txt` und die Datei schicken.
- **Test:** `bash -n` + `shellcheck` (Inventar- und Backup-Skript) ohne Befund; Probelauf in der
  Testumgebung erfolgreich.
- Testumgebung: Docker läuft, LibreChat- und MongoDB-Images lassen sich laden.
