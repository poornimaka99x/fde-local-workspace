/**
 * A small, inline icon set.
 *
 * Icons are drawn with `currentColor` and are always decorative: every control
 * that carries one also carries its own text or an accessible name, so nothing
 * here is the only way to know what something is.
 */
export type IconName =
  | 'spark' | 'plus' | 'run' | 'chat' | 'project' | 'panel' | 'terminal'
  | 'health' | 'chevron' | 'folder' | 'folderOpen' | 'file' | 'doc'
  | 'image' | 'code' | 'link' | 'download' | 'key'

const PATHS: Record<IconName, string> = {
  spark: 'M8 1.6 9.5 6l4.4 1.5L9.5 9 8 13.4 6.5 9 2.1 7.5 6.5 6 8 1.6Z',
  plus: 'M8 3.2v9.6M3.2 8h9.6',
  run: 'M2.8 4.4h10.4M2.8 8h10.4M2.8 11.6h6.4',
  chat: 'M13.4 9.2a1.8 1.8 0 0 1-1.8 1.8H5.2L2.6 13.4V4.2a1.8 1.8 0 0 1 1.8-1.8h7.2a1.8 1.8 0 0 1 1.8 1.8v5Z',
  project: 'M2.6 5.1a1.4 1.4 0 0 1 1.4-1.4h2.3l1.3 1.6h4.4a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4V5.1Z',
  panel: 'M2.6 3.4h10.8v9.2H2.6zM6.2 3.4v9.2M9.8 3.4v9.2',
  terminal: 'M3.4 4.6 6.6 8l-3.2 3.4M8.4 11.6h4.2',
  health: 'M2.4 8h2.8l1.4-3.4 2.4 6.8 1.4-3.4h3.2',
  chevron: 'm6.2 3.8 4.2 4.2-4.2 4.2',
  folder: 'M2.6 5.1a1.4 1.4 0 0 1 1.4-1.4h2.3l1.3 1.6h4.4a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4V5.1Z',
  folderOpen: 'M2.6 11.9V5.1a1.4 1.4 0 0 1 1.4-1.4h2.3l1.3 1.6h4.4a1.4 1.4 0 0 1 1.4 1.4v.6M2.6 11.9l1.7-4.4h10L12.6 12a1.4 1.4 0 0 1-1.3.9H4a1.4 1.4 0 0 1-1.4-1Z',
  file: 'M9 2.2H5.2a1.4 1.4 0 0 0-1.4 1.4v8.8a1.4 1.4 0 0 0 1.4 1.4h5.6a1.4 1.4 0 0 0 1.4-1.4V5.4L9 2.2ZM9 2.2v3.2h3.2',
  doc: 'M9 2.2H5.2a1.4 1.4 0 0 0-1.4 1.4v8.8a1.4 1.4 0 0 0 1.4 1.4h5.6a1.4 1.4 0 0 0 1.4-1.4V5.4L9 2.2ZM5.9 8.4h4.2M5.9 10.7h4.2',
  image: 'M3 3.6h10v8.8H3zM3 10.2l2.8-2.6 2.4 2.2 2-1.8L13 10.4M6 6.4a.8.8 0 1 1-1.6 0 .8.8 0 0 1 1.6 0Z',
  code: 'M5.8 5.4 3.2 8l2.6 2.6M10.2 5.4 12.8 8l-2.6 2.6M8.9 3.6 7.1 12.4',
  link: 'M6.6 8.9a2.6 2.6 0 0 0 3.9.3l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.4 7.1a2.6 2.6 0 0 0-3.9-.3L3.9 8.4a2.6 2.6 0 0 0 3.7 3.7l.9-.9',
  download: 'M8 2.8v7.4M5.2 7.4 8 10.2l2.8-2.8M3.2 12.4h9.6',
  key: 'M9.6 3a3.4 3.4 0 1 1-2.5 5.7L6 9.8H4.4v1.6H2.8v1.8h2.6l4-4a3.4 3.4 0 0 1 .2-6.2Z',
}

const FILLED = new Set<IconName>(['spark'])

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  const filled = FILLED.has(name)
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
