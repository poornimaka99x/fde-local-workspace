import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import { Link, useRoute } from '../lib/router'
import { captureToken } from '../lib/token'
import { useApi } from '../lib/useApi'
import type { HealthResponse } from '../lib/types'
import { startChangePolling } from '../lib/changes'
import { AppSidebar } from '../components/AppSidebar'
import { RunsView } from '../features/runs/RunsView'
import { NewRunForm } from '../features/runs/NewRunForm'
import { ProjectForm } from '../features/projects/ProjectForm'
import { RunDetail } from '../features/runs/RunDetail'
import { ProjectsView } from '../features/projects/ProjectsView'
import { ProjectDetail } from '../features/projects/ProjectDetail'
import { HealthView } from '../features/health/HealthView'
import { SessionsView } from '../features/sessions/SessionsView'
import {
  FdeConfigurationView,
  FdeRunDetail,
  FdeRunsView,
  FdeSystemView,
  NewFdeRunForm,
  SystemsView,
} from '../features/systems/FdeSystemViews'

const ChatsView = lazy(() => import('../features/chats/ChatsView').then((module) => ({ default: module.ChatsView })))
const DesignPanelForm = lazy(() =>
  import('../features/design/DesignPanelForm').then((module) => ({ default: module.DesignPanelForm })))
const DesignPanelView = lazy(() =>
  import('../features/design/DesignPanelView').then((module) => ({ default: module.DesignPanelView })))
const ConfigurationView = lazy(() =>
  import('../features/accounts/ConfigurationView').then((module) => ({ default: module.ConfigurationView })))
const NewChatForm = lazy(() => import('../features/chats/NewChatForm').then((module) => ({ default: module.NewChatForm })))
const ChatDetail = lazy(() => import('../features/chats/ChatDetail').then((module) => ({ default: module.ChatDetail })))

function NoToken(): JSX.Element {
  return (
    <main id="main">
      <h1>This tab has no session token</h1>
      <p className="lede">
        The console hands out a token once per launch, in the link printed by the server. Open that
        link again — it looks like <code>http://127.0.0.1:7317/#token=…</code>.
      </p>
      <p className="muted">
        The token lives in the URL fragment, which the browser never sends to a server, so it stays
        out of logs and history sync. It is valid for this launch only.
      </p>
    </main>
  )
}

export function App(): JSX.Element {
  const [token] = useState<string | null>(() => captureToken())
  const { path } = useRoute()
  const health = useApi<HealthResponse>(token === null ? null : '/api/health', 120000)

  useEffect(() => {
    document.title = 'FLOW'
  }, [])

  // One poller for the whole console: it watches the server's change counter
  // and tells every open view to reload when a terminal changes something.
  useEffect(() => {
    if (token === null) return
    return startChangePolling()
  }, [token])

  if (token === null) return <NoToken />

  const search = new URLSearchParams(window.location.search)
  const runMatch = /^\/runs\/([^/]+)$/.exec(path)
  const panelMatch = /^\/runs\/([^/]+)\/design-panel$/.exec(path)
  const projectMatch = /^\/projects\/([^/]+)$/.exec(path)
  const projectEditMatch = /^\/projects\/([^/]+)\/edit$/.exec(path)
  const chatMatch = /^\/chats\/([^/]+)$/.exec(path)
  const fdeConfigurationMatch = /^\/systems\/forward-deployed-engineer\/configurations\/([^/]+)$/.exec(path)
  const fdeRunMatch = /^\/systems\/forward-deployed-engineer\/runs\/([^/]+)$/.exec(path)
  const section = path.startsWith('/systems')
    ? 'systems'
    : path.startsWith('/projects')
    ? 'projects'
    : path.startsWith('/chats')
      ? 'chats'
    : path.startsWith('/sessions')
      ? 'sessions'
    : path.startsWith('/accounts') || path.startsWith('/configuration')
      ? 'configuration'
      : path.startsWith('/health')
        ? 'health'
        : 'runs'

  return (
    <div className="layout">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <AppSidebar path={path} />

      <div>
        <header className="topbar">
          <span className="root" title="The runs directory this console reads">
            {health.data ? health.data.roots.runs : 'connecting…'}
          </span>
          <form
            role="search"
            className="stack"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault()
              const value = new FormData(event.currentTarget).get('q')
              const term = typeof value === 'string' ? value.trim() : ''
              const to = term === '' ? '/runs' : `/runs?query=${encodeURIComponent(term)}`
              window.history.pushState(null, '', to)
              window.dispatchEvent(new PopStateEvent('popstate'))
            }}
          >
            <label>
              <span className="visually-hidden">Find a run</span>
              <input type="search" name="q" placeholder="Search runs…" />
            </label>
            <button className="action" type="submit">
              Search
            </button>
          </form>
          <span className="stack">
            {health.error ? (
              <span className="badge danger">server unreachable</span>
            ) : (
              <span className="badge ok">connected</span>
            )}
            {health.data ? <span className="badge">{health.data.mode}</span> : null}
          </span>
        </header>

        <main id="main" tabIndex={-1}>
          {health.data && !health.data.controller.ok ? (
            <div className="banner danger" role="alert">
              <strong>This console cannot talk to the installed controller.</strong>
              <p style={{ margin: '6px 0 0' }}>
                {health.data.controller.detail ??
                  'The controller did not answer the contract check.'}
              </p>
              <p style={{ margin: '6px 0 0' }}>
                Update it with <code>./install.sh</code> from your fde-setup checkout, then reload.
              </p>
            </div>
          ) : null}
          <Suspense fallback={<div className="card muted">Loading view…</div>}>
            {path === '/systems/forward-deployed-engineer/new' ? (
              <NewFdeRunForm initialConfigurationId={search.get('configurationId') ?? undefined} />
            ) : fdeConfigurationMatch?.[1] ? (
              <FdeConfigurationView configurationId={decodeURIComponent(fdeConfigurationMatch[1])} />
            ) : fdeRunMatch?.[1] ? (
              <FdeRunDetail runId={decodeURIComponent(fdeRunMatch[1])} />
            ) : path === '/systems/forward-deployed-engineer/runs' ? (
              <FdeRunsView />
            ) : path === '/systems/forward-deployed-engineer' ? (
              <FdeSystemView />
            ) : path === '/systems' ? (
              <SystemsView />
            ) : path === '/runs/new' ? (
              <NewRunForm projectId={search.get('projectId') ?? undefined} />
            ) : path === '/design-panel/new' ? (
              <DesignPanelForm projectId={search.get('projectId') ?? undefined} />
            ) : panelMatch?.[1] ? (
              <DesignPanelView runId={decodeURIComponent(panelMatch[1])} />
            ) : path === '/chats/new' ? (
              <NewChatForm />
            ) : path === '/projects/new' ? (
              <ProjectForm />
            ) : projectEditMatch?.[1] ? (
              <ProjectForm projectId={decodeURIComponent(projectEditMatch[1])} />
            ) : runMatch?.[1] && runMatch[1] !== 'new' ? (
              <RunDetail runId={decodeURIComponent(runMatch[1])} />
            ) : chatMatch?.[1] && chatMatch[1] !== 'new' ? (
              <ChatDetail chatId={decodeURIComponent(chatMatch[1])} />
            ) : projectMatch?.[1] ? (
              <ProjectDetail projectId={decodeURIComponent(projectMatch[1])} />
            ) : section === 'systems' ? (
              <SystemsView />
            ) : section === 'projects' ? (
              <ProjectsView />
            ) : section === 'chats' ? (
              <ChatsView />
            ) : section === 'sessions' ? (
              <SessionsView />
            ) : section === 'configuration' ? (
              <ConfigurationView />
            ) : section === 'health' ? (
              <HealthView />
            ) : (
              <RunsView
                key={window.location.search}
                projectId={search.get('projectId') ?? undefined}
                initialQuery={search.get('query') ?? undefined}
              />
            )}
          </Suspense>
        </main>
      </div>
    </div>
  )
}
