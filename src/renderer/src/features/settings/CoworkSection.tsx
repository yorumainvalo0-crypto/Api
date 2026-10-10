import { useState } from 'react'
import { Plus, Trash2, Users } from 'lucide-react'
import {
  CoworkRoleSchema,
  DEFAULT_COWORK_ROLES,
  EFFORT_LABELS,
  EffortSchema,
  PROVIDER_LABELS,
  ProviderIdSchema,
  type CoworkRole,
  type SecretStatus,
  type Settings,
} from '@shared/schemas/settings'
import { ModelPicker, cleanError } from '../../components/ModelPicker'

const field =
  'w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700'

/** Turns a role name into a unique id (lowercase, digits, dashes). */
function slugFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'rolle'
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  return id
}

/** Cowork mode: roles (model + effort) that Jev routes requests to and subagents run as. */
export function CoworkSection(props: {
  settings: Settings
  secrets: SecretStatus | null
  onUpdate: (patch: Partial<Settings>) => Promise<void>
}) {
  const { settings } = props
  const [error, setError] = useState<string | null>(null)
  const roles = settings.coworkRoles
  const jevReady =
    settings.jevEnabled &&
    (settings.jevSource === 'typesafe' ? props.secrets?.typesafe : props.secrets?.openrouter)

  const save = async (patch: Partial<Settings>) => {
    setError(null)
    try {
      await props.onUpdate(patch)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const updateRole = (index: number, patch: Partial<CoworkRole>) => {
    const next = roles.map((r, i) => (i === index ? { ...r, ...patch } : r))
    const parsed = CoworkRoleSchema.safeParse(next[index])
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Ungültige Rolle')
      return
    }
    void save({ coworkRoles: next })
  }

  const addRole = () => {
    const id = slugFor('Neue Rolle', new Set(roles.map((r) => r.id)))
    void save({
      coworkRoles: [
        ...roles,
        {
          id,
          name: 'Neue Rolle',
          description: 'Beschreibe, wofür diese Rolle gut ist.',
          provider: settings.activeProvider,
          model: settings.models[settings.activeProvider],
          effort: 'default',
        },
      ],
    })
  }

  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="flex items-center gap-2 font-medium">
        <Users size={16} /> Cowork – mehrere Modelle arbeiten zusammen
      </h2>
      <p className="text-sm text-zinc-500">
        Ist Cowork im Chat eingeschaltet, wählt Jev für jede Anfrage die passende Rolle (Modell +
        Effort). Das gewählte Modell kann Teilaufgaben an Subagents mit anderen Rollen abgeben. Den
        Verbrauch jedes Subagents siehst du unter „Verbrauch“.
        {!jevReady && (
          <span className="text-amber-600 dark:text-amber-400">
            {' '}
            Jev ist nicht eingerichtet – dann wird immer die Standardrolle verwendet.
          </span>
        )}
      </p>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.coworkEnabled}
            onChange={(e) => void save({ coworkEnabled: e.target.checked })}
          />
          Cowork eingeschaltet
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.coworkSubagents}
            onChange={(e) => void save({ coworkSubagents: e.target.checked })}
          />
          Subagents erlauben
        </label>
        <label className="flex items-center gap-2">
          Standardrolle
          <select
            value={settings.coworkDefaultRole}
            onChange={(e) => void save({ coworkDefaultRole: e.target.value })}
            className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-3">
        {roles.map((role, i) => (
          <div
            key={role.id}
            className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <div className="flex gap-2">
              <input
                defaultValue={role.name}
                aria-label="Name"
                onBlur={(e) => {
                  if (e.target.value.trim() !== role.name) updateRole(i, { name: e.target.value })
                }}
                className={`${field} font-medium`}
              />
              <button
                type="button"
                title="Rolle entfernen"
                aria-label="Rolle entfernen"
                disabled={roles.length <= 1}
                onClick={() => void save({ coworkRoles: roles.filter((_, j) => j !== i) })}
                className="rounded-md border border-zinc-300 px-2 text-zinc-500 disabled:opacity-30 dark:border-zinc-700"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <textarea
              defaultValue={role.description}
              aria-label="Wofür ist die Rolle gut?"
              rows={2}
              onBlur={(e) => {
                if (e.target.value.trim() !== role.description) {
                  updateRole(i, { description: e.target.value })
                }
              }}
              className={field}
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={role.provider}
                aria-label="Anbieter"
                onChange={(e) =>
                  updateRole(i, { provider: ProviderIdSchema.parse(e.target.value), model: '' })
                }
                className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
              >
                {ProviderIdSchema.options.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
              <ModelPicker
                key={role.provider}
                provider={role.provider}
                value={role.model}
                onChange={(model) => updateRole(i, { model })}
                compact
              />
              <select
                value={role.effort}
                aria-label="Effort"
                disabled={role.provider === 'ollama'}
                onChange={(e) => updateRole(i, { effort: EffortSchema.parse(e.target.value) })}
                className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
              >
                {EffortSchema.options.map((level) => (
                  <option key={level} value={level}>
                    Effort: {EFFORT_LABELS[level]}
                  </option>
                ))}
              </select>
              <span className="text-xs text-zinc-400">ID: {role.id}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          disabled={roles.length >= 12}
          onClick={addRole}
          className="flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-40 dark:border-zinc-700"
        >
          <Plus size={14} /> Rolle hinzufügen
        </button>
        <button
          type="button"
          onClick={() =>
            void save({ coworkRoles: DEFAULT_COWORK_ROLES, coworkDefaultRole: 'standard' })
          }
          className="rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-700"
        >
          Standardrollen wiederherstellen
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}
