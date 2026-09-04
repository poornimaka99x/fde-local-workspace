import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GuiConfig } from '../config'
import { problem } from '../problem'
import { PROJECT_ID_PATTERN, runControllerJson } from '../services/controller'
import { projectDetailSchema, projectListSchema } from '../schemas/controller'
import type { Services } from '../services/types'
import { block, describeZod, line } from '../schemas/input'

const createBody = z.object({
  name: line(200)
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'a project needs a name')),
  description: block(2000).optional(),
  repoPaths: z.array(line(1024).pipe(z.string().min(1))).max(20).optional(),
})

const updateBody = z
  .object({
    name: line(200)
      .transform((value) => value.trim())
      .pipe(z.string().min(1, 'a project needs a name'))
      .optional(),
    description: block(2000).optional(),
    repoPaths: z.array(line(1024).pipe(z.string().min(1))).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update')

export function registerProjectRoutes(
  app: FastifyInstance,
  config: GuiConfig,
  services: Services,
): void {
  app.get('/api/projects', async () => {
    const raw = await runControllerJson(config, ['projects', '--json'])
    return projectListSchema.parse(raw)
  })

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return problem(reply, 400, 'invalid-project-id', 'That is not a valid project id.')
    }
    const raw = await runControllerJson(config, ['project', 'show', projectId, '--json'])
    return projectDetailSchema.parse(raw)
  })

  // -- mutations. The controller does every write; this only asks it to. -----

  app.post('/api/projects', async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'invalid-body',
        'That project cannot be created as described.', describeZod(parsed.error))
    }
    const release = services.locks.tryAcquire('project:create')
    if (release === null) {
      return problem(reply, 409, 'busy', 'Another project is being created right now.')
    }
    try {
      const args = ['project', 'create', '--name', parsed.data.name]
      if (parsed.data.description !== undefined) args.push('--description', parsed.data.description)
      for (const repo of parsed.data.repoPaths ?? []) args.push('--repo', repo)
      args.push('--json')
      const raw = await runControllerJson(config, args)
      services.watcher.touch()
      return await reply.status(201).send(raw)
    } finally {
      release()
    }
  })

  app.patch<{ Params: { projectId: string } }>(
    '/api/projects/:projectId',
    async (request, reply) => {
      const { projectId } = request.params
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        return problem(reply, 400, 'invalid-project-id', 'That is not a valid project id.')
      }
      const parsed = updateBody.safeParse(request.body)
      if (!parsed.success) {
        return problem(reply, 400, 'invalid-body',
          'That change cannot be made as described.', describeZod(parsed.error))
      }
      const release = services.locks.tryAcquire('project:' + projectId)
      if (release === null) {
        return problem(reply, 409, 'busy',
          'This project is being changed right now. Refresh and try again.')
      }
      try {
        const args = ['project', 'update', projectId]
        if (parsed.data.name !== undefined) args.push('--name', parsed.data.name)
        if (parsed.data.description !== undefined) {
          args.push('--description', parsed.data.description)
        }
        for (const repo of parsed.data.repoPaths ?? []) args.push('--repo', repo)
        args.push('--json')
        const raw = await runControllerJson(config, args)
        services.watcher.touch()
        return raw
      } finally {
        release()
      }
    },
  )
}
