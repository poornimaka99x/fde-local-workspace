// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatsView } from '../../web/src/features/chats/ChatsView'
import { ProjectsView } from '../../web/src/features/projects/ProjectsView'
import { SessionsView } from '../../web/src/features/sessions/SessionsView'
import { RunsView } from '../../web/src/features/runs/RunsView'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  })
}

describe('deleting old records', () => {
  beforeEach(() => {
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  it('confirms and deletes a finished chat, then refreshes the list', async () => {
    let deleted = false
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true
        return response({ deleted: { kind: 'chat', chatId: 'chat-20260907-abcdef12', recoverable: true } })
      }
      return response({ chats: deleted ? [] : [{
        schemaVersion: 1, chatId: 'chat-20260907-abcdef12', title: 'Old chat', accountId: 'work',
        profile: 'work', provider: 'anthropic', model: 'sonnet', effort: 'high', projectId: null,
        cwd: '/tmp', claudeSessionId: 'session-id', createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z', status: 'idle', lastError: null,
        attachments: [], messageCount: 2, lastMessage: 'Done',
      }] })
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<ChatsView />)
    await user.click(await screen.findByRole('button', { name: 'Delete chat' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('recoverable trash'))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/chats/chat-20260907-abcdef12',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    expect(await screen.findByText('No chats yet')).toBeInTheDocument()
  })

  it('deletes only finished session history and labels running sessions as protected', async () => {
    let deleted = false
    const sessions = [
      {
        runId: '20260901-old-aaaa', status: 'exited', pid: 10,
        startedAt: '2026-09-01T00:00:00Z', exitedAt: '2026-09-01T00:01:00Z', exitCode: 0,
        cwd: '/tmp', command: [], envKeys: [], stopRequestedAt: null, attachedClients: 0,
      },
      {
        runId: '20260907-live-bbbb', status: 'running', pid: 11,
        startedAt: '2026-09-07T00:00:00Z', exitedAt: null, exitCode: null,
        cwd: '/tmp', command: [], envKeys: [], stopRequestedAt: null, attachedClients: 0,
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true
        return response({ deleted: { kind: 'session-history', runId: '20260901-old-aaaa' } })
      }
      return response({ available: true, sessions: deleted ? [sessions[1]] : sessions })
    }))
    const user = userEvent.setup()
    render(<SessionsView />)
    expect(await screen.findByRole('button', { name: 'Stop to delete' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Delete history' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('FDE run and its files will remain unchanged'))
    await waitFor(() => expect(screen.queryByText('20260901-old-aaaa')).not.toBeInTheDocument())
  })

  it('confirms project metadata deletion and explains the non-cascading guard', async () => {
    let deleted = false
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true
        return response({
          schemaVersion: 1,
          deletedProject: {
            projectId: 'old-project-a1b2', deletedAt: '2026-09-07T00:00:00Z',
            recoverable: true, runCount: 0, chatCount: 0,
          },
        })
      }
      return response({
        schemaVersion: 1,
        projects: deleted ? [] : [{
          projectId: 'old-project-a1b2', name: 'Old project', description: '', repoPaths: [], runCount: 0,
          lastActivityAt: '2026-09-01T00:00:00Z',
        }],
        unassignedRunCount: 0,
        warnings: [],
      })
    }))
    const user = userEvent.setup()
    render(<ProjectsView />)
    await user.click(await screen.findByRole('button', { name: 'Delete project' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Repositories are never deleted.*runs or chats will be refused/))
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
  })

  it('confirms complete run deletion and refreshes the run list', async () => {
    let deleted = false
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted = true
        return response({
          schemaVersion: 1,
          deletedRun: {
            runId: '20260901-old-aaaa', projectId: null, state: 'complete',
            deletedAt: '2026-09-07T00:00:00Z', recoverable: true,
          },
        })
      }
      if (url.startsWith('/api/runs')) {
        return response({
          schemaVersion: 1,
          runs: deleted ? [] : [{
            runId: '20260901-old-aaaa', state: 'complete', projectId: null,
            requirement: 'Old work', updatedAt: '2026-09-01T00:00:00Z', orchestrator: null,
            session: { provider: null, profile: null, sessionId: null, resumable: false, resumeReason: null },
          }],
          total: deleted ? 0 : 1,
          returned: deleted ? 0 : 1,
          warnings: [],
        })
      }
      return response({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<RunsView />)
    await user.click(await screen.findByRole('button', { name: 'Delete run' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/attachments, and artifacts.*recoverable trash/))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/runs/20260901-old-aaaa',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    expect(await screen.findByText(/No runs exist yet/)).toBeInTheDocument()
  })
})
