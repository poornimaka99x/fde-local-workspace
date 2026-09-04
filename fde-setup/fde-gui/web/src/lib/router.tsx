import { useCallback, useEffect, useState, type ReactNode } from 'react'

export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => window.location.pathname || '/')

  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname || '/')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return
    window.history.pushState(null, '', to)
    setPath(to)
  }, [])

  return { path, navigate }
}

export function Link({
  to,
  children,
  className,
  current,
}: {
  to: string
  children: ReactNode
  className?: string
  current?: boolean
}): JSX.Element {
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        window.history.pushState(null, '', to)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    >
      {children}
    </a>
  )
}
