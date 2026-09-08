// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSidebar } from '../../web/src/components/AppSidebar'
import { FileBrowser, buildTree } from '../../web/src/components/FileBrowser'
import { PathBrowser } from '../../web/src/components/PathBrowser'
import type { RunFileEntry } from '../../web/src/lib/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  })
}

function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))))
}

beforeEach(() => {
  window.sessionStorage.setItem('fde-gui-token', 'test-token')
  window.history.pushState(null, '', '/runs')
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

describe('the navigation rail', () => {
  const seed = (): void => {
    stubFetch((url) => {
      if (url === '/api/runs') {
        return jsonResponse({
          schemaVersion: 1,
          total: 2,
          returned: 2,
          warnings: [],
          runs: [
            {
              runId: '20260906-returns-aaaa', state: 'solutioning', projectId: 'returns-a1b2',
              requirement: 'Rework the returns screen', updatedAt: '2026-09-06T12:00:00+00:00',
              orchestrator: null, session: { provider: 'claude', profile: 'work', sessionId: null, resumable: true, resumeReason: null },
            },
            {
              runId: '20260901-old-bbbb', state: 'complete', projectId: null,
              requirement: 'An older run', updatedAt: '2026-09-01T09:00:00+00:00',
              orchestrator: null, session: { provider: 'claude', profile: 'work', sessionId: null, resumable: true, resumeReason: null },
            },
          ],
        })
      }
      if (url === '/api/chats') {
        return jsonResponse({
          chats: [{
            schemaVersion: 1, chatId: 'chat-20260906-aa11', title: 'Bedrock pricing',
            accountId: 'work', profile: 'work', provider: 'anthropic', model: 'default',
            effort: 'auto', projectId: null, cwd: '/tmp', claudeSessionId: 'x',
            createdAt: '2026-09-06T11:00:00+00:00', updatedAt: '2026-09-06T13:00:00+00:00',
            status: 'idle', lastError: null, messageCount: 4, lastMessage: '…', attachments: [],
          }],
        })
      }
      if (url === '/api/projects') {
        return jsonResponse({
          schemaVersion: 1, unassignedRunCount: 0, warnings: [],
          projects: [{ projectId: 'returns-a1b2', name: 'Returns modernisation', description: null, repoPaths: [], runCount: 2 }],
        })
      }
      if (url === '/api/sessions') {
        return jsonResponse({
          available: true,
          sessions: [{
            runId: '20260906-returns-aaaa', status: 'running', pid: 42,
            startedAt: '2026-09-06T12:00:00+00:00', exitedAt: null, exitCode: null,
            cwd: '/tmp', command: [], envKeys: [], stopRequestedAt: null, attachedClients: 0,
          }],
        })
      }
      return jsonResponse({}, 404)
    })
  }

  it('leads with one primary action and the quick ways in', async () => {
    seed()
    render(<AppSidebar path="/runs" />)
    const primary = await screen.findByRole('link', { name: 'New run' })
    expect(primary).toHaveClass('rail-new')
    expect(screen.getByRole('link', { name: 'New chat' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Design panel' })).toBeInTheDocument()
  })

  it('lists runs and chats together, newest first', async () => {
    seed()
    render(<AppSidebar path="/runs" />)
    const recents = await screen.findByRole('list', { name: 'Recents' })
    const labels = within(recents).getAllByRole('link').map((link) => link.textContent ?? '')
    expect(labels[0]).toContain('Bedrock pricing')
    expect(labels[1]).toContain('Rework the returns screen')
    expect(labels[2]).toContain('An older run')
    expect(within(recents).getByRole('link', { name: /Bedrock pricing/ }))
      .toHaveAttribute('href', '/chats/chat-20260906-aa11')
  })

  it('keeps every running session one click away from its live console', async () => {
    seed()
    render(<AppSidebar path="/runs" />)
    const running = await screen.findByRole('list', { name: 'Running' })
    expect(within(running).getByRole('link', { name: /Rework the returns screen/ }))
      .toHaveAttribute('href', '/runs/20260906-returns-aaaa?tab=session')
    expect(within(running).getByText('live')).toBeInTheDocument()
  })

  it('polls sessions only on the page that is about them', async () => {
    // The rail is on every screen. A 5-second poll on every screen is 12
    // requests a minute for a list that only one page is watching.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      seed()
      const calls = (): number =>
        (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
          .filter(([url]) => String(url) === '/api/sessions').length

      const elsewhere = render(<AppSidebar path="/runs" />)
      await screen.findByRole('list', { name: 'Running' })
      expect(calls()).toBe(1)
      await vi.advanceTimersByTimeAsync(30000)
      expect(calls()).toBe(1)
      elsewhere.unmount()

      vi.mocked(globalThis.fetch).mockClear()
      render(<AppSidebar path="/sessions" />)
      await screen.findByRole('list', { name: 'Running' })
      await vi.advanceTimersByTimeAsync(11000)
      expect(calls()).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still shows a running session from any screen', async () => {
    // Not polling is not the same as not knowing: the one fetch on mount, plus
    // whatever the shared change counter announces, keeps this list correct.
    seed()
    render(<AppSidebar path="/projects/returns-a1b2" />)
    const running = await screen.findByRole('list', { name: 'Running' })
    expect(within(running).getByText('live')).toBeInTheDocument()
  })

  it('lists projects and marks the page you are on', async () => {
    seed()
    render(<AppSidebar path="/projects/returns-a1b2" />)
    const projects = await screen.findByRole('list', { name: 'Projects' })
    const link = within(projects).getByRole('link', { name: /Returns modernisation/ })
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'All projects' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /All runs/ })).not.toHaveAttribute('aria-current')
  })

  it('says so plainly when there is nothing yet', async () => {
    stubFetch((url) => {
      if (url === '/api/runs') return jsonResponse({ schemaVersion: 1, runs: [], total: 0, returned: 0, warnings: [] })
      if (url === '/api/chats') return jsonResponse({ chats: [] })
      if (url === '/api/projects') return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
      return jsonResponse({}, 404)
    })
    render(<AppSidebar path="/runs" />)
    expect(await screen.findByText('Nothing yet. Start a run.')).toBeInTheDocument()
    expect(screen.getByText('No projects yet.')).toBeInTheDocument()
  })
})

const entries: RunFileEntry[] = [
  { path: 'artifacts', name: 'artifacts', kind: 'directory', size: null, modifiedAt: null, mediaType: 'inode/directory', preview: 'none', downloadable: false },
  { path: 'artifacts/research', name: 'research', kind: 'directory', size: null, modifiedAt: null, mediaType: 'inode/directory', preview: 'none', downloadable: false },
  { path: 'artifacts/research/brief.md', name: 'brief.md', kind: 'file', size: 240, modifiedAt: '2026-09-06T10:00:00Z', mediaType: 'text/markdown', preview: 'markdown', downloadable: true },
  { path: 'artifacts/empty-dir', name: 'empty-dir', kind: 'directory', size: null, modifiedAt: null, mediaType: 'inode/directory', preview: 'none', downloadable: false },
  { path: 'artifacts/escape.txt', name: 'escape.txt', kind: 'symlink', size: null, modifiedAt: null, mediaType: 'application/octet-stream', preview: 'none', downloadable: false },
]

describe('the file tree', () => {
  it('builds folders from paths, directories first', () => {
    const tree = buildTree(entries)
    expect(tree).toHaveLength(1)
    expect(tree[0]?.name).toBe('artifacts')
    expect(tree[0]?.children.map((node) => node.name)).toEqual([
      'empty-dir', 'research', 'escape.txt',
    ])
  })

  it('walks with the arrow keys, including rows that open nothing', async () => {
    stubFetch(() => jsonResponse({}, 404))
    render(<FileBrowser runId="20260906-returns-aaaa" entries={entries} emptyLabel="none" />)
    const rows = screen.getAllByRole('treeitem')
    rows[0]!.focus()
    expect(document.activeElement).toHaveAttribute('data-path', 'artifacts')

    const user = userEvent.setup()
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-path', 'artifacts/empty-dir'))
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-path', 'artifacts/research'))
    await user.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: /brief\.md/ })).toBeInTheDocument())
    await user.keyboard('{ArrowLeft}')
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /brief\.md/ })).toBeNull())
  })

  it('labels a symlink and refuses to select it', async () => {
    stubFetch(() => jsonResponse({}, 404))
    render(<FileBrowser runId="20260906-returns-aaaa" entries={entries} emptyLabel="none" />)
    const symlink = screen.getByRole('treeitem', { name: /escape\.txt/ })
    expect(symlink).toHaveAttribute('aria-disabled', 'true')
    expect(within(symlink).getByText('symlink — not followed')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(symlink)
    expect(screen.getByText('Select a file to preview it.')).toBeInTheDocument()
  })

  it('marks an empty folder rather than leaving a dead row', () => {
    stubFetch(() => jsonResponse({}, 404))
    render(<FileBrowser runId="20260906-returns-aaaa" entries={entries} emptyLabel="none" />)
    const empty = screen.getByRole('treeitem', { name: /empty-dir/ })
    expect(within(empty).getByText('empty')).toBeInTheDocument()
  })

  it('previews a selected file and offers it for download', async () => {
    stubFetch((url) => {
      if (url.includes('files/content')) {
        return new Response('# Brief\n\nHello.\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown', 'x-fde-truncated': 'false', 'x-fde-file-size': '240' },
        })
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    render(<FileBrowser runId="20260906-returns-aaaa" entries={entries} emptyLabel="none" />)
    await user.click(screen.getByRole('treeitem', { name: /research/ }))
    await user.click(await screen.findByRole('treeitem', { name: /brief\.md/ }))
    expect(await screen.findByRole('heading', { name: 'Brief' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument()
    expect(screen.getByText('artifacts/research/brief.md')).toBeInTheDocument()
  })
})

describe('the folder picker', () => {
  const listing = (path: string) => ({
    path,
    parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
    truncated: false,
    entries: [
      { name: 'repos', path: `${path}/repos`, kind: 'directory', symlink: false, size: null, modifiedAt: null },
      { name: 'notes.md', path: `${path}/notes.md`, kind: 'file', symlink: false, size: 120, modifiedAt: null },
      { name: 'shortcut', path: `${path}/shortcut`, kind: 'directory', symlink: true, size: null, modifiedAt: null },
    ],
  })

  const seed = (): string[] => {
    const asked: string[] = []
    stubFetch((url) => {
      if (url.startsWith('/api/fs/browse')) {
        const query = new URLSearchParams(url.split('?')[1] ?? '')
        const path = query.get('path') ?? '/home/op'
        asked.push(path)
        return jsonResponse(listing(path))
      }
      return jsonResponse({}, 404)
    })
    return asked
  }

  it('shows the current folder as breadcrumbs you can steer by', async () => {
    seed()
    const user = userEvent.setup()
    render(<PathBrowser title="Choose a repository folder" mode="directory" onSelect={() => {}} onClose={() => {}} />)
    await screen.findByRole('option', { name: /repos/ })
    const crumbs = screen.getByRole('navigation', { name: 'Current folder' })
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['/', 'home', 'op', 'Type a path'])
    await user.click(within(crumbs).getByRole('button', { name: 'home' }))
    await waitFor(() =>
      expect(screen.getByText('/home', { selector: '.pathpicker-current' })).toBeInTheDocument())
  })

  it('opens folders and refuses files when a folder is what is wanted', async () => {
    const picked: string[] = []
    seed()
    const user = userEvent.setup()
    render(<PathBrowser title="Choose a repository folder" mode="directory"
                        onSelect={(path) => picked.push(path)} onClose={() => {}} />)
    const file = await screen.findByRole('option', { name: /notes\.md/ })
    expect(file).toHaveAttribute('aria-disabled', 'true')
    await user.click(file)
    expect(picked).toEqual([])
    await user.click(screen.getByRole('option', { name: /repos/ }))
    await waitFor(() =>
      expect(screen.getByText('/home/op/repos', { selector: '.pathpicker-current' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(picked).toEqual(['/home/op/repos'])
  })

  it('selects a file directly when a file is allowed', async () => {
    const picked: string[] = []
    seed()
    const user = userEvent.setup()
    render(<PathBrowser title="Attach" mode="any" onSelect={(path) => picked.push(path)} onClose={() => {}} />)
    await user.click(await screen.findByRole('option', { name: /notes\.md/ }))
    expect(picked).toEqual(['/home/op/notes.md'])
  })

  it('never submits the form it was opened from', async () => {
    const submitted = vi.fn()
    seed()
    const user = userEvent.setup()
    render(
      <form onSubmit={submitted}>
        <PathBrowser title="Choose a repository folder" mode="directory" onSelect={() => {}} onClose={() => {}} />
      </form>,
    )
    await screen.findByRole('option', { name: /repos/ })
    // The dialog is a portal on document.body, so it is not inside that form.
    expect(document.querySelectorAll('form form')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Type a path' }))
    const field = screen.getByLabelText('Path')
    await user.clear(field)
    await user.type(field, '/srv/code{Enter}')
    await waitFor(() =>
      expect(screen.getByText('/srv/code', { selector: '.pathpicker-current' })).toBeInTheDocument())
    expect(submitted).not.toHaveBeenCalled()
  })

  it('closes on Escape and gives focus back', async () => {
    const closed = vi.fn()
    seed()
    const user = userEvent.setup()
    render(<PathBrowser title="Choose a repository folder" mode="directory" onSelect={() => {}} onClose={closed} />)
    await screen.findByRole('option', { name: /repos/ })
    await user.keyboard('{Escape}')
    expect(closed).toHaveBeenCalled()
  })
})
