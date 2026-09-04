import { useApi } from '../../lib/useApi'
import type { HealthResponse } from '../../lib/types'
import { ErrorState, Loading } from '../../components/States'

export function HealthView(): JSX.Element {
  const health = useApi<HealthResponse>('/api/health')

  if (health.error) return <ErrorState error={health.error} onRetry={health.reload} />
  if (health.data === null) return <Loading label="Checking…" />

  return (
    <>
      <h1>System health</h1>
      <p className="lede">
        What this console is pointed at. No credential is read and no network check runs here —
        <code> fde doctor</code> stays the on-demand place for those.
      </p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Roots</h2>
        <table>
          <tbody>
            {Object.entries(health.data.roots).map(([name, value]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td className="mono">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Binaries</h2>
        <table>
          <tbody>
            {Object.entries(health.data.binaries).map(([name, info]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td className="mono">{info.path}</td>
                <td>
                  <span className={`badge ${info.present ? 'ok' : 'danger'}`}>
                    {info.present ? 'present' : 'missing'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Claude profiles</h2>
        {health.data.claudeProfiles.length === 0 ? (
          <p className="muted">No profile directories found.</p>
        ) : (
          <ul>
            {health.data.claudeProfiles.map((profile) => (
              <li key={profile.name}>
                <strong>{profile.name}</strong> <span className="muted mono">{profile.path}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Names only. Credential files are never opened or reported.
        </p>
      </div>

      <p className="muted">
        Console {health.data.version} · API v{health.data.apiVersion} · {health.data.mode} · started{' '}
        {health.data.startedAt}
      </p>
    </>
  )
}
