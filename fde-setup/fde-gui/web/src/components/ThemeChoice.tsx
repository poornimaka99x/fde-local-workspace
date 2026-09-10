import { useEffect, useState } from 'react'

type Theme = 'system' | 'light' | 'dark'

const KEY = 'fde-gui-theme'

function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/** Follow the machine, or override it. The choice is per browser, not per run. */
export function ThemeChoice(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = window.localStorage.getItem(KEY)
      return stored === 'light' || stored === 'dark' ? stored : 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    apply(theme)
    try {
      if (theme === 'system') window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, theme)
    } catch {
      /* a browser with storage disabled still gets the theme, just not the memory */
    }
  }, [theme])

  return (
    <label>
      <span className="muted">Theme </span>
      <select
        value={theme}
        aria-label="Colour theme"
        onChange={(event) => setTheme(event.target.value as Theme)}
      >
        <option value="system">system</option>
        <option value="light">light</option>
        <option value="dark">dark</option>
      </select>
    </label>
  )
}
