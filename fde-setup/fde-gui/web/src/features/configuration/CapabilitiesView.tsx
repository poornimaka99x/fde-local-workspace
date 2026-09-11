import { useMemo, useState, type FormEvent } from 'react'
import { EmptyState, ErrorState, Loading } from '../../components/States'
import { ApiError, apiSend } from '../../lib/api'
import { useApi } from '../../lib/useApi'

type CapabilityKind = 'plugin' | 'skill' | 'agent' | 'mcp' | 'tool' | 'command' | 'hook' | 'script'

interface CapabilityItem {
  id: string
  kind: CapabilityKind
  name: string
  description: string
  origin: 'built-in' | 'user'
  plugin: string | null
  source: string
  tools: string[]
  enabled: boolean
  toggleable: boolean
  disabledReason?: string
  detail?: string
}

interface CapabilityCatalog {
  schemaVersion: 1
  extensionRoot: string
  items: CapabilityItem[]
  counts: Record<CapabilityKind, number>
  warnings: string[]
}

const FILTERS: Array<{ kind: CapabilityKind | 'all', label: string }> = [
  { kind: 'all', label: 'All' }, { kind: 'skill', label: 'Skills' },
  { kind: 'agent', label: 'Sub-agents' }, { kind: 'mcp', label: 'MCPs' },
  { kind: 'tool', label: 'Tools' }, { kind: 'plugin', label: 'Plugins' },
  { kind: 'command', label: 'Commands' }, { kind: 'hook', label: 'Hooks' },
  { kind: 'script', label: 'Utilities' },
]

const KIND_LABEL: Record<CapabilityKind, string> = {
  plugin: 'Plugin', skill: 'Skill', agent: 'Sub-agent', mcp: 'MCP server', tool: 'Tool',
  command: 'Command', hook: 'Hook', script: 'Utility',
}

const SKILL_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Task', 'Write', 'Edit', 'WebSearch', 'WebFetch']

function CapabilitySwitch({ item, reload }: { item: CapabilityItem, reload: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const toggle = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await apiSend('/api/configuration/capabilities/toggle', 'POST', { id: item.id, enabled: !item.enabled })
      reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The capability state could not be changed.'))
    } finally { setBusy(false) }
  }
  return <div className="capability-switch-wrap">
    {item.toggleable ? <button type="button" role="switch" aria-checked={item.enabled}
      aria-label={`${item.enabled ? 'Switch off' : 'Switch on'} ${item.name}`}
      className="capability-switch" disabled={busy} onClick={() => void toggle()}>
      <span aria-hidden="true" />{busy ? 'Saving…' : item.enabled ? 'On' : 'Off'}
    </button> : <span className="badge">{item.enabled ? 'Required' : 'Unavailable'}</span>}
    {error ? <small className="inline-error">{error.message}</small> : null}
  </div>
}

function AddSkill({ reload }: { reload: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [tools, setTools] = useState<string[]>(['Read', 'Grep', 'Glob'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await apiSend('/api/configuration/skills', 'POST', { name, description, instructions, tools })
      setName(''); setDescription(''); setInstructions(''); setOpen(false); reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The skill could not be added.'))
    } finally { setBusy(false) }
  }

  if (!open) return <button className="action primary" onClick={() => setOpen(true)}>Create skill</button>
  return <form className="extension-form" onSubmit={(event) => void submit(event)}>
    <div className="extension-form-head"><div><h3>Create a user skill</h3>
      <p className="muted">FDE keeps it in the separate <code>fde-user</code> plugin, so toolkit updates do not overwrite it.</p></div>
      <button type="button" className="action" onClick={() => setOpen(false)}>Cancel</button></div>
    <div className="settings-form-grid">
      <label><span>Skill name</span><input value={name} pattern="[a-z][a-z0-9-]{1,62}"
        placeholder="release-notes" onChange={(event) => setName(event.target.value)} required /></label>
      <label><span>When should it be used?</span><input value={description}
        placeholder="Prepare concise release notes from verified changes."
        onChange={(event) => setDescription(event.target.value)} minLength={8} required /></label>
    </div>
    <label><span>Instructions</span><textarea rows={8} value={instructions}
      placeholder="Describe the workflow, boundaries, inputs and expected output."
      onChange={(event) => setInstructions(event.target.value)} minLength={8} required /></label>
    <fieldset className="tool-picker"><legend>Tools this skill may request</legend>
      {SKILL_TOOLS.map((tool) => <label key={tool}><input type="checkbox" checked={tools.includes(tool)}
        onChange={(event) => setTools((current) => event.target.checked
          ? [...current, tool] : current.filter((item) => item !== tool))} /> {tool}</label>)}
    </fieldset>
    {error ? <ErrorState error={error} /> : null}
    <button className="action primary" disabled={busy}>{busy ? 'Creating…' : 'Create skill'}</button>
  </form>
}

function ImportPlugin({ reload }: { reload: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [sourcePath, setSourcePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await apiSend('/api/configuration/plugins', 'POST', { sourcePath })
      setSourcePath(''); setOpen(false); reload()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'The plugin could not be imported.'))
    } finally { setBusy(false) }
  }
  if (!open) return <button className="action" onClick={() => setOpen(true)}>Import local plugin</button>
  return <form className="extension-form compact" onSubmit={(event) => void submit(event)}>
    <div className="extension-form-head"><div><h3>Import a local plugin</h3>
      <p className="muted">The source must contain <code>.claude-plugin/plugin.json</code>. FDE validates and copies it into the user extension catalogue.</p></div>
      <button type="button" className="action" onClick={() => setOpen(false)}>Cancel</button></div>
    <div className="banner warn"><strong>Review the source first.</strong> A plugin can contain hooks and executable scripts. Importing adds it to the marketplace; activation remains a separate account-level action.</div>
    <label><span>Absolute directory path</span><input value={sourcePath} placeholder="/Users/me/my-fde-plugin"
      onChange={(event) => setSourcePath(event.target.value)} required /></label>
    {error ? <ErrorState error={error} /> : null}
    <button className="action primary" disabled={busy}>{busy ? 'Importing…' : 'Import plugin'}</button>
  </form>
}

export function CapabilitiesView(): JSX.Element {
  const catalog = useApi<CapabilityCatalog>('/api/configuration/capabilities')
  const [kind, setKind] = useState<CapabilityKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const shown = useMemo(() => (catalog.data?.items ?? []).filter((item) =>
    (kind === 'all' || item.kind === kind) &&
    `${item.name} ${item.description} ${item.plugin ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())),
  [catalog.data, kind, query])
  if (catalog.error) return <ErrorState error={catalog.error} />
  if (!catalog.data) return <Loading label="Reading FDE capabilities…" />

  return <section className="settings-section">
    <div className="settings-hero"><div><p className="eyebrow">Agent harness</p><h2>Capabilities & extensions</h2>
      <p className="lede">Everything FDE can load is visible here: plugins, skills, sub-agents, MCP servers, tools, commands, hooks and runtime utilities. Built-in and user-owned capabilities stay visibly separate.</p></div>
      <div className="security-note"><strong>Extensions stay local</strong><span>Imports are copied into the FDE toolkit. Symbolic links and oversized plugin trees are rejected.</span></div>
    </div>

    <div className="extension-actions"><AddSkill reload={catalog.reload} /><ImportPlugin reload={catalog.reload} /></div>
    <div className="banner"><strong>Availability:</strong> switches apply to new FDE processes; already-running sessions keep their current capability set. MCP switches use the governed MCP controller, disabled tools become CLI deny rules, and hook switches update the local plugin manifest.</div>
    {catalog.data.warnings.length > 0 ? <div className="banner warn"><strong>Some capability definitions could not be read.</strong>
      <ul>{catalog.data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}

    <div className="capability-toolbar">
      <div className="capability-filters" role="group" aria-label="Capability type">
        {FILTERS.map((filter) => <button key={filter.kind} className={kind === filter.kind ? 'selected' : ''}
          onClick={() => setKind(filter.kind)}>{filter.label}<span>{filter.kind === 'all' ? catalog.data!.items.length : catalog.data!.counts[filter.kind]}</span></button>)}
      </div>
      <label className="capability-search"><span className="sr-only">Search capabilities</span>
        <input type="search" value={query} placeholder="Search capabilities" onChange={(event) => setQuery(event.target.value)} /></label>
    </div>

    {shown.length === 0 ? <EmptyState title="No matching capabilities">Change the type or search term.</EmptyState>
      : <div className="capability-grid">{shown.map((item) => <article className={`capability-card ${item.enabled ? '' : 'disabled'}`} key={item.id}>
        <div className="capability-card-head"><div><span className="badge">{KIND_LABEL[item.kind]}</span>
          <span className={`badge ${item.origin === 'built-in' ? '' : 'ok'}`}>{item.origin}</span></div>
          <CapabilitySwitch item={item} reload={catalog.reload} /></div>
        <h3>{item.name}</h3><p>{item.description}</p>
        {!item.enabled && item.disabledReason ? <p className="capability-off-note">{item.disabledReason}</p> : null}
        {item.detail ? <p className="muted capability-detail">{item.detail}</p> : null}
        {item.tools.length > 0 ? <details><summary>{item.kind === 'mcp' ? 'Tool scope policy' : 'Declared tools'} ({item.tools.length})</summary>
          <div className="capability-tools">{item.tools.map((tool) => <code key={tool}>{tool}</code>)}</div></details> : null}
        <div className="capability-source"><span>{item.plugin ?? 'FDE configuration'}</span><code title={item.source}>{item.source}</code></div>
      </article>)}</div>}
  </section>
}
