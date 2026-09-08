// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewChatForm } from '../../web/src/features/chats/NewChatForm'
import { ChatDetail } from '../../web/src/features/chats/ChatDetail'
import type { ChatRecord } from '../../web/src/lib/types'

const accounts = {
  accounts: [
    {
      id: 'work', label: 'Claude: work', profile: 'work', provider: 'anthropic',
      profilePresent: true, authState: 'authenticated', authMethod: 'subscription',
      models: [
        { id: 'default', label: 'Account default', efforts: ['auto', 'low', 'medium', 'high'] },
        { id: 'opus', label: 'Claude Opus', efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
      ],
    },
    {
      id: 'codex', label: 'ChatGPT / Codex', profile: 'codex', provider: 'codex',
      profilePresent: true, authState: 'authenticated', authMethod: 'ChatGPT',
      models: [
        { id: 'default', label: 'Account default', efforts: ['auto', 'low', 'medium', 'high'] },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      ],
    },
    {
      id: 'gemini', label: 'Gemini', profile: 'gemini', provider: 'gemini',
      profilePresent: true, authState: 'authenticated', authMethod: 'Antigravity',
      capabilities: ['research'], designPanelEligible: false, identityId: 'gemini',
      models: [{ id: 'default', label: 'Antigravity default', efforts: ['auto', 'low', 'medium', 'high'] }],
    },
  ],
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('general chat UI', () => {
  beforeEach(() => {
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  it('creates a chat with account, model, effort and optional project context', async () => {
    const sent: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/claude/accounts') return response(accounts)
      if (url === '/api/projects') return response({
        schemaVersion: 1, projects: [{ projectId: 'returns-a1b2', name: 'Returns', repoPaths: [] }],
        unassignedRunCount: 0, warnings: [],
      })
      if (url === '/api/chats' && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)))
        return response({ chat: { chatId: 'chat-20260904-abcdef12' } }, 201)
      }
      return response({})
    }))
    const user = userEvent.setup()
    render(<NewChatForm />)
    await waitFor(() => expect(screen.getByLabelText(/Chat account/)).toBeInTheDocument())
    await user.type(screen.getByLabelText(/Title/), 'Architecture question')
    await user.selectOptions(screen.getByLabelText(/Project context/), 'returns-a1b2')
    await user.selectOptions(screen.getByLabelText(/Model/), 'opus')
    await user.selectOptions(screen.getByLabelText(/Effort/), 'xhigh')
    await user.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(sent).toEqual([{
      title: 'Architecture question', projectId: 'returns-a1b2', accountId: 'work', model: 'opus', effort: 'xhigh',
    }]))
    expect(window.location.pathname).toBe('/chats/chat-20260904-abcdef12')
  })

  it('offers the signed-in ChatGPT account with its Codex model and effort choices', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/claude/accounts') return response(accounts)
      return response({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    }))
    const user = userEvent.setup()
    render(<NewChatForm />)
    const account = await screen.findByLabelText('Chat account')
    await user.selectOptions(account, 'codex')
    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5.6-sol')
    expect(screen.getByRole('option', { name: 'ultra' })).toBeInTheDocument()
    expect(screen.getByText('ChatGPT')).toBeInTheDocument()
  })

  it('offers the connected Gemini Antigravity account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/claude/accounts') return response(accounts)
      return response({ schemaVersion: 1, projects: [], unassignedRunCount: 0, warnings: [] })
    }))
    const user = userEvent.setup()
    render(<NewChatForm />)
    const account = await screen.findByLabelText('Chat account')
    await user.selectOptions(account, 'gemini')
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'medium' })).toBeInTheDocument()
  })

  it('renders the transcript and sends the next message', async () => {
    let chat: ChatRecord = {
      schemaVersion: 1 as const,
      chatId: 'chat-20260904-abcdef12', title: 'Architecture', accountId: 'work', profile: 'work',
      provider: 'codex' as const, model: 'gpt-5.6-sol', effort: 'high' as const, projectId: null,
      cwd: '/tmp', claudeSessionId: '11111111-1111-1111-1111-111111111111',
      createdAt: '2026-09-04T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z',
      status: 'idle' as const, lastError: null,
      messages: [{ id: 'one', role: 'assistant' as const, content: '**Ready.**', createdAt: '2026-09-04T00:00:00Z' }],
      attachments: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const prompt = (JSON.parse(String(init.body)) as { message: string }).message
        chat = {
          ...chat,
          messages: [...chat.messages, { id: 'two', role: 'user' as const, content: prompt, createdAt: '2026-09-04T00:01:00Z' }],
        }
      }
      return response({ chat })
    }))
    const user = userEvent.setup()
    render(<ChatDetail chatId={chat.chatId} />)
    expect(await screen.findByText('Ready.')).toBeInTheDocument()
    expect(screen.getByText('ChatGPT / Codex')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Message'), 'What changed?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText('What changed?')).toBeInTheDocument())
  })

  it('keeps a failed message ready to retry and shows the real safe error', async () => {
    const chat: ChatRecord = {
      schemaVersion: 1, chatId: 'chat-20260904-abcdef12', title: 'Architecture',
      accountId: 'work', profile: 'work', provider: 'anthropic', model: 'default', effort: 'auto',
      projectId: null, cwd: '/tmp', claudeSessionId: '11111111-1111-1111-1111-111111111111',
      createdAt: '2026-09-04T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z',
      status: 'idle', lastError: null, messages: [], attachments: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ chat: {
        ...chat,
        status: 'failed',
        lastError: 'This Claude account is not logged in. Use Login for the selected account, then try again.',
      } })
      return response({ chat })
    }))
    const user = userEvent.setup()
    render(<ChatDetail chatId={chat.chatId} />)
    await user.type(await screen.findByLabelText('Message'), 'Please retry me')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not logged in')
    expect(screen.getByLabelText('Message')).toHaveValue('Please retry me')
  })
})
