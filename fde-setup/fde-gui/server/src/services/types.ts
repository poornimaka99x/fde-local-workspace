import type { AdvisoryLocks } from './locks'
import type { ChangeWatcher } from './watch'

export interface Services {
  locks: AdvisoryLocks
  watcher: ChangeWatcher
}
