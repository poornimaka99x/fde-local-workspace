import { useEffect, useState } from 'react'
import { ApiError, apiGetBlobUrl, apiGetText, fileContentUrl } from '../lib/api'
import { formatBytes, formatTime } from '../lib/format'
import type { RunFileEntry } from '../lib/types'
import { Markdown } from './Markdown'
import { ErrorState } from './States'

interface PreviewState {
  kind: 'text' | 'markdown' | 'json' | 'image' | 'pdf' | 'none'
  text?: string
  url?: string
  truncated?: boolean
  size?: number
}

async function download(runId: string, filePath: string): Promise<void> {
  const url = await apiGetBlobUrl(fileContentUrl(runId, filePath, 'attachment'))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filePath.split('/').pop() ?? 'download'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function FileBrowser({
  runId,
  entries,
  emptyLabel,
}: {
  runId: string
  entries: RunFileEntry[]
  emptyLabel: string
}): JSX.Element {
  const [selected, setSelected] = useState<RunFileEntry | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null
    setError(null)
    setPreview(null)
    if (selected === null || selected.kind !== 'file') return

    const load = async (): Promise<void> => {
      setBusy(true)
      try {
        if (selected.preview === 'image' || selected.preview === 'pdf') {
          const url = await apiGetBlobUrl(fileContentUrl(runId, selected.path, 'inline'))
          createdUrl = url
          if (!cancelled) setPreview({ kind: selected.preview, url })
          return
        }
        if (selected.preview === 'none') {
          if (!cancelled) setPreview({ kind: 'none' })
          return
        }
        const result = await apiGetText(fileContentUrl(runId, selected.path, 'inline'))
        if (!cancelled) {
          setPreview({
            kind: selected.preview,
            text: result.text,
            truncated: result.truncated,
            size: result.size,
          })
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause : new ApiError(0, 'network', 'Could not read that file.'))
        }
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl)
    }
  }, [runId, selected])

  if (entries.length === 0) {
    return <p className="muted">{emptyLabel}</p>
  }

  return (
    <div className="split">
      <div className="filelist">
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            aria-pressed={selected?.path === entry.path}
            disabled={entry.kind !== 'file'}
            onClick={() => setSelected(entry)}
          >
            <span>
              {entry.path}
              {entry.kind === 'symlink' ? <span className="badge warn" style={{ marginLeft: 6 }}>symlink — not followed</span> : null}
              {entry.kind === 'directory' ? <span className="muted"> /</span> : null}
            </span>
            <span className="meta">{entry.kind === 'file' ? formatBytes(entry.size) : ''}</span>
          </button>
        ))}
      </div>

      <div>
        {selected === null ? (
          <p className="muted">Select a file to preview it.</p>
        ) : (
          <div className="card">
            <div className="stack" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong className="mono">{selected.path}</strong>
                <div className="muted">
                  {selected.mediaType} · {formatBytes(selected.size)} · modified {formatTime(selected.modifiedAt)}
                </div>
              </div>
              {selected.downloadable ? (
                <button className="action" type="button" onClick={() => void download(runId, selected.path)}>
                  Download
                </button>
              ) : null}
            </div>

            <div style={{ marginTop: 12 }}>
              {busy ? <p className="muted">Reading…</p> : null}
              {error ? <ErrorState error={error} /> : null}
              {preview?.truncated ? (
                <p className="banner warn">
                  Showing the first 1 MiB of {formatBytes(preview.size)}. Download the file for the rest.
                </p>
              ) : null}
              {preview?.kind === 'markdown' && preview.text !== undefined ? <Markdown source={preview.text} /> : null}
              {preview?.kind === 'text' && preview.text !== undefined ? <pre>{preview.text}</pre> : null}
              {preview?.kind === 'json' && preview.text !== undefined ? <JsonPreview raw={preview.text} /> : null}
              {preview?.kind === 'image' && preview.url !== undefined ? (
                <img src={preview.url} alt={`Preview of ${selected.name}`} style={{ maxWidth: '100%' }} />
              ) : null}
              {preview?.kind === 'pdf' && preview.url !== undefined ? (
                <iframe title={`Preview of ${selected.name}`} src={preview.url} style={{ width: '100%', height: '60vh', border: '1px solid var(--border)' }} />
              ) : null}
              {preview?.kind === 'none' ? (
                <p className="muted">
                  This file type is not previewed in the console. Download it to open it in the right
                  application.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function JsonPreview({ raw }: { raw: string }): JSX.Element {
  try {
    return <pre>{JSON.stringify(JSON.parse(raw), null, 2)}</pre>
  } catch {
    return (
      <>
        <p className="banner warn">This file is not valid JSON. Showing it as text.</p>
        <pre>{raw}</pre>
      </>
    )
  }
}
