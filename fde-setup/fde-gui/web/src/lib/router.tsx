import { useCallback, useEffect, useState, type ReactNode } from 'react'

export function useRoute(): { path: string; navigate: (to: string) => void } {
  const currentLocation = (): string => `${window.location.pathname || '/'}${window.location.search}`
  const [location, setLocation] = useState(currentLocation)

  useEffect(() => {
    const onPop = (): void => setLocation(currentLocation())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to: string) => {
    if (to === currentLocation()) return
    window.history.pushState(null, '', to)
    setLocation(to)
  }, [])

  return { path: location.split('?')[0] || '/', navigate }
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
