import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { createUserSkill, importUserPlugin, readCapabilityCatalog, setCapabilityEnabled, validSkillName } from '../services/capabilities'
import { runControllerJson } from '../services/controller'
import type { Services } from '../services/types'

const skillBody = z.object({
  name: z.string().min(2).max(63).refine(validSkillName, 'Use lower-case letters, numbers and hyphens.'),
  description: z.string().min(8).max(500),
  instructions: z.string().min(8).max(50_000),
  tools: z.array(z.enum(['Read', 'Grep', 'Glob', 'Bash', 'Task', 'Write', 'Edit', 'WebSearch', 'WebFetch'])).max(9).default([]),
})
const pluginBody = z.object({ sourcePath: z.string().min(1).max(4096) })
const toggleBody = z.object({ id: z.string().min(3).max(256), enabled: z.boolean() })

function extensionProblem(reply: Parameters<typeof problem>[0], error: unknown) {
  const message = error instanceof Error ? error.message : 'The extension could not be added.'
  const conflict = /already exists|EEXIST/.test(message)
  return problem(reply, conflict ? 409 : 400, conflict ? 'extension-exists' : 'invalid-extension', message)
}

export function registerCapabilityRoutes(app: FastifyInstance, config: GuiConfig, services: Services): void {
  app.get('/api/configuration/capabilities', async () => await readCapabilityCatalog(config))

  app.post('/api/configuration/skills', async (request, reply) => {
    const body = skillBody.safeParse(request.body)
    if (!body.success) return problem(reply, 400, 'invalid-skill', 'Enter a valid skill name, description and instructions.')
    try {
      const result = await createUserSkill(config, body.data)
      services.watcher.touch(); return result
    } catch (error) { return extensionProblem(reply, error) }
  })

  app.post('/api/configuration/plugins', async (request, reply) => {
    const body = pluginBody.safeParse(request.body)
    if (!body.success) return problem(reply, 400, 'invalid-plugin', 'Choose a local plugin directory.')
    try {
      const result = await importUserPlugin(config, body.data.sourcePath)
      services.watcher.touch(); return result
    } catch (error) { return extensionProblem(reply, error) }
  })

  app.post('/api/configuration/capabilities/toggle', async (request, reply) => {
    const body = toggleBody.safeParse(request.body)
    if (!body.success) return problem(reply, 400, 'invalid-capability', 'Choose a valid capability state.')
    try {
      if (body.data.id.startsWith('mcp:')) {
        const server = body.data.id.slice(4)
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(server)) return problem(reply, 400, 'invalid-capability', 'Invalid MCP server name.')
        await runControllerJson(config, ['mcp', body.data.enabled ? 'enable' : 'disable', server, '--json'])
      } else {
        await setCapabilityEnabled(config, body.data.id, body.data.enabled)
      }
      services.watcher.touch()
      return await readCapabilityCatalog(config)
    } catch (error) { return extensionProblem(reply, error) }
  })
}
