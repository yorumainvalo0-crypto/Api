import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, Loader2, Search, ShieldAlert } from 'lucide-react'
import type { RegistryServer, RepoCandidate } from '@shared/schemas/addons'
import { api } from '../../lib/api'
import { cleanError } from '../../components/ModelPicker'
import { Modal } from './Modal'
import { Badge, ErrorText, SectionHeader } from './ui'
import { btnCls, btnPrimaryCls, btnSmCls, cardCls, inputCls } from './styles'

export function DiscoverTab(props: { onChanged: () => void }) {
  return (
    <div className="space-y-10">
      <GithubSection onChanged={props.onChanged} />
      <RegistrySection onChanged={props.onChanged} />
    </div>
  )
}

// --- GitHub ---------------------------------------------------------------------------------

interface ScanResult {
  token: string
  label: string
  candidates: RepoCandidate[]
}

function GithubSection(props: { onChanged: () => void }) {
  const [repo, setRepo] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<{ installed: string[]; errors: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const doScan = () => {
    const value = repo.trim()
    if (value.length < 3 || scanning) return
    setScanning(true)
    setError(null)
    setResult(null)
    setScan(null)
    api.invoke('addons:repo-scan', { repo: value }).then(
      (r) => {
        setScanning(false)
        setScan(r)
        setSelected(new Set(r.candidates.map((c) => c.relPath)))
      },
      (e: unknown) => {
        setScanning(false)
        setError(cleanError(e))
      },
    )
  }

  const doInstall = () => {
    if (!scan || selected.size === 0) return
    const relPaths = scan.candidates.map((c) => c.relPath).filter((p) => selected.has(p))
    setInstalling(true)
    setError(null)
    setResult(null)
    api.invoke('addons:repo-install', { token: scan.token, relPaths }).then(
      (r) => {
        setInstalling(false)
        setResult(r)
        props.onChanged()
      },
      (e: unknown) => {
        setInstalling(false)
        setError(cleanError(e))
      },
    )
  }

  const toggleOne = (relPath: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })

  return (
    <section className="space-y-3">
      <SectionHeader title="Von GitHub installieren" />
      <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        Add-ons laufen lokal mit den Rechten des Agenten. Installiere nur Add-ons aus
        vertrauenswürdigen Quellen.
      </p>

      <div className="flex gap-2">
        <input
          value={repo}
          placeholder="besitzer/repo oder GitHub-URL, z. B. anthropics/skills"
          aria-label="GitHub-Repository"
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doScan()
          }}
          className={`${inputCls} flex-1`}
        />
        <button
          type="button"
          className={btnCls}
          disabled={scanning || repo.trim().length < 3}
          onClick={doScan}
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Durchsuchen
        </button>
      </div>

      {scanning && (
        <p className="text-sm text-zinc-500">Repository wird heruntergeladen, das kann dauern …</p>
      )}
      {error && <ErrorText>{error}</ErrorText>}

      {scan && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-500">
            {scan.label}: {scan.candidates.length}{' '}
            {scan.candidates.length === 1 ? 'Eintrag' : 'Einträge'} gefunden
          </p>
          {scan.candidates.length === 0 && (
            <p className="text-sm text-zinc-500">Keine Skills oder Plugins gefunden.</p>
          )}
          {scan.candidates.map((c) => (
            <label key={c.relPath} className={`${cardCls} flex cursor-pointer items-start gap-3`}>
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(c.relPath)}
                onChange={() => toggleOne(c.relPath)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge tone={c.kind === 'skill' ? 'blue' : 'green'}>
                    {c.kind === 'skill' ? 'Skill' : 'Plugin'}
                  </Badge>
                  <span className="truncate font-medium">{c.name}</span>
                </div>
                {c.description && (
                  <p className="text-sm break-words text-zinc-500">{c.description}</p>
                )}
                <p className="font-mono text-xs break-all text-zinc-400">{c.relPath}</p>
              </div>
            </label>
          ))}
          {scan.candidates.length > 0 && (
            <button
              type="button"
              className={btnPrimaryCls}
              disabled={installing || selected.size === 0}
              onClick={doInstall}
            >
              {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Ausgewählte installieren ({selected.size})
            </button>
          )}
        </div>
      )}

      {result && (
        <div className="space-y-1 text-sm">
          {result.installed.length > 0 && (
            <p className="text-emerald-600 dark:text-emerald-400">
              Installiert: {result.installed.join(', ')}
            </p>
          )}
          {result.errors.map((err) => (
            <ErrorText key={err}>{err}</ErrorText>
          ))}
        </div>
      )}
    </section>
  )
}

// --- MCP registry ---------------------------------------------------------------------------

function RegistrySection(props: { onChanged: () => void }) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<RegistryServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installTarget, setInstallTarget] = useState<RegistryServer | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Only the newest request may update state.
  const requestId = useRef(0)

  const search = useCallback((q: string) => {
    const id = ++requestId.current
    setSearching(true)
    setError(null)
    api.invoke('addons:registry-search', { query: q.trim() }).then(
      (r) => {
        if (id !== requestId.current) return
        setSearching(false)
        setResults(r)
      },
      (e: unknown) => {
        if (id !== requestId.current) return
        setSearching(false)
        setError(cleanError(e))
      },
    )
  }, [])

  // Debounced search while typing (also runs once on mount for the initial listing).
  useEffect(() => {
    const timer = setTimeout(() => search(query), 400)
    return () => clearTimeout(timer)
  }, [query, search])

  return (
    <section className="space-y-3">
      <SectionHeader title="MCP-Registry" />
      <div className="flex gap-2">
        <input
          value={query}
          placeholder="MCP-Server suchen …"
          aria-label="MCP-Registry durchsuchen"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search(query)
          }}
          className={`${inputCls} flex-1`}
        />
        <button type="button" className={btnCls} onClick={() => search(query)}>
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Suchen
        </button>
      </div>

      {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {results && results.length === 0 && !searching && (
        <p className="text-sm text-zinc-500">Keine Treffer.</p>
      )}

      {results?.map((s) => (
        <div key={`${s.name}@${s.version}`} className={`${cardCls} flex items-start gap-3`}>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{s.name}</span>
              {s.version && <Badge>v{s.version}</Badge>}
              <InstallKindBadge install={s.install} />
            </div>
            <p className="text-sm break-words text-zinc-500">{s.description}</p>
            {s.install.kind === 'unsupported' && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{s.install.reason}</p>
            )}
            {s.repositoryUrl && /^https?:\/\//i.test(s.repositoryUrl) && (
              <a
                href={s.repositoryUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                <ExternalLink size={11} />
                Repository
              </a>
            )}
          </div>
          <button
            type="button"
            className={btnSmCls}
            disabled={s.install.kind === 'unsupported'}
            onClick={() => {
              setMessage(null)
              setInstallTarget(s)
            }}
          >
            <Download size={12} />
            Installieren
          </button>
        </div>
      ))}

      {installTarget && (
        <RegistryInstallDialog
          server={installTarget}
          onClose={() => setInstallTarget(null)}
          onInstalled={(name) => {
            setInstallTarget(null)
            setMessage(`MCP-Server „${name}“ installiert.`)
            props.onChanged()
          }}
        />
      )}
    </section>
  )
}

function InstallKindBadge(props: { install: RegistryServer['install'] }) {
  switch (props.install.kind) {
    case 'npm':
      return <Badge tone="green">npm</Badge>
    case 'pypi':
      return <Badge tone="amber">pypi (benötigt uv)</Badge>
    case 'remote':
      return <Badge tone="blue">Remote</Badge>
    case 'unsupported':
      return <Badge tone="red">nicht unterstützt</Badge>
  }
}

function RegistryInstallDialog(props: {
  server: RegistryServer
  onClose: () => void
  onInstalled: (name: string) => void
}) {
  const { server } = props
  const [values, setValues] = useState<Record<string, string>>({})
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effective = (name: string, def: string | null): string =>
    (values[name] ?? '').trim() || def || ''
  const missing = server.envVars.some((v) => v.required && !effective(v.name, v.default))

  const install = () => {
    const env: Record<string, string> = {}
    for (const v of server.envVars) {
      const value = effective(v.name, v.default)
      if (value) env[v.name] = value
    }
    setInstalling(true)
    setError(null)
    api.invoke('addons:registry-install', { server, env }).then(
      (r) => {
        setInstalling(false)
        props.onInstalled(r.name)
      },
      (e: unknown) => {
        setInstalling(false)
        setError(cleanError(e))
      },
    )
  }

  return (
    <Modal
      title={`Installieren: ${server.name}`}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={btnCls} onClick={props.onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            className={btnPrimaryCls}
            disabled={installing || missing}
            onClick={install}
          >
            {installing && <Loader2 size={14} className="animate-spin" />}
            Installieren
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-500">{server.description}</p>
        {server.install.kind === 'pypi' && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Dieses Paket wird mit <span className="font-mono">uv</span> gestartet; uv muss
            installiert sein.
          </p>
        )}
        {server.envVars.length === 0 && (
          <p className="text-sm">Keine weitere Konfiguration erforderlich.</p>
        )}
        {server.envVars.map((v) => (
          <div key={v.name} className="space-y-1">
            <label className="block text-sm font-medium">
              <span className="font-mono">{v.name}</span>
              {v.required && (
                <span className="ml-1 text-red-600" title="Pflichtfeld">
                  *
                </span>
              )}
            </label>
            {v.description && <p className="text-xs text-zinc-500">{v.description}</p>}
            <input
              type={v.secret ? 'password' : 'text'}
              autoComplete="off"
              value={values[v.name] ?? ''}
              placeholder={v.default ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
              className={`${inputCls} font-mono`}
            />
          </div>
        ))}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Modal>
  )
}
