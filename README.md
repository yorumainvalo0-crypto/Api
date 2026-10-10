# AI Workbench

Persönliche Windows-Desktop-App für Chat, Coding-Agent, Websuche und Medien – mit eigenen
API-Keys für **Anthropic**, **OpenRouter** und lokal **Ollama**.

- Plan: [`docs/PLAN.md`](docs/PLAN.md)
- Fortschritt: [`docs/PROGRESS.md`](docs/PROGRESS.md)

## Voraussetzungen (Windows)

- Node.js ≥ 22.18 (LTS), Git
- Optional: Ollama ≥ 0.14 für lokale Modelle

## Entwicklung

```powershell
npm install
npm run dev        # App mit Hot-Reload starten
```

## Prüfen

```powershell
npm run check      # Typecheck + Lint + Tests + Build + Smoke-Test
```

Der Smoke-Test startet die echte App unsichtbar, prüft die Oberfläche und führt einen
kompletten Chat-Durchlauf gegen einen lokalen Mock-Server aus (kein API-Key nötig).

## Installer bauen

```powershell
npm run dist:win   # erzeugt release/<version>/AI Workbench Setup <version>.exe
```

Alternativ baut GitHub Actions (`.github/workflows/ci.yml`) bei jedem Push den Installer
und stellt ihn als Artefakt `ai-workbench-windows` bereit.

## Erste Schritte in der App

1. **Einstellungen** öffnen → API-Key für Anthropic und/oder OpenRouter speichern
   (verschlüsselt über Windows DPAPI).
2. Provider wählen. Für OpenRouter/Ollama eine Modell-ID eintragen.
3. Im **Chat** loslegen.
