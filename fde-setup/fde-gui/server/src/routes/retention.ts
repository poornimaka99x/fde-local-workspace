import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { problem } from '../problem'
import type { Services } from '../services/types'

const updateSchema = z.object({
  enabled: z.boolean(),
  completedRunDays: z.number().int().min(1).max(3650),
}).strict()

export function registerRetentionRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/configuration/retention', async () => ({
    settings: await services.retention.read(),
  }))

  app.put('/api/configuration/retention', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-retention',
        'Retention must be between 1 and 3650 days.')
    }
    const settings = await services.retention.write({ schemaVersion: 1, ...parsed.data })
    try {
      const sweep = await services.retention.sweep()
      return { settings, sweep, warning: null }
    } catch {
      // The persisted preference is still valid. A transient controller error
      // must not make the UI claim the save failed; the hourly sweep retries.
      return {
        settings,
        sweep: null,
        warning: 'Settings were saved. Cleanup could not run now and will retry automatically.',
      }
    }
  })
}
