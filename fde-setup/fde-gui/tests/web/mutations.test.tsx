// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectForm } from '../../web/src/features/projects/ProjectForm'
import { NewRunForm } from '../../web/src/features/runs/NewRunForm'
import { AttachmentUpload } from '../../web/src/components/AttachmentUpload'

interface Sent {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  })
}

describe('creating and editing through the controller', () => {
  const sent: Sent[] = []

  beforeEach(() => {
    sent.length = 0
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
    window.history.pushState(null, '', '/projects/new')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  const stubFetch = (handler: (url: string, init?: RequestInit) => Response): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method !== undefined && init.method !== 'GET') {
          sent.push({
            url,
            method: init.method,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
          })
        }
        return handler(url, init)
      }),
    )
  }

  it('creates a project with a trimmed name and one repository per line', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ schemaVersion: 1, project: { projectId: 'returns-a1b2' } }, 201)
      }
      return jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    })
    const user = userEvent.setup()
    render(<ProjectForm />)

    await user.type(screen.getByLabelText(/Name/), '  Returns modernisation  ')
    await user.type(screen.getByLabelText(/Repositories/), '/tmp/one\n\n/tmp/two')
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({
      url: '/api/projects',
      method: 'POST',
      body: { name: 'Returns modernisation', repoPaths: ['/tmp/one', '/tmp/two'] },
    })
    await waitFor(() => expect(window.location.pathname).toBe('/projects/returns-a1b2'))
  })

  it('shows a controller refusal and stays on the form', async () => {
    stubFetch((_url, init) =>
      init?.method === 'POST'
        ? jsonResponse(
            {
              type: 'about:fde/controller-rejected-input',
              title: 'The controller refused this request.',
              detail: 'fde: repository path does not exist: /nope',
              status: 400,
            },
            400,
          )
        : jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] }),
    )
    const user = userEvent.setup()
    render(<ProjectForm />)
    await user.type(screen.getByLabelText(/Name/), 'Returns')
    await user.type(screen.getByLabelText(/Repositories/), '/nope')
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('repository path does not exist')
    expect(window.location.pathname).toBe('/projects/new')
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled()
  })

  const accountsResponse = {
    accounts: [{
      id: 'work', label: 'Claude: work', profile: 'work', provider: 'anthropic',
      profilePresent: true, authState: 'authenticated', authMethod: 'subscription',
      models: [
        { id: 'default', label: 'Account default', efforts: ['auto', 'low', 'medium', 'high'] },
        { id: 'sonnet', label: 'Claude Sonnet', efforts: ['auto', 'low', 'medium', 'high', 'max'] },
      ],
    }],
  }

  it('falls back to manual selection when automatic routing is unavailable', async () => {
    stubFetch((url, init) =>
      url === '/api/claude/accounts'
        ? jsonResponse(accountsResponse)
        : init?.method === 'POST'
        ? jsonResponse({ schemaVersion: 1, run: { runId: '20260903-max-1-aaaa' } }, 201)
        : jsonResponse({
            schemaVersion: 1,
            projects: [{ projectId: 'returns-a1b2', name: 'Returns', description: '', repoPaths: [] }],
            unassignedRunCount: 0,
            warnings: [],
          }),
    )
    const user = userEvent.setup()
    render(<NewRunForm />)

    await waitFor(() => expect(screen.getByLabelText(/Project/)).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText(/Project/), 'returns-a1b2')
    await user.type(screen.getByLabelText(/What do you want done/), 'MAX-1 returns research')
    await user.selectOptions(screen.getByLabelText(/Orchestrator/), 'work')
    await user.selectOptions(screen.getByLabelText(/Model/), 'sonnet')
    await user.selectOptions(screen.getByLabelText(/Effort/), 'high')
    await user.type(screen.getByLabelText(/Named shape/), 'research')
    await user.click(screen.getByRole('button', { name: 'Create run' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    // The routing policy endpoint answers nothing here, so the form offers
    // manual selection and says so rather than promising a route it cannot get.
    expect(sent[0]?.body).toEqual({
      orchestrator: 'work',
      model: 'sonnet',
      effort: 'high',
      routing: 'manual',
      projectId: 'returns-a1b2',
      requirement: 'MAX-1 returns research',
      shape: 'research',
    })
    expect(JSON.stringify(sent[0]?.body)).not.toContain('role')
    expect(JSON.stringify(sent[0]?.body)).not.toContain('approve')
    await waitFor(() => expect(window.location.pathname).toBe('/runs/20260903-max-1-aaaa'))
    expect(window.location.search).toBe('?startSession=1')
  })

  it('is honest that a Codex-led run cannot be driven from here', async () => {
    stubFetch((url) => url === '/api/claude/accounts'
      ? jsonResponse(accountsResponse)
      : jsonResponse({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] }))
    const user = userEvent.setup()
    render(<NewRunForm />)
    await user.selectOptions(screen.getByLabelText(/Orchestrator/), 'codex')
    expect(screen.getByText(/driven from its own Codex task/)).toBeInTheDocument()
  })
})

// A minimal XMLHttpRequest, so upload progress and failure can be exercised.
class FakeUpload {
  onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null = null
}

class FakeXHR {
  static last: FakeXHR | null = null
  upload = new FakeUpload()
  status = 0
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null

  open(_method: string, url: string): void {
    this.url = url
  }
  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value
  }
  send(body: unknown): void {
    this.body = body
    FakeXHR.last = this
  }
  respond(status: number, text: string): void {
    this.status = status
    this.responseText = text
    this.onload?.()
  }
}

describe('attaching a file', () => {
  beforeEach(() => {
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
    FakeXHR.last = null
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  const pickFile = async (): Promise<void> => {
    const user = userEvent.setup()
    const file = new File(['a requirement document'], 'requirements.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByLabelText('File to attach'), file)
    await user.click(screen.getByRole('button', { name: 'Attach' }))
  }

  it('reports progress and then the stored digest', async () => {
    const onUploaded = vi.fn()
    render(<AttachmentUpload runId="20260903-max-1-aaaa" onUploaded={onUploaded} />)
    await pickFile()

    const request = FakeXHR.last
    expect(request?.url).toBe(
      '/api/runs/20260903-max-1-aaaa/attachments?name=requirements.pdf',
    )
    expect(request?.headers.authorization).toBe('Bearer test-token')
    expect(request?.headers['content-type']).toBe('application/octet-stream')

    act(() => request?.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }))
    expect(await screen.findByText('50%')).toBeInTheDocument()

    act(() =>
      request?.respond(
        201,
        JSON.stringify({
          schemaVersion: 1,
          attachment: { originalName: 'requirements.pdf', sha256: 'abcdef0123456789' },
        }),
      ),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('requirements.pdf')
    expect(onUploaded).toHaveBeenCalledOnce()
  })

  it('shows why an upload was refused and does not claim success', async () => {
    const onUploaded = vi.fn()
    render(<AttachmentUpload runId="20260903-max-1-aaaa" onUploaded={onUploaded} />)
    await pickFile()

    act(() =>
      FakeXHR.last?.respond(
        413,
        JSON.stringify({
          type: 'about:fde/attachment-too-large',
          title: 'That upload is larger than this console accepts.',
          status: 413,
        }),
      ),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('larger than this console accepts')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(onUploaded).not.toHaveBeenCalled()
  })
})
