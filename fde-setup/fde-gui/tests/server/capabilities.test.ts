import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'

function seedCore(harness: Harness): void {
  const root = path.join(harness.config.sharedRoot, 'fde-toolkit', 'plugins', 'fde-core')
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(path.join(root, 'skills', 'implementation'), { recursive: true })
  mkdirSync(path.join(root, 'agents'), { recursive: true })
  mkdirSync(path.join(root, 'hooks'), { recursive: true })
  mkdirSync(path.join(harness.config.sharedRoot, 'mcp'), { recursive: true })
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'fde-core', version: '0.4.0', description: 'Core FDE capabilities.',
  }))
  writeFileSync(path.join(root, 'skills', 'implementation', 'SKILL.md'), [
    '---', 'name: implementation', 'description: Implement an approved change.',
    'allowed-tools: Read, Grep, Bash, Write', '---', '', '# Implementation',
  ].join('\n'))
  writeFileSync(path.join(root, 'agents', 'reviewer.md'), [
    '---', 'name: reviewer', 'description: Reviews a bounded change.',
    'tools: Read, Grep', 'model: sonnet', '---', '', '# Reviewer',
  ].join('\n'))
  writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo ready' }] }] },
  }))
  writeFileSync(path.join(harness.config.sharedRoot, 'mcp', 'mcp-servers.json'), JSON.stringify({
    schemaVersion: 2,
    servers: { context7: { transport: 'http', classification: 'public-documentation', mutation: 'read-only', useWhen: 'Version-specific documentation.' } },
  }))
}

describe('capability configuration', () => {
  let harness: Harness
  beforeEach(async () => { harness = await makeHarness(); seedCore(harness) })
  afterEach(async () => { await harness.destroy() })
  const mutationHeaders = (token: string): Record<string, string> => ({
    ...authed(token), origin: 'http://127.0.0.1:7317', 'content-type': 'application/json',
  })

  it('lists the installed plugin, skills, sub-agents, MCPs and declared tools', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/configuration/capabilities', headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.counts).toMatchObject({ plugin: 1, skill: 1, agent: 1, mcp: 1, tool: 4 })
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', name: 'implementation', origin: 'built-in' }),
      expect.objectContaining({ kind: 'agent', name: 'reviewer' }),
      expect.objectContaining({ kind: 'mcp', name: 'context7' }),
      expect.objectContaining({ kind: 'tool', name: 'Write' }),
    ]))
  })

  it('creates user skills outside fde-core and registers the user plugin', async () => {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/configuration/skills', headers: mutationHeaders(harness.token),
      payload: { name: 'release-notes', description: 'Prepare verified release notes.',
        instructions: 'Summarise verified changes and call out migration steps.', tools: ['Read', 'Grep'] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', name: 'release-notes', origin: 'user', plugin: 'fde-user' }),
    ]))
    const skill = path.join(harness.config.sharedRoot, 'fde-toolkit', 'plugins', 'fde-user', 'skills', 'release-notes', 'SKILL.md')
    expect(readFileSync(skill, 'utf8')).toContain('allowed-tools: Read, Grep')
    const marketplace = JSON.parse(readFileSync(path.join(harness.config.sharedRoot, 'fde-toolkit', '.claude-plugin', 'marketplace.json'), 'utf8'))
    expect(marketplace.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fde-user' })]))
  })

  it('persists capability switches and protects the required core plugin', async () => {
    let response = await harness.app.inject({
      method: 'POST', url: '/api/configuration/capabilities/toggle', headers: mutationHeaders(harness.token),
      payload: { id: 'skill:fde-core:implementation', enabled: false },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill:fde-core:implementation', enabled: false }),
    ]))
    expect(JSON.parse(readFileSync(path.join(harness.config.sharedRoot, 'config', 'capability-policy.json'), 'utf8')).disabled)
      .toContain('skill:fde-core:implementation')

    response = await harness.app.inject({
      method: 'POST', url: '/api/configuration/capabilities/toggle', headers: mutationHeaders(harness.token),
      payload: { id: 'plugin:fde-core', enabled: false },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().title).toMatch(/required/i)
  })

  it('removes a switched-off hook from the active manifest and restores it', async () => {
    const target = path.join(harness.config.sharedRoot, 'fde-toolkit', 'plugins', 'fde-core', 'hooks', 'hooks.json')
    let response = await harness.app.inject({ method: 'POST', url: '/api/configuration/capabilities/toggle',
      headers: mutationHeaders(harness.token), payload: { id: 'hook:fde-core:SessionStart', enabled: false } })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(readFileSync(target, 'utf8')).hooks.SessionStart).toBeUndefined()
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'hook:fde-core:SessionStart', enabled: false }),
    ]))
    response = await harness.app.inject({ method: 'POST', url: '/api/configuration/capabilities/toggle',
      headers: mutationHeaders(harness.token), payload: { id: 'hook:fde-core:SessionStart', enabled: true } })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(readFileSync(target, 'utf8')).hooks.SessionStart).toBeDefined()
  })

  it('delegates MCP switches to the governed MCP controller', async () => {
    harness.fixture('mcp-enable-context7', { schemaVersion: 2, server: { name: 'context7', enabled: true } })
    const response = await harness.app.inject({ method: 'POST', url: '/api/configuration/capabilities/toggle',
      headers: mutationHeaders(harness.token), payload: { id: 'mcp:context7', enabled: true } })
    expect(response.statusCode).toBe(200)
    expect(harness.calls()).toContainEqual(['mcp', 'enable', 'context7', '--json'])
  })

  it('imports a valid local plugin and refuses to overwrite it', async () => {
    const source = path.join(harness.root, 'my-plugin')
    mkdirSync(path.join(source, '.claude-plugin'), { recursive: true })
    writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team-tools', description: 'Team plugin.' }))
    let response = await harness.app.inject({
      method: 'POST', url: '/api/configuration/plugins', headers: mutationHeaders(harness.token), payload: { sourcePath: source },
    })
    expect(response.statusCode).toBe(200)
    expect(existsSync(path.join(harness.config.sharedRoot, 'fde-toolkit', 'plugins', 'team-tools'))).toBe(true)

    response = await harness.app.inject({
      method: 'POST', url: '/api/configuration/plugins', headers: mutationHeaders(harness.token), payload: { sourcePath: source },
    })
    expect(response.statusCode).toBe(409)
  })

  it('rejects imported plugins containing symbolic links', async () => {
    const source = path.join(harness.root, 'linked-plugin')
    mkdirSync(path.join(source, '.claude-plugin'), { recursive: true })
    writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'linked-tools' }))
    symlinkSync('/etc/hosts', path.join(source, 'outside'))
    const response = await harness.app.inject({
      method: 'POST', url: '/api/configuration/plugins', headers: mutationHeaders(harness.token), payload: { sourcePath: source },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().title).toMatch(/symbolic links/i)
    expect(existsSync(path.join(harness.config.sharedRoot, 'fde-toolkit', 'plugins', 'linked-tools'))).toBe(false)
  })
})
