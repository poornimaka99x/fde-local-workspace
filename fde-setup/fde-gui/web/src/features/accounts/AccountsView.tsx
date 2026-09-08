import { useState, type FormEvent } from 'react'
import { ApiError, apiSend } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import type {
  AccountDetailResponse,
  AccountListResponse,
  ProviderAccount,
  ProviderListResponse,
  ProviderTemplate,
} from '../../lib/types'
import { EmptyState, ErrorState, Loading } from '../../components/States'
import { AccountLoginPanel } from './AccountLoginPanel'

/**
 * AI accounts.
 *
 * One screen for the whole question of "which provider accounts does this
 * machine have, and can they be used". Three things are deliberately true of
 * it:
 *
 * - **It decides nothing.** Which providers exist, what each needs, where a
 *   credential lives and whether an account is signed in are all the
 *   controller's answers. This view renders them; it never infers one. An
 *   account whose sign-in could not be confirmed is shown as unconfirmed
 *   rather than quietly as either state.
 * - **A signed-out account is visible, not hidden.** Hiding it would leave the
 *   operator hunting for the account they just added. It is listed, labelled,
 *   and one button away from being signed in.
 * - **No credential passes through here.** A sign-in happens in the provider's
 *   own terminal. The one secret this screen can accept — a Direct Line secret,
 *   which has no CLI to sign in to — is posted once and never read back, and is
 *   held in component state only until that request returns.
 */

function StateBadge({ account }: { account: ProviderAccount }): JSX.Element {
  if (account.loggedIn) return <span className="badge ok">signed in</span>
  // Three states, not two. A credential held in an OS keyring cannot be looked
  // for on disk, so until the provider's own command has been run the honest
  // answer is "not checked" — reporting a working sign-in as broken is as wrong
  // as the reverse.
  if (account.confirmed === false || account.credentialSource === 'unconfirmed') {
    return <span className="badge">not checked</span>
  }
  return <span className="badge warn">signed out</span>
}

function SecretForm({
  account,
  template,
  onDone,
}: {
  account: ProviderAccount
  template: ProviderTemplate | undefined
  onDone: () => void
}): JSX.Element {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const spec = template?.secret ?? null
  const minimum = spec?.minLength ?? 1

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await apiSend<AccountDetailResponse>(
        `/api/accounts/${encodeURIComponent(account.id)}/secret`,
        'POST',
        { secret },
      )
      // Out of this tab's memory the moment the server has it.
      setSecret('')
      onDone()
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not store the secret.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error ? <ErrorState error={error} /> : null}
      <label>
        <span>{spec?.label ?? 'Secret'}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={`at least ${minimum} characters`}
        />
      </label>
      {spec?.instruction ? <p className="muted">{spec.instruction}</p> : null}
      <p className="muted">
        This is sent once to the local controller, which writes it to this
        account&rsquo;s own folder with owner-only permissions. It is never sent back to the
        browser and never appears in a command line.
      </p>
      <button className="action" type="submit" disabled={busy || secret.trim().length < minimum}>
        {busy ? 'Storing…' : 'Store secret'}
      </button>
    </form>
  )
}

function AddAccountForm({
  providers,
  accounts,
  onAdded,
}: {
  providers: ProviderTemplate[]
  accounts: ProviderAccount[]
  onAdded: (account: ProviderAccount) => void
}): JSX.Element {
  const [provider, setProvider] = useState(providers[0]?.provider ?? '')
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const template = providers.find((item) => item.provider === provider)
  const held = accounts.filter((item) => item.provider === provider).length
  const atLimit = typeof template?.maxAccounts === 'number' && held >= template.maxAccounts

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const supplied: Record<string, string> = {}
      for (const field of template?.fields ?? []) {
        const value = (fields[field.name] ?? field.default ?? '').trim()
        if (value !== '') supplied[field.name] = value
      }
      const result = await apiSend<AccountDetailResponse>('/api/accounts', 'POST', {
        provider,
        name: name.trim(),
        fields: supplied,
      })
      setName('')
      setFields({})
      onAdded(result.account)
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not add the account.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      <div className="settings-form-head">
        <div><p className="eyebrow">New identity</p><h3>Add an account</h3></div>
        <p className="muted">Register first, then sign in using the provider&rsquo;s own flow.</p>
      </div>
      {error ? <ErrorState error={error} /> : null}
      <div className="settings-form-grid">
        <label>
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value)
              setFields({})
            }}
          >
            {providers.map((item) => (
              <option key={item.provider} value={item.provider}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Work, client sandbox, personal…"
            maxLength={49}
          />
        </label>
        {(template?.fields ?? []).map((field) => (
          <label key={field.name}>
            <span>
              {field.label}
              {field.required ? '' : ' (optional)'}
            </span>
            <input
              value={fields[field.name] ?? field.default ?? ''}
              onChange={(event) => setFields((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      {template ? (
        <p className="settings-provider-note">
          {template.summary}
          {template.credentialEnv
            ? ` Each account gets its own folder, selected by ${template.credentialEnv}.`
            : ''}
        </p>
      ) : null}
      {/* A ceiling is the provider's, and it is shown with the provider's own
          reason rather than a guess of ours. Where a credential cannot be split
          per account, saying so here is the alternative to a second account
          that quietly shares the first one's sign-in. */}
      {template?.sharedCredential && atLimit ? (
        <p className="banner warn" role="status">
          <strong>{template.label} already has its one account.</strong>{' '}
          {template.maxAccountsReason}
        </p>
      ) : template?.sharedCredential ? (
        <p className="muted">
          One account only: {template.maxAccountsReason}
        </p>
      ) : atLimit ? (
        <p className="banner warn" role="status">
          <strong>
            {template?.label} accepts at most {template?.maxAccounts} account
            {template?.maxAccounts === 1 ? '' : 's'} on this machine.
          </strong>{' '}
          Remove one before adding another.
        </p>
      ) : null}
      {template?.loginMode === 'terminal' && template.cliInstalled === false ? (
        <p className="banner warn" role="status">
          <strong>{template.cliRequired} is not installed on this machine.</strong> You can register
          the account now, but signing in needs that CLI.
        </p>
      ) : null}
      <div className="settings-form-actions">
        <span className="muted">The account name is shown when assigning roles.</span>
        <button
          className="action primary"
          type="submit"
          disabled={busy || atLimit || name.trim() === '' || provider === ''}
        >
          {busy ? 'Adding…' : 'Add account'}
        </button>
      </div>
    </form>
  )
}

function AccountCard({
  account,
  template,
  onChanged,
}: {
  account: ProviderAccount
  template: ProviderTemplate | undefined
  onChanged: () => void
}): JSX.Element {
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [purge, setPurge] = useState(false)

  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      await run()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause : new ApiError(0, 'network', 'That did not go through.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="account-card">
      <header className="account-card-head">
        <div><p className="eyebrow">{account.providerLabel}</p><h3>{account.label}</h3></div>
        <div className="account-badges"><StateBadge account={account} />
          {account.available ? null : <span className="badge danger">unavailable</span>}</div>
      </header>
      <p className="account-summary">{account.loginDetail}</p>
      {account.available ? null : <p className="muted">Cannot be used: {account.availability}</p>}
      {account.confirmed === false && account.check ? (
        <p className="muted">{account.check.detail}</p>
      ) : null}
      <dl className="kv">
        <dt>Identity id</dt>
        <dd>
          <code>{account.id}</code>
        </dd>
        <dt>Credential folder</dt>
        <dd>
          <code>{account.credentialDir}</code>
        </dd>
        {account.isolated ? null : (
          <>
            <dt>Isolation</dt>
            <dd>
              Shares this provider&rsquo;s default folder — it predates per-account folders and was
              left as it is.
            </dd>
          </>
        )}
      </dl>
      {error ? <ErrorState error={error} /> : null}
      {signingIn ? (
        <AccountLoginPanel
          account={account}
          onFinished={() => {
            setSigningIn(false)
            void act(async () =>
              await apiSend(`/api/accounts/${encodeURIComponent(account.id)}/verify`, 'POST', {}))
          }}
        />
      ) : account.loginMode === 'secret' ? (
        <SecretForm account={account} template={template} onDone={onChanged} />
      ) : account.loginMode === 'terminal' ? (
        <div className="account-actions">
          <button className="action" type="button" onClick={() => setSigningIn(true)}>
            {account.loggedIn ? 'Sign in again' : 'Sign in'}
          </button>
        </div>
      ) : (
        <p className="muted">
          This provider has no interactive sign-in — it uses credentials you already hold on this
          machine.
        </p>
      )}
      <div className="account-actions">
        <button
          className="action"
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () =>
              await apiSend(`/api/accounts/${encodeURIComponent(account.id)}/verify`, 'POST', {}))
          }
        >
          {busy ? 'Checking…' : 'Check sign-in'}
        </button>
        {confirmRemove ? (
          <>
            <label className="inline">
              <input
                type="checkbox"
                checked={purge}
                onChange={(event) => setPurge(event.target.checked)}
              />
              <span>Also delete its credential folder</span>
            </label>
            <button
              className="action danger"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () =>
                  await apiSend(
                    `/api/accounts/${encodeURIComponent(account.id)}?purgeCredentials=${purge ? 'true' : 'false'}`,
                    'DELETE',
                  ))
              }
            >
              Remove {account.label}
            </button>
            <button className="action" type="button" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="action" type="button" onClick={() => setConfirmRemove(true)}>
            Remove…
          </button>
        )}
      </div>
      {confirmRemove ? (
        <p className="muted">
          Removing deregisters the account. Its credentials are kept unless you tick the box, and
          the controller refuses the removal outright while an unfinished run still assigns it a
          role.
        </p>
      ) : null}
    </article>
  )
}

export function AccountsView(): JSX.Element {
  const providers = useApi<ProviderListResponse>('/api/accounts/providers')
  const accounts = useApi<AccountListResponse>('/api/accounts')

  const reload = (): void => {
    accounts.reload()
    providers.reload()
  }

  if (providers.error) return <ErrorState error={providers.error} />
  if (accounts.error) return <ErrorState error={accounts.error} />
  // Both answers are needed before the form is honest: a per-provider ceiling
  // is a comparison against the accounts that already exist, and rendering the
  // form while that list is still in flight would offer an "Add account"
  // button that the controller is about to refuse.
  if (providers.data === null || accounts.data === null) {
    return <Loading label="Reading accounts…" />
  }

  const templates = providers.data?.providers ?? []
  const list = accounts.data?.accounts ?? []
  const byProvider = new Map(templates.map((item) => [item.provider, item]))

  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <div><p className="eyebrow">AI providers</p><h2>AI accounts</h2></div>
        <div className="settings-section-copy">
        <p className="lede">
          Add the provider identities this machine can use. Credentials remain isolated between
          accounts whenever the provider supports it.
        </p>
        <p className="muted">
          Accounts are identities, not roles. Which of them does what is chosen per run, when you
          assign roles — nothing here grants anything.
        </p>
        </div>
      </header>

      <AddAccountForm providers={templates} accounts={list} onAdded={reload} />

      {list.length === 0 ? (
        <EmptyState title="No accounts registered">
          Add one above. Registering an account signs in to nothing — that is a separate,
          deliberate step.
        </EmptyState>
      ) : (
        <div className="account-grid">
          {list.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              template={byProvider.get(account.provider)}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </section>
  )
}
