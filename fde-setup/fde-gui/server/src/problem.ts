import type { FastifyReply } from 'fastify'

/** Stable, machine-readable errors. Never a stack trace, never a raw exception. */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
}

export function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  detail?: string,
): FastifyReply {
  const body: ProblemDetails = { type: `about:fde/${code}`, title, status }
  if (detail !== undefined && detail !== '') body.detail = detail
  return reply.status(status).type('application/problem+json').send(body)
}
