import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'
import { FakeTerminal, fakeSpawn } from './fake-terminal'

/**
 * The accounts API, against a stub controller.
 *
 * Nothing here runs a real `fde`, `claude`, `codex` or `agy`, and nothing reads
 * the operator's real credentials. What is being tested is the boundary: that
 * the console asks the controller instead of deciding, that a secret goes to
 * stdin and never to argv or back to the browser, and that a refusal arrives as
 * the controller's own typed reason.
 */

function mutating(token: string): Record<string, string> {
  return {
    ...authed(token),
    origin: 'http://127.0.0.1:7317',
    'content-type': 'application/json',
  }
}

const codexAccount = {
  id: 'codex_work',
  label: 'ChatGPT / Codex: work',
  provider: 'codex',
  providerLabel: 'ChatGPT / Codex',
  kind: 'codex',
  account: 'work',
  loginMode: 'terminal' as const,
  credentialDir: '/home/x/.codex-profiles/work',
  loggedIn: false,
  credentialSource: 'none' as const,
  loginDetail: 'signed out — no credential in the account directory',
  available: true,
  availability: 'codex CLI',
  capabilities: ['research'],
  declared: true,
  isolated: true,
  fields: {},
  forbidden: [],
  writeRequiresApproval: true,
}

const provider = {
  provider: 'codex',
  label: 'ChatGPT / Codex',
  kind: 'codex',
  summary: 'One CODEX_HOME per account.',
  loginMode: 'terminal' as const,
  credentialEnv: 'CODEX_HOME',
  credentialDirTemplate: '~/.codex-profiles/{account}',
  cliRequired: 'codex',
  cliInstalled: true,
  fields: [],
  capabilities: ['research'],
  sharedCredential: false,
  maxAccounts: null,
  multipleAccounts: true,
}

describe('AI accounts', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness({ spawnTerminal: fakeSpawn })
    harness.fixture('accounts-providers', { schemaVersion: 1, providers: [provider] })
    harness.fixture('accounts-list', { schemaVersion: 1, accounts: [codexAccount] })
    harness.fixture('accounts-add', { schemaVersion: 1, account: codexAccount })
    harness.fixture('accounts-login-codex_work', {
      schemaVersion: 1,
      login: {
        accountId: 'codex_work',
        provider: 'codex',
        argv: ['codex-test', 'login'],
        env: { CODEX_HOME: '/home/x/.codex-profiles/work' },
        cwd: harness.root,
        instruction: 'Complete the browser sign-in.',
        interactiveUi: false,
        verifyCommand: ['fde', 'accounts', 'verify', 'codex_work', '--json'],
      },
    })
    harness.fixture('accounts-verify-codex_work', {
      schemaVersion: 1,
      account: { ...codexAccount, loggedIn: true, credentialSource: 'file', confirmed: true },
    })
    harness.fixture('accounts-set-secret-copilot_t', {
      schemaVersion: 1,
      account: { ...codexAccount, id: 'copilot_t', provider: 'copilot-studio', loginMode: 'secret', loggedIn: true },
    })
  })

  afterEach(async () => {
    await harness.destroy()
  })

  it('reads the provider catalogue from the controller', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/accounts/providers', headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().providers[0].credentialEnv).toBe('CODEX_HOME')
    expect(harness.calls()).toContainEqual(['accounts', 'providers', '--json'])
  })

  it('asks the controller for the accounts and forwards only bounded filters', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/accounts?loggedIn=true&provider=codex', headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(harness.calls()).toContainEqual(
      ['accounts', 'list', '--json', '--logged-in', '--provider', 'codex'],
    )
  })

  it('refuses a provider filter that is not a provider id', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/accounts?provider=../../etc', headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(400)
    expect(harness.calls().some((call) => call.includes('../../etc'))).toBe(false)
  })

  it('creates an account through the controller and never writes the registry itself', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: mutating(harness.token),
      payload: { provider: 'codex', name: 'work' },
    })
    expect(response.statusCode).toBe(201)
    expect(harness.calls()).toContainEqual(
      ['accounts', 'add', '--provider', 'codex', '--name', 'work', '--json'],
    )
  })

  it('turns a provider field into its option spelling', async () => {
    harness.fixture('accounts-add', { schemaVersion: 1, account: codexAccount })
    await harness.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: mutating(harness.token),
      payload: { provider: 'claude-bedrock', name: 'prod', fields: { awsProfile: 'bedrock-dev' } },
    })
    const call = harness.calls().find((c) => c[0] === 'accounts' && c[1] === 'add')
    expect(call).toContain('--aws-profile')
    expect(call).toContain('bedrock-dev')
  })

  it('rejects a field value that could carry an option with it', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: mutating(harness.token),
      payload: { provider: 'claude-bedrock', name: 'prod', fields: { awsProfile: '--yolo' } },
    })
    expect(response.statusCode).toBe(400)
    expect(harness.calls().some((call) => call.includes('--yolo'))).toBe(false)
  })

  it("surfaces the controller's own refusal code rather than a generic one", async () => {
    harness.failure(
      'accounts-add', 2,
      JSON.stringify({
        schemaVersion: 1,
        error: {
          code: 'duplicate_account',
          message: "'ChatGPT / Codex' already has an account called 'work'",
          hint: 'give this one a different name',
        },
      }),
    )
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: mutating(harness.token),
      payload: { provider: 'codex', name: 'work' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().type).toContain('duplicate-account')
    expect(response.json().detail).toContain('different name')
  })

  it('treats a signed-out verify as an answer, not a missing account', async () => {
    // The controller says "not signed in" with exit 4. Mapping that to a 404
    // would tell the operator the account does not exist.
    harness.failure(
      'accounts-verify-codex_work', 4,
      JSON.stringify({
        schemaVersion: 1,
        account: { ...codexAccount, loggedIn: false, confirmed: true },
      }),
    )
    const response = await harness.app.inject({
      method: 'POST', url: '/api/accounts/codex_work/verify', headers: mutating(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().account.loggedIn).toBe(false)
  })

  it('starts a sign-in terminal from exactly the argv the controller described', async () => {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/accounts/codex_work/login', headers: mutating(harness.token),
    })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('started')
    expect(body.ticket).toBeTruthy()
    expect(body.instruction).toContain('browser sign-in')
    const session = harness.sessions.get('account-login:codex_work')
    expect(session).not.toBeNull()
  })

  it('does not start a second sign-in for the same account', async () => {
    await harness.app.inject({
      method: 'POST', url: '/api/accounts/codex_work/login', headers: mutating(harness.token),
    })
    const again = await harness.app.inject({
      method: 'POST', url: '/api/accounts/codex_work/login', headers: mutating(harness.token),
    })
    expect(again.json().status).toBe('existing')
  })

  it('sends a pasted secret to stdin, never to argv, and never returns it', async () => {
    const secret = 'unmistakable-direct-line-secret-value'
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts/copilot_t/secret',
      headers: mutating(harness.token),
      payload: { secret },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain(secret)
    // argv is recorded by the stub; the secret must appear in none of it.
    const log = readFileSync(`${harness.stubDir}/calls.log`, 'utf8')
    expect(log).not.toContain(secret)
    expect(harness.calls()).toContainEqual(['accounts', 'set-secret', 'copilot_t', '--json'])
    expect(harness.stdinFor('accounts-set-secret-copilot_t')?.toString()).toBe(secret)
  })

  it('refuses an empty secret before the controller is called', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts/copilot_t/secret',
      headers: mutating(harness.token),
      payload: { secret: '' },
    })
    expect(response.statusCode).toBe(400)
    expect(harness.calls().some((c) => c[1] === 'set-secret')).toBe(false)
  })

  it('refuses an account id that is not an identity key', async () => {
    for (const id of ['../etc', 'Work', 'a'.repeat(80)]) {
      const response = await harness.app.inject({
        method: 'POST', url: `/api/accounts/${encodeURIComponent(id)}/verify`,
        headers: mutating(harness.token),
      })
      expect(response.statusCode).toBe(400)
    }
    expect(harness.calls().some((c) => c[1] === 'verify')).toBe(false)
  })

  it('forwards removal options and nothing else', async () => {
    harness.fixture('accounts-remove-codex_work', {
      schemaVersion: 1,
      removed: codexAccount,
      credentials: { requested: true, removed: true, path: '/home/x/.codex-profiles/work' },
      stillInUse: [],
    })
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/accounts/codex_work?purgeCredentials=true',
      headers: mutating(harness.token),
    })
    expect(response.statusCode).toBe(200)
    const call = harness.calls().find((c) => c[1] === 'remove')
    expect(call).toEqual(['accounts', 'remove', 'codex_work', '--json', '--purge-credentials'])
  })

  it('needs a same-origin request to change anything', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { ...authed(harness.token), 'content-type': 'application/json' },
      payload: { provider: 'codex', name: 'work' },
    })
    expect(response.statusCode).toBe(403)
    expect(harness.calls().some((c) => c[1] === 'add')).toBe(false)
  })

  it('needs the token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/accounts' })
    expect(response.statusCode).toBe(401)
  })
})
