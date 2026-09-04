import { useRef } from 'react'

export interface TabDefinition {
  id: string
  label: string
  badge?: string | number
}

/** Roving-focus tablist: arrow keys move, Home/End jump, Enter/Space selects. */
export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabDefinition[]
  active: string
  onSelect: (id: string) => void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  const move = (delta: number): void => {
    const index = tabs.findIndex((tab) => tab.id === active)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (next) {
      onSelect(next.id)
      const node = listRef.current?.querySelector<HTMLButtonElement>(`#tab-${next.id}`)
      node?.focus()
    }
  }

  return (
    <div className="tabs" role="tablist" ref={listRef} aria-label="Run detail sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
            if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
            if (event.key === 'Home') { event.preventDefault(); const first = tabs[0]; if (first) onSelect(first.id) }
            if (event.key === 'End') { event.preventDefault(); const last = tabs[tabs.length - 1]; if (last) onSelect(last.id) }
          }}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge !== '' ? <span className="badge" style={{ marginLeft: 6 }}>{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  )
}
