# AI Workbench – Fortschritt

Laufendes Protokoll zur Umsetzung von [`PLAN.md`](./PLAN.md).
Zeiten in UTC. Legende: ✅ fertig · 🔄 in Arbeit · ⏳ offen · ⚠️ Problem/Hinweis

## Gesamtstatus

| Phase | Inhalt                     | Status | Fortschritt |
| ----- | -------------------------- | ------ | ----------- |
| 0     | Fundament & Spike          | ✅     | 100 %       |
| 1     | Chat mit allen Providern   | 🔄     | 0 %         |
| 2     | Coding-Agent               | ⏳     | 0 %         |
| 3     | Internet                   | ⏳     | 0 %         |
| 4     | Medien: Bilder & 3D        | ⏳     | 0 %         |
| 5     | Skills & Add-ons           | ⏳     | 0 %         |
| 6     | Feinschliff & Distribution | ⏳     | 0 %         |

**Gesamt: ~14 %** (1 von 7 Phasen)

## Teststand

Befehl: `npm run check` (Typecheck → Lint → Unit-/Integrationstests → Build → Smoke-Test)

| Prüfung                                                        | Ergebnis     |
| -------------------------------------------------------------- | ------------ |
| TypeScript strict (main, preload, renderer, tests)             | ✅           |
| ESLint (typescript-eslint strict)                              | ✅           |
| Unit-Tests (Provider, Settings, Secrets, Normalisierung)       | ✅ 17/17     |
| Integration: echter Claude-Code-Runtime ↔ Mock-API (Streaming) | ✅ 1/1       |
| Build (electron-vite)                                          | ✅           |
| Smoke-Test App (UI + IPC + kompletter Chat-Durchlauf)          | ✅           |
| Smoke-Test **gepackte** App (asar-Unpack des Runtimes)         | ✅ (Linux)   |
| Windows-Installer + Smoke-Test auf Windows                     | ⏳ GitHub CI |

---

## Protokoll

### 2026-10-10 09:38 – Phase 0 abgeschlossen ✅

- **Projekt-Setup:** Electron 44 + electron-vite 5 + React 19 + Tailwind 4, TypeScript 6 strict
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint, Prettier, Vitest.
- **Typsichere IPC:** gemeinsamer Vertrag in `src/shared/ipc.ts` (Zod-Schemas). Eingaben werden im
  Main-Prozess validiert, der Renderer bekommt automatisch typisierte `invoke`/`on`-Funktionen.
  _(Statt tRPC eine eigene, schlanke Lösung – weniger Abhängigkeiten, gleiche Typsicherheit.)_
- **Sicherheit:** `contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP, externe Links im
  Browser. API-Keys verschlüsselt per `safeStorage` (DPAPI), Renderer sieht nur „Key vorhanden“.
- **Agent-Kern:** Claude Agent SDK 0.3.296 eingebettet. Provider-Umschaltung (Anthropic /
  OpenRouter / Ollama) über Umgebungsvariablen; geerbte `ANTHROPIC_*`-Variablen werden entfernt,
  eigener Config-Ordner (berührt nie dein `~/.claude`), Telemetrie aus.
- **UI:** Chat mit Streaming, Markdown, Abbrechen, Kosten/Dauer; Einstellungen für Keys, Modelle,
  Ollama-URL, Theme.
- **Spike erfolgreich:** Der native Claude-Code-Runtime läuft aus der gepackten App
  (`app.asar.unpacked`). Größtes technisches Risiko aus dem Plan ist damit geklärt.
- **CI:** `.github/workflows/ci.yml` baut auf `windows-latest`, testet und erzeugt den
  NSIS-Installer als Artefakt.
- ⚠️ Electron-Download über npm brach im Container ab → Binary manuell geladen und per SHA256
  verifiziert. Betrifft nur diese Umgebung, nicht deinen PC.
- ⚠️ Im Linux-Container gibt es keinen Schlüsselbund → Keys speichern dort nicht möglich
  (erwartet). Unter Windows ist DPAPI immer verfügbar.

### 2026-10-10 09:27 – Start Phase 0

- Fortschrittsdatei angelegt.
- Umgebung geprüft: Node 22.22, npm 10.9, Electron 44.7 und Claude Agent SDK 0.3.296 verfügbar.
