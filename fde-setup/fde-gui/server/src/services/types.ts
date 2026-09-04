import type { AdvisoryLocks } from './locks'
import type { AccountService } from './accounts'
import type { ChatService } from './chats'
import type { SessionManager } from './sessions'
import type { ChangeWatcher } from './watch'

export interface Services {
  locks: AdvisoryLocks
  watcher: ChangeWatcher
  sessions: SessionManager
  accounts: AccountService
  chats: ChatService
}
