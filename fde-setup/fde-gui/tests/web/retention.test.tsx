// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetentionView } from '../../web/src/features/configuration/RetentionView'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

describe('retention settings', () => {
  beforeEach(() => {
    window.sessionStorage.setItem('fde-gui-token', 'test-token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  it('shows the five-day default and saves a user-selected period', async () => {
    const requests: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        requests.push(JSON.parse(String(init.body)))
        return response({
          settings: { schemaVersion: 1, enabled: true, completedRunDays: 14 },
          sweep: { deletedRunIds: [], skippedRunIds: [], failures: [] },
        })
      }
      return response({ settings: { schemaVersion: 1, enabled: true, completedRunDays: 5 } })
    }))

    render(<RetentionView />)
    const days = await screen.findByRole('spinbutton', { name: /Keep completed conversations for/ })
    expect(days).toHaveValue(5)
    fireEvent.change(days, { target: { value: '14' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save retention' }))
    await waitFor(() => expect(requests).toEqual([{ enabled: true, completedRunDays: 14 }]))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  })
})
