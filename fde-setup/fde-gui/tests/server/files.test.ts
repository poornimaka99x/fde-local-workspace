import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, seedRunDirectory, type Harness } from './harness'

const RUN = '20260901-max-1-aaaa'

describe('run file browsing', () => {
  let harness: Harness
  let runDir: string

  beforeEach(async () => {
    harness = await makeHarness()
    runDir = seedRunDirectory(harness.runsRoot, RUN)
  })
  afterEach(async () => harness.destroy())

  const get = async (url: string) =>
    harness.app.inject({ method: 'GET', url, headers: authed(harness.token) })

  const content = async (filePath: string, disposition = 'inline') =>
    get(`/api/runs/${RUN}/files/content?path=${encodeURIComponent(filePath)}&disposition=${disposition}`)

  it('lists the run and withholds what must never be served as a file', async () => {
    const response = await get(`/api/runs/${RUN}/files`)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    const paths: string[] = body.entries.map((entry: { path: string }) => entry.path)

    expect(paths).toContain('artifacts/research/research-brief.md')
    expect(paths).toContain('inputs/files/requirements-ab12.txt')
    expect(paths).not.toContain('approvals.jsonl')
    expect(paths).not.toContain('orchestrator-session-id')
    expect(paths.some((entry) => entry.startsWith('mcp/'))).toBe(false)
    expect(body.withheld).toEqual(
      expect.arrayContaining(['approvals.jsonl', 'orchestrator-session-id', 'mcp']),
    )
  })

  it('shows a symlink as a symlink and does not follow it', async () => {
    const body = (await get(`/api/runs/${RUN}/files`)).json()
    const link = body.entries.find((entry: { path: string }) => entry.path === 'artifacts/escape.txt')
    expect(link).toMatchObject({ kind: 'symlink', downloadable: false })
    const inside = body.entries.filter((entry: { path: string }) => entry.path.startsWith('artifacts/up/'))
    expect(inside).toHaveLength(0)
  })

  it('refuses traversal, absolute paths and anything outside the run', async () => {
    for (const candidate of [
      '../../etc/passwd',
      '..',
      '/etc/passwd',
      'artifacts/../../../etc/passwd',
      './artifacts/research/research-brief.md',
      '',
    ]) {
      const response = await content(candidate)
      expect(response.statusCode, candidate).toBe(400)
    }
  })

  it('refuses to read through a symlink, whether it is the file or a parent', async () => {
    expect((await content('artifacts/escape.txt')).statusCode).toBe(403)
    const throughDir = await content('artifacts/up/runs/anything.txt')
    expect([403, 404]).toContain(throughDir.statusCode)
  })

  it('refuses the approval ledger and run-scoped connector configuration', async () => {
    expect((await content('approvals.jsonl')).statusCode).toBe(403)
    expect((await content('orchestrator-session-id')).statusCode).toBe(403)
    expect((await content('mcp/claude-work.mcp.json')).statusCode).toBe(403)
  })

  it('serves text inline, inert, and never as active content', async () => {
    const response = await content('artifacts/research/research-brief.md')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/markdown')
    expect(response.headers['content-disposition']).toContain('inline')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(String(response.headers['content-security-policy'])).toContain('sandbox')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.payload).toContain('# Brief')
  })

  it('hands anything active over as an opaque download', async () => {
    const response = await content('artifacts/research/notes.html')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(response.headers['content-disposition']).toContain('attachment')
  })

  it('downloads on request even for a previewable type', async () => {
    const response = await content('artifacts/research/research-brief.md', 'attachment')
    expect(response.headers['content-disposition']).toContain('attachment')
    expect(response.headers['content-type']).toBe('application/octet-stream')
  })

  it('truncates a large text preview and says so', async () => {
    const big = path.join(runDir, 'artifacts', 'research', 'big.txt')
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 2048))
    const preview = await content('artifacts/research/big.txt')
    expect(preview.headers['x-fde-truncated']).toBe('true')
    expect(preview.rawPayload.length).toBe(1024 * 1024)

    const download = await content('artifacts/research/big.txt', 'attachment')
    expect(download.headers['x-fde-truncated']).toBe('false')
    expect(download.rawPayload.length).toBe(1024 * 1024 + 2048)
  })

  it('404s a file that is not there, and 400s a directory', async () => {
    expect((await content('artifacts/research/nope.md')).statusCode).toBe(404)
    expect((await content('artifacts/research')).statusCode).toBe(400)
  })

  it('404s a run directory that does not exist on disk', async () => {
    const response = await get('/api/runs/20260101-gone-9999/files')
    expect(response.statusCode).toBe(404)
  })

  it('refuses a run directory that is a symlink to somewhere else', async () => {
    const elsewhere = path.join(harness.root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(path.join(elsewhere, 'secret.txt'), 'not part of any run')
    symlinkSync(elsewhere, path.join(harness.runsRoot, '20260101-planted-0000'))

    const listing = await get('/api/runs/20260101-planted-0000/files')
    expect(listing.statusCode).toBe(403)
    expect(listing.json()).toMatchObject({ type: 'about:fde/symlink' })

    const read = await get(
      '/api/runs/20260101-planted-0000/files/content?path=secret.txt&disposition=inline',
    )
    expect(read.statusCode).toBe(403)
    expect(read.payload).not.toContain('not part of any run')
  })

  it('refuses a run that is not directly inside the runs root', async () => {
    mkdirSync(path.join(harness.runsRoot, 'nested', '20260101-deep-0000'), { recursive: true })
    writeFileSync(path.join(harness.runsRoot, 'nested', '20260101-deep-0000', 'a.txt'), 'x')
    const response = await get('/api/runs/nested%2F20260101-deep-0000/files')
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.statusCode).toBeLessThan(500)
  })
})
