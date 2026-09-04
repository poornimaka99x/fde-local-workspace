import type { ReactNode } from 'react'
import type { ApiError } from '../lib/api'

export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="card muted" role="status" aria-live="polite">
      {label}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {children}
      </p>
    </div>
  )
}

/**
 * A controller refusal is evidence, not a bug: it is shown in the controller's
 * own words, and never turned into a way around the gate that produced it.
 */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }): JSX.Element {
  const refusal = error.status === 409
  return (
    <div className={`banner ${refusal ? 'warn' : 'danger'}`} role="alert">
      <strong>{refusal ? 'The controller refused this' : error.message}</strong>
      {refusal ? <div>{error.message}</div> : null}
      {error.detail ? <pre style={{ marginTop: 8, background: 'transparent' }}>{error.detail}</pre> : null}
      {onRetry ? (
        <p style={{ margin: '8px 0 0' }}>
          <button className="action" onClick={onRetry} type="button">
            Try again
          </button>
        </p>
      ) : null}
    </div>
  )
}

export function Warnings({ warnings }: { warnings: string[] }): JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <div className="banner warn" role="status">
      <strong>
        {warnings.length} thing{warnings.length === 1 ? '' : 's'} in this data could not be read cleanly
      </strong>
      <ul>
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  )
}
