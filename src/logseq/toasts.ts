// Host notifications (plan M2 step 5). Verified in `logseq/sdk/ui.cljs` + `handler/notification.cljs` @0.10.15:
// `timeout: 0` makes the toast sticky (`clear? = timeout ≠ 0`), a call with an existing `key` replaces that
// toast's content in place, and `UI.closeMsg(key)` maps to `close_msg` → `notification/clear!`.

export type ToastStatus = 'info' | 'success' | 'warning' | 'error'

const PROGRESS_KEY = 'gdsync-progress'

export interface ProgressToast {
  update(text: string): Promise<void>
  close(): void
}

/** One sticky toast for the whole run; call `update` per step and `close` at the end (Ref §7 bulk-job pattern). */
export async function openProgressToast(text: string): Promise<ProgressToast> {
  const show = (t: string): Promise<string> => logseq.UI.showMsg(t, 'info', { key: PROGRESS_KEY, timeout: 0 })
  await show(text)
  return {
    update: async (t) => {
      await show(t)
    },
    close: () => {
      logseq.UI.closeMsg(PROGRESS_KEY)
    },
  }
}

export function showToast(text: string, status: ToastStatus, timeoutMs = 5000): void {
  void logseq.UI.showMsg(text, status, { timeout: timeoutMs })
}

/** A sticky toast under a caller-chosen key; call again to replace it, `closeToast(key)` to remove it. */
export function showStickyToast(key: string, text: string, status: ToastStatus = 'info'): void {
  void logseq.UI.showMsg(text, status, { key, timeout: 0 })
}

export function closeToast(key: string): void {
  logseq.UI.closeMsg(key)
}
