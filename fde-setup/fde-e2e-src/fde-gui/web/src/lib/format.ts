export function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—'
  if (size < 1024) return `${size} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function shortHash(value: string | null | undefined, length = 12): string {
  if (!value) return '—'
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

export function stateTone(state: string | null | undefined): 'ok' | 'warn' | 'danger' | '' {
  if (!state) return ''
  if (state === 'complete') return 'ok'
  if (state === 'blocked') return 'danger'
  if (state.startsWith('awaiting_')) return 'warn'
  return ''
}
