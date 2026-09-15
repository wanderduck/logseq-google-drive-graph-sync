// The actions the UI can trigger. M2 ships a mock implementation (src/mock/); M7 replaces it with the
// real engine behind the same interface, so the toolbar, commands and panel do not change.

import type { ConflictResolution } from './conflict'

export interface SyncController {
  /** Plan §3.6. No-op with a toast when signed out or already running. */
  syncNow(): Promise<void>
  /** Graph snapshot + profile bundle, outside the 24 h rule (plan C2). */
  backupNow(): Promise<void>
  /** The only automatic remote call: a status check when the panel opens (plan D9). */
  checkRemote(): Promise<void>
  connect(): Promise<void>
  signOut(): Promise<void>
  /** Answers the conflict dialog. Paths missing from `resolutions` are skipped (plan §3.6 step 6). */
  resolveConflicts(resolutions: ConflictResolution[]): void
  dismissError(): void
  /** Stops timers and pending work; called from `logseq.beforeunload`. */
  dispose(): void
}
