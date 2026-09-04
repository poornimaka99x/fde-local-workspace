import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { BrowsePathError, browseDirectory } from '../services/browse'

const browseQuery = z.object({ path: z.string().max(4096).optional() })

/** A "choose a folder" dialog for the console: names only, read-only, no upload. */
export function registerFsRoutes(app: FastifyInstance, config: GuiConfig): void {
  app.get('/api/fs/browse', async (request, reply) => {
    const parsed = browseQuery.safeParse(request.query)
    if (!parsed.success) return problem(reply, 400, 'invalid-query', 'Unusable path.')
    try {
      return await browseDirectory(parsed.data.path, config.home)
    } catch (error) {
      if (error instanceof BrowsePathError) return problem(reply, error.status, error.code, error.message)
      throw error
    }
  })
}
