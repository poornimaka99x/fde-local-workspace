import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, apiGet } from '../lib/api'
import { formatBytes } from '../lib/format'
import type { FsBrowseResponse, FsEntry } from '../lib/types'
import { Icon } from './Icon'
import { ErrorState, Loading } from './States'

/**
 * A "choose a folder" dialog for the local console. Browsers never hand a web
 * page the real absolute path of a file or folder picked through a native
 * file input or drag-and-drop — that restriction is universal, not specific
 * to this app — so this walks the machine through the server's own
 * filesystem access instead, the way a desktop app's Open dialog would.
 *
 * `mode: 'directory'` is for picking a folder to reference (a project's
 * repository): file rows are shown for orientation but are not selectable, and
 * "Use this folder" is always the way out. `mode: 'any'` is for picking a file
 * or a folder (a chat attachment): a file row selects it directly.
 *
 * The dialog owns the keyboard while it is open: focus starts inside it,
 * Escape closes it, and Tab cycles within it rather than wandering into the
 * page behind.
 *
 * It renders in a portal on `document.body`, and its path field is not a
 * `<form>`. Both matter because every caller mounts it from inside their own
 * form: a nested form is invalid HTML with undefined submit behaviour, and one
 * stray Enter in a folder picker must never submit the page behind it.
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
  const [typing, setTyping] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    const query = target === undefined ? '' : `?path=${encodeURIComponent(target)}`
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

  // The caller usually passes an inline arrow, so its identity changes on every
  // render. Keeping it in a ref lets the effect below run once: an effect that
  // re-ran per render would take focus back to the dialog after every
  // keystroke, and the path field could never be typed into.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  // Focus lands inside the dialog, Escape closes it, and Tab stays in it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || dialog.current === null) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])',
      )].filter((node) => node.offsetParent !== null)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
  }, [])

  // A path is easier to steer by its parts than by retyping the whole string.
  const crumbs = useMemo(() => {
    const path = data?.path ?? ''
    if (path === '') return []
    const parts = path.split('/').filter((part) => part !== '')
    let walked = ''
    return parts.map((part) => {
      walked = `${walked}/${part}`
      return { name: part, path: walked }
    })
  }, [data?.path])

  const rowIcon = (entry: FsEntry): 'folder' | 'link' | 'file' => {
    if (entry.symlink) return 'link'
    return entry.kind === 'directory' ? 'folder' : 'file'
  }

  const selectable = (entry: FsEntry): boolean => {
    if (entry.kind === 'other') return false
    return mode === 'any' || entry.kind === 'directory'
  }

  const go = (): void => {
    if (jump.trim() !== '') setTarget(jump.trim())
    setTyping(false)
  }

  const move = (delta: number): void => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]
    next?.focus()
  }

  return createPortal(
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal card pathpicker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialog}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pathpicker-head">
          <h2>{title}</h2>
          <button className="action" type="button" onClick={onClose}>Close</button>
        </header>

        <div className="pathpicker-bar">
          <button
            className="action"
            type="button"
            disabled={data?.parent == null}
            onClick={() => { if (data?.parent != null) setTarget(data.parent) }}
            aria-label="Go to the parent folder"
            title="Parent folder"
          >
            <Icon name="chevron" className="up" />
            Up
          </button>

          {typing ? (
            <div className="pathpicker-jump">
              <label className="visually-hidden" htmlFor="pathpicker-path">Path</label>
              <input
                id="pathpicker-path"
                type="text"
                className="mono"
                autoFocus
                value={jump}
                onChange={(event) => setJump(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  go()
                }}
              />
              <button className="action" type="button" onClick={go}>Go</button>
            </div>
          ) : (
            <nav className="crumbs" aria-label="Current folder">
              <button className="crumb" type="button" onClick={() => setTarget('/')}>/</button>
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="crumb-part">
                  <button
                    className="crumb"
                    type="button"
                    aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                    onClick={() => setTarget(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                  {index === crumbs.length - 1 ? null : <span aria-hidden="true">/</span>}
                </span>
              ))}
              <button
                className="action pathpicker-type"
                type="button"
                onClick={() => setTyping(true)}
              >
                Type a path
              </button>
            </nav>
          )}
        </div>

        {error ? <ErrorState error={error} /> : null}
        {loading && data === null ? <Loading label="Reading…" /> : null}

        {data ? (
          <>
            <div
              className="picker-list"
              ref={list}
              role="listbox"
              aria-label={`Contents of ${data.path}`}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
                if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
              }}
            >
              {data.entries.length === 0 ? (
                <p className="picker-empty">This folder is empty.</p>
              ) : null}
              {data.entries.map((entry) => {
                const canPick = selectable(entry)
                return (
                  <button
                    key={entry.path}
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-disabled={canPick ? undefined : true}
                    className={entry.kind === 'directory' ? 'is-folder' : undefined}
                    onClick={() => {
                      if (entry.kind === 'directory') { setTarget(entry.path); return }
                      if (canPick) onSelect(entry.path)
                    }}
                  >
                    <Icon name={rowIcon(entry)} className="rowicon" />
                    <span className="name">{entry.name}</span>
                    {entry.symlink ? <span className="badge">symlink</span> : null}
                    {entry.kind === 'file' && entry.size !== null ? (
                      <span className="size">{formatBytes(entry.size)}</span>
                    ) : null}
                    {entry.kind === 'directory' ? (
                      <Icon name="chevron" className="into" />
                    ) : null}
                  </button>
                )
              })}
            </div>

            {data.truncated ? (
              <p className="banner warn">Showing the first entries only; this folder has more.</p>
            ) : null}

            <footer className="pathpicker-foot">
              <div>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {mode === 'directory' ? 'Selecting' : 'Current folder'}
                </span>
                <div className="mono pathpicker-current">{data.path}</div>
              </div>
              <button className="action primary" type="button" onClick={() => onSelect(data.path)}>
                Use this folder
              </button>
            </footer>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
