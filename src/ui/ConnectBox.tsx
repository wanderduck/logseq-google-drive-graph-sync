// Device-code sign-in view (plan M3 step 2): the code to type, an "Open" button for the verification
// URL (`App.openExternalLink`, Ref §6.3), a copy button, the expiry countdown, and Cancel. Polling runs
// in the auth service, so closing the overlay does not interrupt the sign-in.

import { showToast } from '../logseq/toasts'
import type { DeviceFlowInfo } from '../sync/status'
import { formatRelativeTime } from './format'

export interface ConnectBoxProps {
  flow: DeviceFlowInfo
  now: number
  onCancel(): void
}

function openVerificationUrl(url: string): void {
  logseq.App.openExternalLink(url).catch((err: unknown) => {
    console.error('[gdsync] openExternalLink failed', err)
    showToast(`Could not open the browser. Visit ${url} yourself.`, 'warning')
  })
}

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    showToast(`Code ${code} copied.`, 'success', 2500)
  } catch (err) {
    console.error('[gdsync] clipboard write failed', err)
    showToast('Copying failed; select the code and copy it by hand.', 'warning')
  }
}

export function ConnectBox({ flow, now, onCancel }: ConnectBoxProps) {
  const expired = now >= flow.expiresAt
  return (
    <div className="gdsync-connect" role="status" aria-live="polite">
      <div className="gdsync-connect__title">Connect this device to Google Drive</div>
      <ol className="gdsync-connect__steps">
        <li>
          Open{' '}
          <button type="button" className="gdsync-link" onClick={() => openVerificationUrl(flow.verificationUrl)}>
            {flow.verificationUrl}
          </button>{' '}
          in your browser.
        </li>
        <li>
          Enter the code <code className="gdsync-connect__code">{flow.userCode}</code>{' '}
          <button type="button" className="gdsync-btn gdsync-btn--small" onClick={() => void copyCode(flow.userCode)}>
            Copy
          </button>
        </li>
        <li>Choose the Google account and allow access. Only files this plugin creates are visible to it.</li>
      </ol>
      <div className="gdsync-connect__footer">
        <span className="gdsync-muted gdsync-small">
          {expired ? 'The code has expired; cancel and connect again.' : `Waiting for approval… the code expires ${formatRelativeTime(flow.expiresAt, now)}.`}
        </span>
        <div className="gdsync-connect__actions">
          <button type="button" className="gdsync-btn gdsync-btn--primary" onClick={() => openVerificationUrl(flow.verificationUrl)}>
            Open in browser
          </button>
          <button type="button" className="gdsync-btn gdsync-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
