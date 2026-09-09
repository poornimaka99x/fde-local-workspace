// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountsView } from '../../web/src/features/accounts/AccountsView'
import type { ProviderAccount, ProviderTemplate } from '../../web/src/lib/types'

/**
 * The AI accounts panel.
 *
 * What is asserted throughout: the panel decides nothing (every answer comes
 * from the controller), a sign-in state it cannot confirm is shown as
 * unconfirmed rather than as either answer, a limit the provider imposes is
 * stated in the provider's own words, and no credential is ever rendered.
 */

interface Sent {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  })
}

const claudeTemplate: ProviderTemplate = {
  provider: 'claude',
  label: 'Claude',
  kind: 'claude',
  summary: 'Claude Code signed in with a Claude account.',
  loginMode: 'terminal',
  credentialEnv: 'CLAUDE_CONFIG_DIR',
  credentialDirTemplate: '~/.claude-profiles/{account}',
  cliRequired: 'claude',
  cliInstalled: true,
  fields: [],
  capabilities: ['orchestration'],
  sharedCredential: false,
  maxAccounts: null,
  multipleAccounts: true,
}

const bedrockTemplate: ProviderTemplate = {
  provider: 'claude-bedrock',
  label: 'Claude on Bedrock',
  kind: 'claude',
  summary: 'There is no interactive sign-in.',
  loginMode: 'none',
  credentialEnv: 'CLAUDE_CONFIG_DIR',
  credentialDirTemplate: '~/.claude-profiles/{account}',
  cliRequired: 'claude',
  cliInstalled: true,
  fields: [
    { name: 'awsProfile', label: 'AWS profile', required: true, default: 'bedrock-dev' },
    { name: 'awsRegion', label: 'AWS region', required: true, default: 'eu-west-1' },
  ],
  capabilities: ['orchestration'],
  sharedCredential: false,
  maxAccounts: null,
  multipleAccounts: true,
}

const codexTemplate: ProviderTemplate = {
  provider: 'codex',
  label: 'ChatGPT / Codex',
  kind: 'codex',
  summary: 'One CODEX_HOME per account.',
  loginMode: 'terminal',
  credentialEnv: 'CODEX_HOME',
  credentialDirTemplate: '~/.codex-profiles/{account}',
  cliRequired: 'codex',
  cliInstalled: false,
  fields: [],
  capabilities: ['research'],
  sharedCredential: false,
  maxAccounts: null,
  multipleAccounts: true,
}

const antigravityTemplate: ProviderTemplate = {
  provider: 'antigravity',
  label: 'Gemini (Antigravity)',
  kind: 'gemini',
  summary: 'Gemini through the Antigravity CLI (agy).',
  loginMode: 'terminal',
  credentialEnv: null,
  cliRequired: 'agy',
  cliInstalled: true,
  fields: [],
  capabilities: ['research'],
  sharedCredential: true,
  maxAccounts: 1,
  maxAccountsReason:
    'Antigravity keeps one sign-in per machine — its token lives in the OS keyring, '
    + 'not in a per-account folder — so a second account would silently share the first.',
  multipleAccounts: false,
}

const copilotTemplate: ProviderTemplate = {
  provider: 'copilot-studio',
  label: 'Microsoft Copilot',
  kind: 'copilot-studio',
  summary: 'A Copilot Studio agent over Direct Line.',
  loginMode: 'secret',
  fields: [],
  secret: { label: 'Direct Line secret', minLength: 20, instruction: 'Copilot Studio > Channels.' },
  capabilities: ['microsoft-context'],
  sharedCredential: false,
  maxAccounts: null,
  multipleAccounts: true,
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'claude_work',
    label: 'Claude: work',
    provider: 'claude',
    providerLabel: 'Claude',
    kind: 'claude',
    account: 'work',
    loginMode: 'terminal',
    credentialDir: '/home/me/.claude-profiles/work',
    loggedIn: true,
    credentialSource: 'file',
    loginDetail: 'credential present in /home/me/.claude-profiles/work',
    available: true,
    availability: 'account work',
    capabilities: ['orchestration'],
    declared: false,
    isolated: true,
    fields: {},
    forbidden: [],
    writeRequiresApproval: false,
    ...overrides,
  }
}

describe('AI accounts panel', () => {
  let sent: Sent[]
  let accounts: ProviderAccount[]
  let providers: ProviderTemplate[]

  beforeEach(() => {
    sent = []
    accounts = [account()]
    providers = [claudeTemplate, bedrockTemplate, codexTemplate, antigravityTemplate, copilotTemplate]
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      sent.push({
        url, method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (url === '/api/accounts/providers') return jsonResponse({ schemaVersion: 1, providers })
      if (url === '/api/accounts') {
        if (method === 'POST') {
          const created = account({ id: 'codex_new', label: 'ChatGPT / Codex: new', provider: 'codex' })
          accounts = [...accounts, created]
          return jsonResponse({ schemaVersion: 1, account: created }, 201)
        }
        return jsonResponse({ schemaVersion: 1, accounts })
      }
      if (url.endsWith('/verify')) {
        return jsonResponse({ schemaVersion: 1, account: accounts[0] })
      }
      if (url.endsWith('/secret')) {
        return jsonResponse({ schemaVersion: 1, account: accounts[0] })
      }
      if (url.startsWith('/api/accounts/') && method === 'PATCH') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { fields: Record<string, string> } : { fields: {} }
        accounts = accounts.map((item) => url.endsWith(item.id) ? { ...item, fields: body.fields } : item)
        return jsonResponse({ schemaVersion: 1, account: accounts[0] })
      }
      if (url.startsWith('/api/accounts/') && method === 'DELETE') {
        return jsonResponse({
          schemaVersion: 1,
          removed: accounts[0],
          credentials: { requested: false, removed: false, path: '/x' },
          stillInUse: [],
        })
      }
      return jsonResponse({ title: 'unexpected' }, 500)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says accounts are identities and roles are chosen per run', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'AI accounts' })
    expect(screen.getByText(/Accounts are identities, not roles/)).toBeInTheDocument()
  })

  it('waits for both answers before offering to add an account', async () => {
    // A per-provider ceiling is a comparison against what already exists, so a
    // form rendered while that list is in flight would offer a button the
    // controller is about to refuse.
    render(<AccountsView />)
    expect(screen.getByRole('status')).toHaveTextContent(/Reading accounts/)
    await screen.findByRole('heading', { name: 'Add an account' })
  })

  it('shows the folder that keeps one account apart from another', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Claude: work' })
    expect(screen.getByText('/home/me/.claude-profiles/work')).toBeInTheDocument()
  })

  it('names the variable a provider uses to isolate accounts', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Add an account' })
    expect(screen.getByText(/selected by CLAUDE_CONFIG_DIR/)).toBeInTheDocument()
  })

  it('states a provider limit in the provider’s own words and blocks the button', async () => {
    accounts = [account({
      id: 'gemini', label: 'Gemini', provider: 'antigravity', providerLabel: 'Gemini (Antigravity)',
      loginMode: 'terminal', loggedIn: false, credentialSource: 'unconfirmed',
      loginDetail: 'not checked — this sign-in can only be confirmed by running agy',
      isolated: false,
    })]
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Add an account' })
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'antigravity')
    expect(screen.getByText(/token lives in the OS keyring/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Name'), 'second')
    expect(screen.getByRole('button', { name: 'Add account' })).toBeDisabled()
  })

  it('shows an unconfirmable sign-in as not checked, never as either answer', async () => {
    accounts = [account({
      id: 'gemini', label: 'Gemini', provider: 'antigravity', providerLabel: 'Gemini (Antigravity)',
      loggedIn: false, credentialSource: 'unconfirmed',
      loginDetail: 'not checked — this sign-in can only be confirmed by running agy',
      isolated: false,
    })]
    render(<AccountsView />)
    const card = (await screen.findByRole('heading', { name: 'Gemini' })).closest('article')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByText('not checked')).toBeInTheDocument()
    expect(within(card as HTMLElement).queryByText('signed out')).toBeNull()
    expect(within(card as HTMLElement).queryByText('signed in')).toBeNull()
  })

  it('says plainly when an account shares its provider’s default folder', async () => {
    accounts = [account({
      id: 'chatgpt_codex', label: 'ChatGPT/Codex', provider: 'codex',
      providerLabel: 'ChatGPT / Codex', declared: false, isolated: false,
      credentialDir: '/home/me/.codex',
    })]
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'ChatGPT/Codex' })
    expect(screen.getByText(/predates per-account folders/)).toBeInTheDocument()
  })

  it('warns before adding an account whose CLI is not installed', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Add an account' })
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'codex')
    expect(screen.getByRole('status')).toHaveTextContent(/codex is not installed/)
    // Registering is still allowed — signing in is what needs the CLI.
    await userEvent.type(screen.getByLabelText('Name'), 'client a')
    expect(screen.getByRole('button', { name: 'Add account' })).toBeEnabled()
  })

  it('sends the provider, the name and the provider’s own fields', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Add an account' })
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'claude-bedrock')
    await userEvent.type(screen.getByLabelText('Name'), 'prod')
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }))
    await waitFor(() => {
      expect(sent.some((call) => call.method === 'POST' && call.url === '/api/accounts')).toBe(true)
    })
    const post = sent.find((call) => call.method === 'POST' && call.url === '/api/accounts')
    expect(post?.body).toEqual({
      provider: 'claude-bedrock',
      name: 'prod',
      fields: { awsProfile: 'bedrock-dev', awsRegion: 'eu-west-1' },
    })
  })

  it('offers no sign-in for a provider that has none', async () => {
    accounts = [account({
      id: 'bedrock_prod', label: 'Claude on Bedrock: prod', provider: 'claude-bedrock',
      providerLabel: 'Claude on Bedrock', loginMode: 'none', declared: true,
    })]
    render(<AccountsView />)
    const card = (await screen.findByRole('heading', { name: 'Claude on Bedrock: prod' })).closest('article')
    expect(within(card as HTMLElement).queryByRole('button', { name: /Sign in/ })).toBeNull()
    expect(within(card as HTMLElement).getByText(/no interactive sign-in/)).toBeInTheDocument()
  })

  it('lets an existing Bedrock account change AWS profile and region', async () => {
    accounts = [account({
      id: 'claude_bedrock', label: 'Claude on Bedrock', provider: 'claude-bedrock',
      providerLabel: 'Claude on Bedrock', loginMode: 'none',
      fields: { awsProfile: 'bedrock-dev', awsRegion: 'eu-west-1' },
    })]
    render(<AccountsView />)
    const card = (await screen.findByRole('heading', { name: 'Claude on Bedrock' })).closest('article')
    expect(card).not.toBeNull()
    const profile = within(card as HTMLElement).getByLabelText('AWS profile')
    const region = within(card as HTMLElement).getByLabelText('AWS region')
    await userEvent.clear(profile)
    await userEvent.type(profile, 'sandbox-admin')
    await userEvent.clear(region)
    await userEvent.type(region, 'us-east-2')
    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Save settings' }))
    await waitFor(() => {
      expect(sent).toContainEqual({
        url: '/api/accounts/claude_bedrock', method: 'PATCH',
        body: { fields: { awsProfile: 'sandbox-admin', awsRegion: 'us-east-2' } },
      })
    })
  })

  it('posts a pasted secret once and keeps it out of the rendered page', async () => {
    accounts = [account({
      id: 'copilot_t', label: 'Microsoft Copilot: T', provider: 'copilot-studio',
      providerLabel: 'Microsoft Copilot', loginMode: 'secret', declared: true,
      loggedIn: false, credentialSource: 'none', loginDetail: 'no secret stored for this account',
    })]
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Microsoft Copilot: T' })
    const secret = 'a-direct-line-secret-value-long-enough'
    await userEvent.type(screen.getByLabelText('Direct Line secret'), secret)
    await userEvent.click(screen.getByRole('button', { name: 'Store secret' }))
    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/secret'))).toBe(true)
    })
    expect(sent.find((call) => call.url.endsWith('/secret'))?.body).toEqual({ secret })
    // Cleared from this tab the moment the server has it.
    expect(screen.getByLabelText('Direct Line secret')).toHaveValue('')
    expect(document.body.textContent).not.toContain(secret)
  })

  it('will not store a secret shorter than the provider says it can be', async () => {
    accounts = [account({
      id: 'copilot_t', label: 'Microsoft Copilot: T', provider: 'copilot-studio',
      providerLabel: 'Microsoft Copilot', loginMode: 'secret', declared: true,
      loggedIn: false, credentialSource: 'none', loginDetail: 'no secret stored',
    })]
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Microsoft Copilot: T' })
    await userEvent.type(screen.getByLabelText('Direct Line secret'), 'too-short')
    expect(screen.getByRole('button', { name: 'Store secret' })).toBeDisabled()
  })

  it('asks the controller to check a sign-in rather than deciding itself', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Claude: work' })
    await userEvent.click(screen.getByRole('button', { name: 'Check sign-in' }))
    await waitFor(() => {
      expect(sent.some((call) => call.url === '/api/accounts/claude_work/verify')).toBe(true)
    })
  })

  it('makes removal a two-step choice and keeps credentials unless asked', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Claude: work' })
    await userEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    expect(screen.getByText(/refuses the removal outright while an unfinished run/))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Claude: work' }))
    await waitFor(() => {
      expect(sent.some((call) => call.method === 'DELETE')).toBe(true)
    })
    expect(sent.find((call) => call.method === 'DELETE')?.url)
      .toBe('/api/accounts/claude_work?purgeCredentials=false')
  })

  it('passes the purge choice through only when it was ticked', async () => {
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Claude: work' })
    await userEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    await userEvent.click(screen.getByLabelText(/Also delete its credential folder/))
    await userEvent.click(screen.getByRole('button', { name: 'Remove Claude: work' }))
    await waitFor(() => {
      expect(sent.some((call) => call.method === 'DELETE')).toBe(true)
    })
    expect(sent.find((call) => call.method === 'DELETE')?.url)
      .toBe('/api/accounts/claude_work?purgeCredentials=true')
  })

  it('shows an unavailable account with the reason, rather than hiding it', async () => {
    accounts = [account({
      available: false, availability: 'claude CLI not installed', loggedIn: false,
      credentialSource: 'none', loginDetail: 'signed out',
    })]
    render(<AccountsView />)
    await screen.findByRole('heading', { name: 'Claude: work' })
    expect(screen.getByText('unavailable')).toBeInTheDocument()
    expect(screen.getByText(/claude CLI not installed/)).toBeInTheDocument()
  })
})
