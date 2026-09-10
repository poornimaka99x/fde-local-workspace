import { useState } from 'react'
import { AccountsView } from './AccountsView'
import { ConnectionsView } from './ConnectionsView'
import { McpCatalogView } from '../mcp/McpCatalogView'

export function ConfigurationView(): JSX.Element {
  const [tab, setTab] = useState<'accounts' | 'connections' | 'mcp'>('accounts')
  return <section className="settings-shell">
    <header className="settings-header"><p className="eyebrow">Workspace administration</p><h1>Configuration</h1>
      <p className="lede">Manage the AI identities available to runs, connect approved external services, and set up the MCP servers a run may reach.</p></header>
    <div className="settings-tabs" role="tablist" aria-label="Configuration sections">
      <button role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}>AI accounts<span>Claude, Codex, Gemini, Microsoft</span></button>
      <button role="tab" aria-selected={tab === 'connections'} onClick={() => setTab('connections')}>Service connections<span>Atlassian REST, Rovo, GitHub, Bitbucket, Figma</span></button>
      {/* Separate from service connections on purpose: a connection is a
          credential for a system, an MCP server is a governed capability with a
          lifecycle, a profile and a tool scope. Merging the two would blur
          exactly the distinction the catalogue exists to keep. */}
      <button role="tab" aria-selected={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP servers<span>Catalogue, readiness and tool scope</span></button>
    </div>
    <div className="settings-panel" role="tabpanel">
      {tab === 'accounts' ? <AccountsView />
        : tab === 'connections' ? <ConnectionsView />
          : <McpCatalogView />}
    </div>
  </section>
}
