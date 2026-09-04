import type { AdvisoryLocks } from './locks'
import type { SessionManager } from './sessions'
import type { ChangeWatcher } from './watch'

export interface Services {
  locks: AdvisoryLocks
  watcher: ChangeWatcher
  sessions: SessionManager
}
