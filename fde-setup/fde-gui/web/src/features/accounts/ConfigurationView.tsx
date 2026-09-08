import { useState } from 'react'
import { AccountsView } from './AccountsView'
import { ConnectionsView } from './ConnectionsView'

export function ConfigurationView(): JSX.Element {
  const [tab, setTab] = useState<'accounts' | 'connections'>('accounts')
  return <section className="stack settings-shell">
    <header className="settings-header"><p className="eyebrow">Workspace administration</p><h1>Configuration</h1>
      <p className="lede">Manage who can perform FDE roles and which external systems an approved run can reach.</p></header>
    <div className="settings-tabs" role="tablist" aria-label="Configuration sections">
      <button role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}>AI accounts<span>Claude, Codex, Gemini, Microsoft</span></button>
      <button role="tab" aria-selected={tab === 'connections'} onClick={() => setTab('connections')}>Service connections<span>Atlassian, GitHub, Bitbucket, Figma</span></button>
    </div>
    <div role="tabpanel">{tab === 'accounts' ? <AccountsView /> : <ConnectionsView />}</div>
  </section>
}
