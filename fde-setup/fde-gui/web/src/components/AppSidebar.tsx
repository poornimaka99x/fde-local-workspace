import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '../lib/router'
import { formatSince } from '../lib/format'
import { useApi } from '../lib/useApi'
import { Icon, type IconName } from './Icon'
import type {
  ChatSummary,
  ProjectListResponse,
  RunListResponse,
  RunSummary,
  SessionListResponse,
} from '../lib/types'

/**
 * The navigation rail.
 *
 * It answers the two questions an operator actually arrives with — "where was
 * I?" and "what am I working on?" — so recent work and projects are the rail
 * itself rather than something to find behind a menu. The fixed sections stay,
 * quieter, at the bottom.
 *
 * Everything here is a read. The rail creates nothing, and the one primary
 * action it offers is a link to the new-run form, which still collects its own
 * choices and still approves nothing.
 */

interface RecentItem {
  key: string
  to: string
  label: string
  detail: string
  updatedAt: string | null
  icon: IconName
}

/**
 * Narrow screens stack the rail above the page, where a full list of recents
 * and projects would be a screenful to scroll past before reaching anything.
 * There it collapses behind one native disclosure — keyboard-operable, no
 * script of its own — while the primary action stays visible.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 860px)').matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 860px)')
    const onChange = (): void => setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function RailSections({ narrow, children }: { narrow: boolean; children: ReactNode }): JSX.Element {
  if (!narrow) return <>{children}</>
  return (
    <details className="rail-collapse">
      <summary>Recents, projects and sections</summary>
      {children}
    </details>
  )
}

const RECENT_LIMIT = 7
const PROJECT_LIMIT = 6

function runLabel(run: RunSummary): string {
  const requirement = (run.requirement ?? '').trim()
  if (requirement !== '') return requirement
  return run.runId
}

export function AppSidebar({ path }: { path: string }): JSX.Element {
  // The rail is on every screen, so it polls slowly and lets the shared change
  // counter do the prompt reloading.
  const runs = useApi<RunListResponse>('/api/runs', 60000)
  const chats = useApi<{ chats: ChatSummary[] }>('/api/chats', 60000)
  const projects = useApi<ProjectListResponse>('/api/projects', 60000)
  // Sessions are the only thing in this rail that changes second to second, and
  // Active sessions is the only page where reading them that often is the
  // point. Everywhere else the rail needs the list to be *right*, not fresh: one
  // fetch on mount, then whatever the shared change counter announces. Starting
  // or stopping a session from a run's Session tab announces immediately, so the
  // one case that matters is never stale — and this stops a 5-second poll from
  // running on every other screen in the console.
  const onSessionsPage = path.startsWith('/sessions')
  const sessions = useApi<SessionListResponse>(
    '/api/sessions', onSessionsPage ? 5000 : 0)

  const recents: RecentItem[] = [
    ...(runs.data?.runs ?? []).map((run) => ({
      key: `run:${run.runId}`,
      to: `/runs/${run.runId}`,
      label: runLabel(run),
      detail: run.state ?? 'unknown',
      updatedAt: run.updatedAt ?? null,
      icon: 'run' as IconName,
    })),
    ...(chats.data?.chats ?? []).map((chat) => ({
      key: `chat:${chat.chatId}`,
      to: `/chats/${chat.chatId}`,
      label: chat.title,
      detail: chat.profile,
      updatedAt: chat.updatedAt,
      icon: 'chat' as IconName,
    })),
  ]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, RECENT_LIMIT)

  const narrow = useNarrow()
  const projectRows = (projects.data?.projects ?? []).slice(0, PROJECT_LIMIT)
  const runningSessions = (sessions.data?.sessions ?? [])
    .filter((session) => session.status === 'running' && !session.runId.startsWith('login:'))
  const loading = runs.data === null && chats.data === null && projects.data === null

  return (
    <nav className="sidebar" aria-label="Workspace">
      <Link to="/runs" className="brand">
        <Icon name="spark" size={18} className="spark" />
        <span>
          FLOW
          <small>Forward-deployed Local Operations Workspace</small>
        </span>
      </Link>

      <div className="rail-section">
        <Link to="/runs/new" className="rail-new">
          <Icon name="plus" />
          New run
        </Link>
        <div className="rail-quick" style={{ marginTop: 8 }}>
          <Link to="/systems/forward-deployed-engineer/new">New FDE lifecycle</Link>
          <Link to="/chats/new">New chat</Link>
          <Link to="/design-panel/new">Design panel</Link>
        </div>
      </div>

      <RailSections narrow={narrow}>
      {runningSessions.length > 0 ? (
        <div className="rail-section">
          <h2 className="rail-heading" id="rail-running">Running</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-labelledby="rail-running">
            {runningSessions.map((session) => {
              const run = (runs.data?.runs ?? []).find((candidate) => candidate.runId === session.runId)
              const label = run === undefined ? session.runId : runLabel(run)
              return (
                <li key={session.runId}>
                  <Link
                    to={`/runs/${session.runId}?tab=session`}
                    className="rail-item"
                    current={path === `/runs/${session.runId}`}
                  >
                    <Icon name="terminal" className="rail-icon" />
                    <span className="rail-label" title={label}>{label}</span>
                    <span className="badge ok">live</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      <div className="rail-section">
        <h2 className="rail-heading" id="rail-recents">Recents</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-labelledby="rail-recents">
          {recents.map((item) => (
            <li key={item.key}>
              <Link
                to={item.to}
                className="rail-item"
                current={path === item.to}
              >
                <Icon name={item.icon} className="rail-icon" />
                <span className="rail-label" title={item.label}>{item.label}</span>
                <span className="rail-when">{formatSince(item.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {recents.length === 0 ? (
          <p className="rail-empty">{loading ? 'Loading…' : 'Nothing yet. Start a run.'}</p>
        ) : null}
      </div>

      <div className="rail-section">
        <h2 className="rail-heading" id="rail-projects">Projects</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-labelledby="rail-projects">
          {projectRows.map((project) => (
            <li key={project.projectId}>
              <Link
                to={`/projects/${project.projectId}`}
                className="rail-item"
                current={path === `/projects/${project.projectId}`}
              >
                <Icon name="project" className="rail-icon" />
                <span className="rail-label" title={project.name ?? project.projectId}>
                  {project.name ?? project.projectId}
                </span>
                {typeof project.runCount === 'number' ? (
                  <span className="rail-when">{project.runCount}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
        {projectRows.length === 0 ? (
          <p className="rail-empty">{loading ? 'Loading…' : 'No projects yet.'}</p>
        ) : null}
        <p className="rail-more">
          <Link to="/projects">All projects</Link>
        </p>
      </div>

      <div className="rail-section rail-footer">
        <Link to="/systems" className="rail-item" current={path.startsWith('/systems')}>
          <Icon name="spark" className="rail-icon" />
          <span className="rail-label">Systems</span>
        </Link>
        <Link to="/runs" className="rail-item" current={path === '/runs'}>
          <Icon name="run" className="rail-icon" />
          <span className="rail-label">All runs</span>
        </Link>
        <Link to="/chats" className="rail-item" current={path === '/chats'}>
          <Icon name="chat" className="rail-icon" />
          <span className="rail-label">All chats</span>
        </Link>
        <Link to="/sessions" className="rail-item" current={path === '/sessions'}>
          <Icon name="terminal" className="rail-icon" />
          <span className="rail-label">Active sessions</span>
        </Link>
        <Link to="/configuration" className="rail-item" current={path.startsWith('/configuration') || path.startsWith('/accounts')}>
          <Icon name="key" className="rail-icon" />
          <span className="rail-label">Configuration</span>
        </Link>
        <Link to="/health" className="rail-item" current={path === '/health'}>
          <Icon name="health" className="rail-icon" />
          <span className="rail-label">System health</span>
        </Link>
      </div>
      </RailSections>
    </nav>
  )
}
