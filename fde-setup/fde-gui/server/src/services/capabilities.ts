import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { GuiConfig } from '../config'

export type CapabilityKind =
  | 'plugin' | 'skill' | 'agent' | 'mcp' | 'tool' | 'command' | 'hook' | 'script'

export interface CapabilityItem {
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

export interface CapabilityCatalog {
  schemaVersion: 1
  extensionRoot: string
  items: CapabilityItem[]
  counts: Record<CapabilityKind, number>
  warnings: string[]
}

interface PluginManifest {
  name: string
  description?: string
  version?: string
}

interface DisabledHook { item: CapabilityItem, payload: unknown }
interface CapabilityPolicy {
  schemaVersion: 1
  disabled: string[]
  disabledHooks: Record<string, DisabledHook>
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,62}$/
const SKILL_NAME = /^[a-z][a-z0-9-]{1,62}$/
const MAX_PLUGIN_FILES = 1_000
const MAX_PLUGIN_BYTES = 20 * 1024 * 1024

function extensionRoot(config: GuiConfig): string {
  return path.join(config.sharedRoot, 'fde-toolkit', 'plugins')
}

function policyPath(config: GuiConfig): string {
  return path.join(config.sharedRoot, 'config', 'capability-policy.json')
}

async function readPolicy(config: GuiConfig): Promise<CapabilityPolicy> {
  try {
    const raw = await jsonFile(policyPath(config)) as Partial<CapabilityPolicy>
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.disabled)) {
      throw new Error('The capability policy is invalid; FLOW will not silently enable capabilities.')
    }
    const hooks = raw.disabledHooks && typeof raw.disabledHooks === 'object'
      ? raw.disabledHooks as Record<string, DisabledHook> : {}
    return { schemaVersion: 1,
      disabled: raw.disabled.filter((item): item is string => typeof item === 'string'),
      disabledHooks: hooks }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, disabled: [], disabledHooks: {} }
    }
    throw error
  }
}

async function writePolicy(config: GuiConfig, policy: CapabilityPolicy): Promise<void> {
  const target = policyPath(config)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1,
    disabled: [...new Set(policy.disabled)].sort(), disabledHooks: policy.disabledHooks }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

function relativeSource(config: GuiConfig, target: string): string {
  const relative = path.relative(config.sharedRoot, target)
  return relative.startsWith('..') ? target : `~/.claude-shared/${relative}`
}

function frontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith('---\n')) return {}
  const end = markdown.indexOf('\n---', 4)
  if (end < 0) return {}
  const fields: Record<string, string> = {}
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line)
    const key = match?.[1]
    const value = match?.[2]
    if (key !== undefined && value !== undefined) {
      fields[key.toLowerCase()] = value.trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return fields
}

function declaredTools(value: string | undefined): string[] {
  if (!value) return []
  return value.replace(/^\[|\]$/g, '').split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

async function jsonFile(target: string): Promise<unknown> {
  return JSON.parse(await readFile(target, 'utf8')) as unknown
}

async function markdownItems(
  config: GuiConfig,
  plugin: string,
  origin: 'built-in' | 'user',
  directory: string,
  kind: 'skill' | 'agent' | 'command',
): Promise<CapabilityItem[]> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return [] }
  const results: CapabilityItem[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = kind === 'skill'
      ? path.join(directory, entry.name, 'SKILL.md')
      : path.join(directory, entry.name)
    if ((kind === 'skill' && !entry.isDirectory()) || (kind !== 'skill' && !entry.isFile())) continue
    if (kind !== 'skill' && !entry.name.endsWith('.md')) continue
    try {
      const raw = await readFile(target, 'utf8')
      const meta = frontmatter(raw)
      const name = meta.name || (kind === 'skill' ? entry.name : path.basename(entry.name, '.md'))
      results.push({
        id: `${kind}:${plugin}:${name}`,
        kind,
        name,
        description: meta.description || 'No description provided.',
        origin,
        plugin,
        source: relativeSource(config, target),
        tools: declaredTools(meta['allowed-tools'] ?? meta.tools),
        enabled: true,
        toggleable: true,
        ...(meta.model ? { detail: `Model: ${meta.model}` } : {}),
      })
    } catch { /* a malformed entry is reported by the caller's warning count */ }
  }
  return results
}

async function pluginItems(config: GuiConfig, warnings: string[]): Promise<CapabilityItem[]> {
  const root = extensionRoot(config)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const items: CapabilityItem[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const pluginRoot = path.join(root, entry.name)
    let manifest: PluginManifest
    try {
      const raw = await jsonFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))
      if (!raw || typeof raw !== 'object' || typeof (raw as { name?: unknown }).name !== 'string') throw new Error()
      manifest = raw as PluginManifest
    } catch {
      warnings.push(`${entry.name}: missing or invalid .claude-plugin/plugin.json`)
      continue
    }
    const origin = manifest.name === 'fde-core' ? 'built-in' : 'user'
    items.push({
      id: `plugin:${manifest.name}`,
      kind: 'plugin',
      name: manifest.name,
      description: manifest.description ?? 'No description provided.',
      origin,
      plugin: manifest.name,
      source: relativeSource(config, pluginRoot),
      tools: [],
      enabled: true,
      toggleable: manifest.name !== 'fde-core',
      ...(manifest.name === 'fde-core' ? { disabledReason: 'fde-core is required by the FLOW control plane.' } : {}),
      ...(manifest.version ? { detail: `Version ${manifest.version}` } : {}),
    })
    for (const [directory, kind] of [
      ['skills', 'skill'], ['agents', 'agent'], ['commands', 'command'],
    ] as const) {
      items.push(...await markdownItems(config, manifest.name, origin, path.join(pluginRoot, directory), kind))
    }
    try {
      const hooks = await jsonFile(path.join(pluginRoot, 'hooks', 'hooks.json')) as { hooks?: Record<string, unknown[]> }
      for (const event of Object.keys(hooks.hooks ?? {}).sort()) {
        items.push({ id: `hook:${manifest.name}:${event}`, kind: 'hook', name: event,
          description: `Runs for the ${event} lifecycle event.`, origin, plugin: manifest.name,
          source: relativeSource(config, path.join(pluginRoot, 'hooks', 'hooks.json')), tools: [],
          enabled: true, toggleable: true })
      }
    } catch { /* hooks are optional */ }
    for (const directory of ['bin', 'scripts'] as const) {
      try {
        const scripts = await readdir(path.join(pluginRoot, directory), { withFileTypes: true })
        for (const script of scripts.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!script.isFile() || script.name.startsWith('.')) continue
          items.push({ id: `script:${manifest.name}:${directory}:${script.name}`, kind: 'script',
            name: script.name, description: `${directory === 'bin' ? 'Runtime helper' : 'Plugin utility'} supplied by ${manifest.name}.`,
            origin, plugin: manifest.name, source: relativeSource(config, path.join(pluginRoot, directory, script.name)), tools: [],
            enabled: true, toggleable: false })
        }
      } catch { /* scripts are optional */ }
    }
  }
  return items
}

async function mcpItems(config: GuiConfig, warnings: string[]): Promise<CapabilityItem[]> {
  const target = path.join(config.sharedRoot, 'mcp', 'mcp-servers.json')
  try {
    const raw = await jsonFile(target) as { servers?: Record<string, Record<string, unknown>> }
    let configured: { servers?: Record<string, { enabled?: unknown }> } = {}
    try { configured = await jsonFile(path.join(config.sharedRoot, 'config', 'mcp-user-config.json')) as typeof configured } catch { /* optional */ }
    return Object.entries(raw.servers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, server]) => ({
      id: `mcp:${name}`,
      kind: 'mcp' as const,
      name,
      description: typeof server.useWhen === 'string'
        ? server.useWhen
        : typeof server.note === 'string' ? server.note : 'MCP server.',
      origin: 'built-in' as const,
      plugin: null,
      source: relativeSource(config, target),
      tools: Array.isArray(server.allowTools) ? server.allowTools.filter((item): item is string => typeof item === 'string') : [],
      enabled: configured.servers?.[name]?.enabled === true,
      toggleable: true,
      detail: [server.transport, server.classification, server.mutation].filter((item) => typeof item === 'string').join(' · '),
    }))
  } catch {
    warnings.push('mcp/mcp-servers.json: missing or invalid')
    return []
  }
}

export async function readCapabilityCatalog(config: GuiConfig): Promise<CapabilityCatalog> {
  const warnings: string[] = []
  const items = [...await pluginItems(config, warnings), ...await mcpItems(config, warnings)]
  const toolOwners = new Map<string, { owners: Set<string>, userOnly: boolean }>()
  for (const item of items) {
    if (item.kind === 'mcp') continue
    for (const tool of item.tools) {
      const record = toolOwners.get(tool) ?? { owners: new Set<string>(), userOnly: true }
      record.owners.add(item.name)
      if (item.origin === 'built-in') record.userOnly = false
      toolOwners.set(tool, record)
    }
  }
  for (const [name, record] of [...toolOwners].sort(([a], [b]) => a.localeCompare(b))) {
    const owners = record.owners
    items.push({ id: `tool:${name}`, kind: 'tool', name,
      description: `Declared by ${[...owners].sort().join(', ')}.`, origin: record.userOnly ? 'user' : 'built-in', plugin: null,
      source: 'plugin frontmatter', tools: [], enabled: true, toggleable: true,
      detail: `${owners.size} capability declaration${owners.size === 1 ? '' : 's'}` })
  }
  const policy = await readPolicy(config)
  for (const [id, record] of Object.entries(policy.disabledHooks)) {
    if (!items.some((item) => item.id === id) && record?.item?.kind === 'hook') {
      items.push({ ...record.item, enabled: false, toggleable: true })
    }
  }
  const disabled = new Set(policy.disabled)
  const disabledPlugins = new Set(items.filter((item) => item.kind === 'plugin' && disabled.has(item.id)).map((item) => item.name))
  for (const item of items) {
    if (item.kind === 'mcp') continue
    const inherited = item.plugin !== null && item.kind !== 'plugin' && disabledPlugins.has(item.plugin)
    if (disabled.has(item.id) || inherited) {
      item.enabled = false
      item.disabledReason = inherited ? `The ${item.plugin} plugin is switched off.` : 'Switched off in the FLOW capability policy.'
      if (inherited) item.toggleable = false
    }
    if (item.kind === 'command' || item.kind === 'script') {
      item.toggleable = false
      item.disabledReason = 'Commands and runtime utilities are inventory-only.'
    }
  }
  const kinds: CapabilityKind[] = ['plugin', 'skill', 'agent', 'mcp', 'tool', 'command', 'hook', 'script']
  const counts = Object.fromEntries(kinds.map((kind) => [kind, items.filter((item) => item.kind === kind).length])) as Record<CapabilityKind, number>
  return { schemaVersion: 1, extensionRoot: extensionRoot(config), items, counts, warnings }
}

export async function setCapabilityEnabled(config: GuiConfig, id: string, enabled: boolean): Promise<CapabilityCatalog> {
  const catalog = await readCapabilityCatalog(config)
  const item = catalog.items.find((candidate) => candidate.id === id)
  if (!item) throw new Error('That capability is not in the installed catalogue.')
  if (!item.toggleable) throw new Error(item.disabledReason ?? 'That capability cannot be switched.')
  if (item.kind === 'mcp') throw new Error('MCP switches must be applied through the MCP controller.')
  const policy = await readPolicy(config)
  const disabled = new Set(policy.disabled)
  if (item.kind === 'hook' && item.plugin !== null) {
    const target = path.join(extensionRoot(config), item.plugin, 'hooks', 'hooks.json')
    const raw = await jsonFile(target) as { hooks?: Record<string, unknown> }
    const hooks = raw.hooks ?? {}
    if (enabled) {
      const stored = policy.disabledHooks[id]
      if (stored !== undefined) hooks[item.name] = stored.payload
      delete policy.disabledHooks[id]
    } else {
      if (hooks[item.name] === undefined) throw new Error('That hook is not present in its plugin manifest.')
      policy.disabledHooks[id] = { item, payload: hooks[item.name] }
      delete hooks[item.name]
    }
    raw.hooks = hooks
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }
  if (enabled) disabled.delete(id); else disabled.add(id)
  await writePolicy(config, { schemaVersion: 1, disabled: [...disabled], disabledHooks: policy.disabledHooks })
  return await readCapabilityCatalog(config)
}

async function ensureMarketplace(config: GuiConfig, manifest: PluginManifest): Promise<void> {
  const toolkit = path.join(config.sharedRoot, 'fde-toolkit')
  const directory = path.join(toolkit, '.claude-plugin')
  const target = path.join(directory, 'marketplace.json')
  await mkdir(directory, { recursive: true })
  let marketplace: { name: string, owner: { name: string }, plugins: Array<Record<string, unknown>> }
  try {
    const raw = await jsonFile(target) as typeof marketplace
    marketplace = { name: typeof raw.name === 'string' ? raw.name : 'fde-toolkit',
      owner: raw.owner && typeof raw.owner.name === 'string' ? raw.owner : { name: 'FLOW user' },
      plugins: Array.isArray(raw.plugins) ? raw.plugins : [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The existing marketplace.json is invalid; it was left unchanged.')
    marketplace = { name: 'fde-toolkit', owner: { name: 'FLOW user' }, plugins: [] }
  }
  if (!marketplace.plugins.some((plugin) => plugin.name === manifest.name)) {
    marketplace.plugins.push({ name: manifest.name, source: `./plugins/${manifest.name}`,
      description: manifest.description ?? 'User-provided FLOW plugin.' })
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

export async function createUserSkill(config: GuiConfig, input: {
  name: string, description: string, instructions: string, tools: string[],
}): Promise<CapabilityCatalog> {
  const pluginRoot = path.join(extensionRoot(config), 'fde-user')
  const skillRoot = path.join(pluginRoot, 'skills', input.name)
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
  const manifest: PluginManifest = { name: 'fde-user', version: '1.0.0',
    description: 'User-defined skills managed from FLOW.' }
  await mkdir(path.join(pluginRoot, 'skills'), { recursive: true })
  try { await access(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), constants.F_OK) } catch {
    await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  await mkdir(skillRoot, { recursive: false })
  const header = ['---', `name: ${input.name}`, `description: ${JSON.stringify(input.description)}`]
  if (input.tools.length > 0) header.push(`allowed-tools: ${input.tools.join(', ')}`)
  header.push('---', '', `# ${input.name}`, '', input.instructions.trim(), '')
  try {
    await writeFile(path.join(skillRoot, 'SKILL.md'), header.join('\n'), { flag: 'wx', mode: 0o600 })
    await ensureMarketplace(config, manifest)
  } catch (error) {
    await rm(skillRoot, { recursive: true, force: true }); throw error
  }
  return await readCapabilityCatalog(config)
}

async function validatePluginTree(root: string): Promise<void> {
  let files = 0; let bytes = 0
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const info = await lstat(target)
      if (info.isSymbolicLink()) throw new Error('Plugins containing symbolic links are not accepted.')
      if (info.isDirectory()) await visit(target)
      else if (info.isFile()) { files += 1; bytes += info.size }
      else throw new Error('Plugins may contain regular files and directories only.')
      if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) throw new Error('Plugin is larger than the 1,000-file / 20 MB import limit.')
    }
  }
  await visit(root)
}

export async function importUserPlugin(config: GuiConfig, sourcePath: string): Promise<CapabilityCatalog> {
  if (!path.isAbsolute(sourcePath)) throw new Error('Use an absolute path to a local plugin directory.')
  const source = await realpath(sourcePath)
  const manifestRaw = await jsonFile(path.join(source, '.claude-plugin', 'plugin.json')) as PluginManifest
  if (!manifestRaw || typeof manifestRaw.name !== 'string' || !PLUGIN_NAME.test(manifestRaw.name) || manifestRaw.name === 'fde-core') {
    throw new Error('The plugin manifest must contain a valid, non-reserved name.')
  }
  await validatePluginTree(source)
  const root = extensionRoot(config)
  const target = path.join(root, manifestRaw.name)
  await mkdir(root, { recursive: true })
  try { await access(target, constants.F_OK); throw new Error(`A plugin named ${manifestRaw.name} already exists.`) }
  catch (error) { if (error instanceof Error && error.message.startsWith('A plugin named')) throw error }
  const temporary = path.join(root, `.${manifestRaw.name}.${randomUUID()}.tmp`)
  let installed = false
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true })
    await rename(temporary, target)
    installed = true
    await ensureMarketplace(config, manifestRaw)
  }
  catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (installed) await rm(target, { recursive: true, force: true })
    throw error
  }
  return await readCapabilityCatalog(config)
}

export function validSkillName(name: string): boolean { return SKILL_NAME.test(name) }
