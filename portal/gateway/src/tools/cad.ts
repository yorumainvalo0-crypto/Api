import { z } from 'zod'
import { describeInfo, runCad, saveCadVersion, signedViewerUrl } from '../cad.js'
import { defineTool, textResult } from '../mcp.js'
import { MediaError, signedMediaUrl } from '../media.js'

export const createCadTool = defineTool({
  name: 'cad_erstellen',
  title: '3D-Modell (CAD) erstellen',
  description:
    'Erstellt ein maßgenaues technisches 3D-Teil (z. B. für 3D-Druck) aus Python-Code mit build123d. ' +
    'Einheiten sind Millimeter. Der Code muss den fertigen Körper der Variablen `result` zuweisen ' +
    '(z. B. `with BuildPart() as p: ...` und dann `result = p.part`). Schreibe parametrisch mit benannten Maßen oben. ' +
    'Liefert Vorschaubild, Maße, Volumen, einen Link zur interaktiven 3D-Ansicht und Downloads (STL, STEP, 3MF). ' +
    'Für Änderungen denselben Namen wieder verwenden – dann entsteht eine neue Version. ' +
    'Bei einem Fehler kommt die Fehlermeldung zurück: Code korrigieren und erneut aufrufen. ' +
    'Gib dem Nutzer die Links unverändert weiter.',
  inputSchema: {
    name: z.string().min(1).max(80).describe('Kurzer Name des Teils, z. B. „Rohrhalterung“'),
    code: z.string().min(10).max(50_000).describe('Python-Code mit build123d, Ergebnis in `result`'),
    formate: z
      .array(z.enum(['step', '3mf']))
      .optional()
      .describe('Zusätzliche Formate neben STL (Standard: step und 3mf)'),
  },
  async run(args, { db, config, user, conversationId }) {
    try {
      const result = await runCad(config, args.code, args.formate ?? ['step', '3mf'])
      if (!result.ok || !result.info) {
        return textResult(`Der CAD-Code ist fehlgeschlagen:\n${result.stderr || 'unbekannter Fehler'}`, true)
      }
      const saved = await saveCadVersion(config, db, {
        userId: user._id,
        conversationId,
        name: args.name,
        code: args.code,
        result,
      })
      const links = [
        `3D-Ansicht (drehen, zoomen, messen): ${signedViewerUrl(config, saved.model._id, saved.version.version)}`,
        `STL (3D-Druck): ${signedMediaUrl(config, saved.files.stl!, 30)}`,
        saved.files.threemf ? `3MF (3D-Druck mit Einheiten): ${signedMediaUrl(config, saved.files.threemf, 30)}` : null,
        saved.files.step ? `STEP (CAD-Programme): ${signedMediaUrl(config, saved.files.step, 30)}` : null,
      ].filter(Boolean)
      const preview = result.files['preview.png']
      return {
        content: [
          ...(preview ? [{ type: 'image' as const, data: preview, mimeType: 'image/png' }] : []),
          {
            type: 'text',
            text: [`„${saved.model.name}“ – Version ${saved.version.version}`, describeInfo(result.info), '', ...links].join('\n'),
          },
        ],
      }
    } catch (error) {
      if (error instanceof MediaError) return textResult(error.message, true)
      throw error
    }
  },
})
