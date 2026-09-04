import { z } from 'zod'

/**
 * Values that become argv, a filename or a stored record. Control characters
 * are refused outright: they have no place in a project name, a requirement or
 * an upload's filename, and they are how a plausible-looking string turns into
 * something else further down.
 */
const CONTROL = /[\u0000-\u001F\u007F]/
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** Single-line text: no control characters at all. */
export const line = (max: number) =>
  z.string().max(max).refine((value) => !CONTROL.test(value), 'control characters are not allowed')

/** Multi-line text: tabs and newlines are fine, nothing else is. */
export const block = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !MULTILINE_CONTROL.test(value), 'control characters are not allowed')

export function describeZod(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ')
}
