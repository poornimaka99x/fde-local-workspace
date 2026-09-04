import { lazy, Suspense, useEffect, useState } from 'react'
import type { ClaudeAccountsResponse, ClaudeEffort } from '../lib/types'
import { useApi } from '../lib/useApi'
import { ErrorState } from './States'

const ClaudeLoginPanel = lazy(() => import('./ClaudeLoginPanel'))

export function ClaudeSettings({
  accountId,
  model,
  effort,
  onAccount,
  onModel,
  onEffort,
  includeCodex = false,
}: {
  accountId: string
  model: string
  effort: ClaudeEffort
  onAccount: (value: string) => void
  onModel: (value: string) => void
  onEffort: (value: ClaudeEffort) => void
  includeCodex?: boolean
}): JSX.Element {
  const accounts = useApi<ClaudeAccountsResponse>('/api/claude/accounts')
  const [showLogin, setShowLogin] = useState(false)
  const availableAccounts = accounts.data?.accounts ?? []
  const selected = availableAccounts.find((account) => account.id === accountId) ?? null
  const models = selected?.models ?? []
  const selectedModel = models.find((option) => option.id === model) ?? models[0] ?? null

  useEffect(() => {
    if (accountId === 'codex' || selected !== null || !availableAccounts[0]) return
    onAccount(availableAccounts[0].id)
  }, [accountId, availableAccounts, onAccount, selected])

  useEffect(() => {
    if (accountId === 'codex') return
    if (selectedModel === null) return
    if (!models.some((option) => option.id === model)) onModel(selectedModel.id)
    if (!selectedModel.efforts.includes(effort)) onEffort(selectedModel.efforts[0] ?? 'auto')
  }, [accountId, effort, model, models, onEffort, onModel, selectedModel])

  const statusLabel = selected?.authState.replace('_', ' ') ?? null
  const canLogin = selected?.provider === 'anthropic' && selected.authState !== 'authenticated'

  return (
    <>
      {accounts.error ? <ErrorState error={accounts.error} /> : null}
      <div className="form-grid">
        <label>
          <strong>Claude account / Orchestrator</strong>
          <select value={accountId} onChange={(event) => { onAccount(event.target.value); setShowLogin(false) }}>
            {availableAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label}</option>
            ))}
            {includeCodex ? <option value="codex">ChatGPT/Codex</option> : null}
          </select>
        </label>
        <label>
          <strong>Model</strong>
          <select
            value={accountId === 'codex' ? 'default' : model}
            disabled={accountId === 'codex' || selected === null}
            onChange={(event) => onModel(event.target.value)}
          >
            {(accountId === 'codex' ? [{ id: 'default', label: 'Managed in Codex' }] : models).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <strong>Effort</strong>
          <select
            value={accountId === 'codex' ? 'auto' : effort}
            disabled={accountId === 'codex' || selectedModel === null}
            onChange={(event) => onEffort(event.target.value as ClaudeEffort)}
          >
            {(accountId === 'codex' ? ['auto'] : selectedModel?.efforts ?? ['auto']).map((option) => (
              <option key={option} value={option}>{option === 'auto' ? 'Default' : option}</option>
            ))}
          </select>
        </label>
      </div>
      {selected ? (
        <div className="stack account-status">
          <span className={`badge ${selected.authState === 'authenticated' || selected.authState === 'external' ? 'ok' : 'warn'}`}>
            {statusLabel}
          </span>
          {selected.authMethod ? <span className="muted">{selected.authMethod}</span> : null}
          {canLogin ? (
            <button className="action" type="button" onClick={() => setShowLogin((value) => !value)}>
              {showLogin ? 'Hide login' : selected.authState === 'login_required' ? 'Login' : 'Configure login'}
            </button>
          ) : null}
        </div>
      ) : null}
      {showLogin && selected ? (
        <Suspense fallback={<div className="card muted">Loading login terminal…</div>}>
          <ClaudeLoginPanel account={selected} onFinished={accounts.reload} />
        </Suspense>
      ) : null}
    </>
  )
}
