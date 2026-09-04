import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authed, makeHarness, type Harness } from './harness'

describe('the local path picker', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await makeHarness()
  })
  afterEach(async () => harness.destroy())

  it('lists metadata but never returns file content', async () => {
    const folder = path.join(harness.root, 'picker')
    mkdirSync(path.join(folder, 'repository'), { recursive: true })
    mkdirSync(path.join(folder, '.ssh'), { recursive: true })
    writeFileSync(path.join(folder, 'notes.txt'), 'content-must-stay-server-side')
    writeFileSync(path.join(folder, '.env'), 'PASSWORD=not-returned')
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/fs/browse?path=${encodeURIComponent(folder)}`,
      headers: authed(harness.token),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().entries).toMatchObject([
      { name: 'notes.txt', kind: 'file' },
      { name: 'repository', kind: 'directory' },
    ])
    expect(response.payload).not.toContain('content-must-stay-server-side')
    expect(response.payload).not.toContain('.ssh')
    expect(response.payload).not.toContain('.env')
  })

  it('still requires the per-launch token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/fs/browse' })
    expect(response.statusCode).toBe(401)
  })
})
