import { useState } from 'react'
import { AccountsView } from './AccountsView'
import { ConnectionsView } from './ConnectionsView'
import { McpCatalogView } from '../mcp/McpCatalogView'
import { CapabilitiesView } from '../configuration/CapabilitiesView'

export function ConfigurationView(): JSX.Element {
  const [tab, setTab] = useState<'accounts' | 'connections' | 'mcp' | 'capabilities'>('accounts')
  return <section className="settings-shell">
    <header className="settings-header"><p className="eyebrow">Workspace administration</p><h1>Configuration</h1>
      <p className="lede">Manage AI identities, external services, MCP servers, and the skills, sub-agents and plugins that make up the FLOW harness.</p></header>
    <div className="settings-tabs" role="tablist" aria-label="Configuration sections">
      <button role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}>AI accounts<span>Claude, Codex, Gemini, Microsoft</span></button>
      <button role="tab" aria-selected={tab === 'connections'} onClick={() => setTab('connections')}>Service connections<span>Atlassian REST, Rovo, GitHub, Bitbucket, Figma</span></button>
      {/* Separate from service connections on purpose: a connection is a
          credential for a system, an MCP server is a governed capability with a
          lifecycle, a profile and a tool scope. Merging the two would blur
          exactly the distinction the catalogue exists to keep. */}
      <button role="tab" aria-selected={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP servers<span>Catalogue, readiness and tool scope</span></button>
      <button role="tab" aria-selected={tab === 'capabilities'} onClick={() => setTab('capabilities')}>Capabilities<span>Skills, sub-agents, tools and plugins</span></button>
    </div>
    <div className="settings-panel" role="tabpanel">
      {tab === 'accounts' ? <AccountsView />
        : tab === 'connections' ? <ConnectionsView />
          : tab === 'mcp' ? <McpCatalogView />
            : <CapabilitiesView />}
    </div>
  </section>
}
