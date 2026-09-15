// The actions the UI can trigger. M2 shipped a mock implementation; since M7 `src/logseq/syncController.ts`
// implements it around `runSyncSession` (session.ts), so the toolbar, commands and panel never changed.

import type { ConflictResolution } from './conflict'

export interface SyncNowOptions {
  /** Take over another device's lock whose `expiresAt` has passed (plan §3.6 step 2: the UI asks first). */
  breakExpiredLock?: boolean
}

export interface SyncController {
  /** Plan §3.6. No-op with a toast when signed out or already running. */
  syncNow(opts?: SyncNowOptions): Promise<void>
  /** Graph snapshot + profile bundle, outside the 24 h rule (plan C2). */
  backupNow(): Promise<void>
  /** The only automatic remote call: a status check when the panel opens (plan D9). */
  checkRemote(): Promise<void>
  /** Starts the device-code sign-in (plan M3 step 2); progress is visible in `status.deviceFlow`. */
  connect(): Promise<void>
  /** Aborts a sign-in that is waiting for approval; no-op otherwise. */
  cancelConnect(): void
  /** Revokes the Google grant (best effort) and forgets the local session. */
  signOut(): Promise<void>
  /** Answers the conflict dialog. Paths missing from `resolutions` are skipped (plan §3.6 step 6). */
  resolveConflicts(resolutions: ConflictResolution[]): void
  dismissError(): void
  /** Stops a running sync (its journal makes the next run resume), releases the lock; awaited by `logseq.beforeunload`. */
  dispose(): Promise<void>
}
