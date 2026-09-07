import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, apiGetBlobUrl, apiGetText, fileContentUrl } from '../lib/api'
import { formatBytes, formatTime } from '../lib/format'
import type { RunFileEntry } from '../lib/types'
import { Icon, type IconName } from './Icon'
import { Markdown } from './Markdown'
import { ErrorState } from './States'

/**
 * A run's files as a folder tree beside a preview.
 *
 * The tree is built from the paths the server returned; it invents no entries
 * and follows nothing. A symlink is shown, labelled, and cannot be selected —
 * the server would refuse it anyway, and saying so here is more honest than a
 * row that looks clickable.
 */

interface PreviewState {
  kind: 'text' | 'markdown' | 'json' | 'image' | 'pdf' | 'none'
  text?: string
  url?: string
  truncated?: boolean
  size?: number
}

interface TreeNode {
  name: string
  path: string
  entry: RunFileEntry | null
  children: TreeNode[]
}

const CODE_TYPES = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'py', 'sh', 'json', 'jsonl', 'yaml', 'yml', 'toml'])
const DOC_TYPES = new Set(['md', 'markdown', 'txt', 'log', 'pdf', 'csv', 'tsv'])

function iconFor(entry: RunFileEntry | null, expanded: boolean): IconName {
  if (entry === null) return expanded ? 'folderOpen' : 'folder'
  if (entry.kind === 'directory') return expanded ? 'folderOpen' : 'folder'
  if (entry.kind === 'symlink') return 'link'
  if (entry.preview === 'image') return 'image'
  const extension = entry.name.split('.').pop()?.toLowerCase() ?? ''
  if (CODE_TYPES.has(extension)) return 'code'
  if (DOC_TYPES.has(extension)) return 'doc'
  return 'file'
}

/** Paths in, one tree out. A directory with no entry of its own is still a folder. */
export function buildTree(entries: RunFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = []
  const byPath = new Map<string, TreeNode>()

  const ensure = (path: string, name: string, parent: TreeNode | null): TreeNode => {
    const existing = byPath.get(path)
    if (existing !== undefined) return existing
    const node: TreeNode = { name, path, entry: null, children: [] }
    byPath.set(path, node)
    if (parent === null) roots.push(node)
    else parent.children.push(node)
    return node
  }

  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = entry.path.split('/')
    let parent: TreeNode | null = null
    let walked = ''
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] ?? ''
      walked = walked === '' ? segment : `${walked}/${segment}`
      const node = ensure(walked, segment, parent)
      if (index === segments.length - 1) node.entry = entry
      parent = node
    }
  }

  const sort = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      const aDirectory = a.children.length > 0 || a.entry?.kind === 'directory'
      const bDirectory = b.children.length > 0 || b.entry?.kind === 'directory'
      if (aDirectory !== bDirectory) return aDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) sort(node.children)
  }
  sort(roots)
  return roots
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
  const tree = useMemo(() => buildTree(entries), [entries])
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.filter((node) => node.children.length > 0).map((node) => node.path)),
  )
  const [selected, setSelected] = useState<RunFileEntry | null>(null)
  const [focusPath, setFocusPath] = useState<string | null>(tree[0]?.path ?? null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const treeRef = useRef<HTMLUListElement>(null)

  // Every row the reader can currently see, in the order they see it. This is
  // what the arrow keys walk.
  const visible = useMemo(() => {
    const out: { node: TreeNode; level: number }[] = []
    const walk = (nodes: TreeNode[], level: number): void => {
      for (const node of nodes) {
        out.push({ node, level })
        if (node.children.length > 0 && expanded.has(node.path)) walk(node.children, level + 1)
      }
    }
    walk(tree, 1)
    return out
  }, [tree, expanded])

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

  const focusRow = (path: string): void => {
    setFocusPath(path)
    window.requestAnimationFrame(() => {
      treeRef.current?.querySelector<HTMLButtonElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
    })
  }

  const toggle = (node: TreeNode, open?: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current)
      const shouldOpen = open ?? !next.has(node.path)
      if (shouldOpen) next.add(node.path)
      else next.delete(node.path)
      return next
    })
  }

  const onKeyDown = (event: React.KeyboardEvent, node: TreeNode, level: number): void => {
    const index = visible.findIndex((row) => row.node.path === node.path)
    const isFolder = node.children.length > 0
    const move = (to: number): void => {
      const target = visible[Math.max(0, Math.min(visible.length - 1, to))]
      if (target !== undefined) focusRow(target.node.path)
    }
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(index + 1); break
      case 'ArrowUp': event.preventDefault(); move(index - 1); break
      case 'Home': event.preventDefault(); move(0); break
      case 'End': event.preventDefault(); move(visible.length - 1); break
      case 'ArrowRight':
        event.preventDefault()
        if (isFolder && !expanded.has(node.path)) toggle(node, true)
        else if (isFolder) move(index + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (isFolder && expanded.has(node.path)) { toggle(node, false); break }
        for (let back = index - 1; back >= 0; back -= 1) {
          const candidate = visible[back]
          if (candidate !== undefined && candidate.level < level) { focusRow(candidate.node.path); break }
        }
        break
      default: break
    }
  }

  const rows = (nodes: TreeNode[], level: number): JSX.Element => (
    <ul role={level === 1 ? 'tree' : 'group'} ref={level === 1 ? treeRef : undefined}
        aria-label={level === 1 ? 'Run files' : undefined}>
      {nodes.map((node) => {
        const isFolder = node.children.length > 0
        const open = expanded.has(node.path)
        const entry = node.entry
        const selectable = entry !== null && entry.kind === 'file'
        const isSelected = selected?.path === node.path
        const tabIndex = (focusPath ?? visible[0]?.node.path) === node.path ? 0 : -1
        return (
          <li key={node.path} role="none">
            <button
              type="button"
              role="treeitem"
              data-path={node.path}
              aria-level={level}
              aria-expanded={isFolder ? open : undefined}
              aria-selected={selectable ? isSelected : undefined}
              // An empty folder and a refused symlink are both real things to
              // see. They are marked unselectable rather than `disabled`, so
              // the arrow keys still walk over them and a reader is told why
              // nothing opens rather than meeting a dead control.
              aria-disabled={!selectable && !isFolder ? true : undefined}
              tabIndex={tabIndex}
              onFocus={() => setFocusPath(node.path)}
              onKeyDown={(event) => onKeyDown(event, node, level)}
              onClick={() => {
                if (isFolder) toggle(node)
                if (selectable) setSelected(entry)
              }}
            >
              {isFolder
                ? <Icon name="chevron" size={13} className="twisty" />
                : <span className="twisty" style={{ width: 13 }} />}
              <Icon name={iconFor(entry, open)} className="fileicon" />
              <span className="name">{node.name}</span>
              {entry?.kind === 'symlink' ? (
                <span className="badge warn">symlink — not followed</span>
              ) : null}
              {entry?.kind === 'file' ? (
                <span className="size">{formatBytes(entry.size)}</span>
              ) : null}
              {entry?.kind === 'directory' && !isFolder ? (
                <span className="size">empty</span>
              ) : null}
            </button>
            {isFolder && open ? rows(node.children, level + 1) : null}
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="split">
      <div className="filetree">{rows(tree, 1)}</div>

      <div>
        {selected === null ? (
          <div className="card muted">Select a file to preview it.</div>
        ) : (
          <div className="card">
            <div className="preview-head">
              <div>
                <strong className="mono">{selected.path}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {selected.mediaType} · {formatBytes(selected.size)} · modified{' '}
                  {formatTime(selected.modifiedAt)}
                </div>
              </div>
              {selected.downloadable ? (
                <button className="action" type="button" onClick={() => void download(runId, selected.path)}>
                  <Icon name="download" />
                  Download
                </button>
              ) : null}
            </div>

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
              <iframe title={`Preview of ${selected.name}`} src={preview.url}
                      style={{ width: '100%', height: '60vh', border: '1px solid var(--border)' }} />
            ) : null}
            {preview?.kind === 'none' ? (
              <p className="muted">
                This file type is not previewed in the console. Download it to open it in the right
                application.
              </p>
            ) : null}
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
