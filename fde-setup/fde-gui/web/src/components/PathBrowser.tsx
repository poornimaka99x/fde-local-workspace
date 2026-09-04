import { useEffect, useState } from 'react'
import { ApiError, apiGet } from '../lib/api'
import { formatBytes } from '../lib/format'
import type { FsBrowseResponse } from '../lib/types'
import { ErrorState, Loading } from './States'

/**
 * A "choose a folder" dialog for the local console. Browsers never hand a web
 * page the real absolute path of a file or folder picked through a native
 * file input or drag-and-drop — that restriction is universal, not specific
 * to this app — so this walks the machine through the server's own
 * filesystem access instead, the way a desktop app's Open dialog would.
 *
 * `mode: 'directory'` is for picking a folder to reference (a project's
 * repository): file rows are inert, and "Select this folder" is always the
 * way out. `mode: 'any'` is for picking a file or a folder (a chat
 * attachment): clicking a file row selects it directly.
 */
export function PathBrowser({
  title,
  mode,
  startPath,
  onSelect,
  onClose,
}: {
  title: string
  mode: 'directory' | 'any'
  startPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const [target, setTarget] = useState<string | undefined>(startPath)
  const [data, setData] = useState<FsBrowseResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [jump, setJump] = useState(startPath ?? '')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    const query = target ? `?path=${encodeURIComponent(target)}` : ''
    apiGet<FsBrowseResponse>(`/api/fs/browse${query}`)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setJump(result.path)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not read that folder.'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target])

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="stack" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="action" type="button" onClick={onClose}>Close</button>
        </div>
        <form
          className="stack"
          style={{ margin: '10px 0' }}
          onSubmit={(event) => {
            event.preventDefault()
            if (jump.trim() !== '') setTarget(jump.trim())
          }}
        >
          <input
            type="text"
            className="mono"
            style={{ flex: 1, minWidth: 260 }}
            value={jump}
            aria-label="Path"
            onChange={(event) => setJump(event.target.value)}
          />
          <button className="action" type="submit">Go</button>
          {data?.parent ? (
            <button className="action" type="button" onClick={() => setTarget(data.parent as string)}>Up</button>
          ) : null}
        </form>

        {error ? <ErrorState error={error} /> : null}
        {loading && data === null ? <Loading label="Reading…" /> : null}

        {data ? (
          <>
            <div className="filelist">
              {data.entries.length === 0 ? <p className="muted" style={{ padding: 10, margin: 0 }}>Empty folder.</p> : null}
              {data.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  disabled={entry.kind === 'other' || (mode === 'directory' && entry.kind === 'file')}
                  onClick={() => {
                    if (entry.kind === 'directory') setTarget(entry.path)
                    else onSelect(entry.path)
                  }}
                >
                  <span>
                    {entry.name}
                    {entry.kind === 'directory' ? <span className="muted"> /</span> : null}
                    {entry.symlink ? <span className="badge" style={{ marginLeft: 6 }}>symlink</span> : null}
                  </span>
                  <span className="meta">{entry.kind === 'file' && entry.size !== null ? formatBytes(entry.size) : ''}</span>
                </button>
              ))}
            </div>
            {data.truncated ? <p className="banner warn">Showing the first entries only; this folder has more.</p> : null}
            <div className="stack" style={{ marginTop: 10, justifyContent: 'space-between' }}>
              <p className="muted mono" style={{ margin: 0, wordBreak: 'break-all' }}>{data.path}</p>
              <button className="action" type="button" onClick={() => onSelect(data.path)}>Select this folder</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
