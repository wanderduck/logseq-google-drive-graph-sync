import { useEffect, useState } from 'react'
import {
  availableChoices,
  conflictCopyName,
  normalizeChoice,
  type ConflictChoice,
  type ConflictItem,
  type ConflictKind,
  type ConflictResolution,
  type ConflictSide,
} from '../sync/conflict'
import { formatBytes, formatDateTime } from './format'

export interface ConflictDialogProps {
  conflicts: ConflictItem[]
  deviceName: string
  /** Called once with every decision made; conflicts without a decision are skipped (plan §3.6 step 6). */
  onDone(resolutions: ConflictResolution[]): void
}

const KIND_TEXT: Record<ConflictKind, string> = {
  'both-modified': 'Changed on this device and on Google Drive since the last sync.',
  'remote-deleted': 'Changed on this device but deleted on Google Drive.',
  'local-deleted': 'Deleted on this device but changed on Google Drive.',
}

const KIND_HINT: Record<ConflictKind, string> = {
  'both-modified':
    'Keep local uploads this device’s version. Keep remote downloads the Drive version (the local copy is saved to logseq/bak/gdsync first).',
  'remote-deleted': 'Keep local re-uploads the file. Keep remote deletes it on this device (moved to logseq/bak/gdsync).',
  'local-deleted': 'Keep local moves the Drive file to the Drive trash. Keep remote restores it on this device.',
}

const CHOICES: ConflictChoice[] = ['keep-local', 'keep-remote', 'keep-both']
const CHOICE_LABEL: Record<ConflictChoice, string> = {
  'keep-local': 'Keep local',
  'keep-remote': 'Keep remote',
  'keep-both': 'Keep both',
}

function SideCard({ title, side }: { title: string; side: ConflictSide | null }) {
  return (
    <div className="gdsync-side">
      <div className="gdsync-side__title">{title}</div>
      {side ? (
        <dl className="gdsync-side__facts">
          <dt>Size</dt>
          <dd>{formatBytes(side.size)}</dd>
          <dt>Modified</dt>
          <dd>{formatDateTime(side.modifiedAt)}</dd>
          <dt>SHA-256</dt>
          <dd>{side.sha256 ? <code title={side.sha256}>{side.sha256.slice(0, 12)}…</code> : <span className="gdsync-muted">unknown</span>}</dd>
        </dl>
      ) : (
        <div className="gdsync-muted">deleted</div>
      )}
    </div>
  )
}

// Walks the conflicts one at a time (plan D7): keep local / keep remote / keep both / apply to all remaining.
export function ConflictDialog({ conflicts, deviceName, onDone }: ConflictDialogProps) {
  const [index, setIndex] = useState(0)
  const [decisions, setDecisions] = useState<ConflictResolution[]>([])
  const [applyToAll, setApplyToAll] = useState(false)

  // Escape = skip everything not yet decided; the decisions already made are kept.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDone(decisions)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [decisions, onDone])

  const item = conflicts[index]
  if (!item) return null

  const total = conflicts.length
  const remaining = conflicts.slice(index)
  const choices = availableChoices(item)
  const bothName = conflictCopyName(item.path, deviceName, new Date())

  const advance = (next: ConflictResolution[]): void => {
    if (index + 1 >= total) {
      onDone(next)
    } else {
      setDecisions(next)
      setIndex(index + 1)
    }
  }

  const choose = (choice: ConflictChoice): void => {
    if (applyToAll) {
      onDone([...decisions, ...remaining.map((c) => ({ path: c.path, choice: normalizeChoice(c, choice) }))])
      return
    }
    advance([...decisions, { path: item.path, choice }])
  }

  const skipThis = (): void => {
    if (applyToAll) onDone(decisions)
    else advance(decisions)
  }

  return (
    <section
      className="gdsync-panel gdsync-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gdsync-conflict-title"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="gdsync-panel__header">
        <h1 id="gdsync-conflict-title">
          Conflict {index + 1} of {total}
        </h1>
      </header>

      <p className="gdsync-path-line">
        <code>{item.path}</code>
      </p>
      <p>{KIND_TEXT[item.kind]}</p>

      <div className="gdsync-sides">
        <SideCard title="This device" side={item.local} />
        <SideCard title="Google Drive" side={item.remote} />
      </div>

      <div className="gdsync-choices">
        {CHOICES.map((c) => (
          <button
            key={c}
            type="button"
            className={`gdsync-btn ${c === 'keep-both' ? '' : 'gdsync-btn--primary'}`}
            disabled={!choices.includes(c)}
            title={c === 'keep-both' && !choices.includes(c) ? 'Only one version exists' : undefined}
            onClick={() => choose(c)}
          >
            {CHOICE_LABEL[c]}
          </button>
        ))}
      </div>
      <p className="gdsync-muted gdsync-small">{KIND_HINT[item.kind]}</p>
      {choices.includes('keep-both') && (
        <p className="gdsync-muted gdsync-small">
          Keep both renames this device’s version to <code>{bothName}</code>; the Drive version takes the original path.
        </p>
      )}

      <label className="gdsync-check">
        <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} /> Apply my choice
        to all remaining conflicts ({remaining.length})
      </label>

      <div className="gdsync-actions gdsync-actions--split">
        <button type="button" className="gdsync-btn gdsync-btn--ghost" onClick={skipThis}>
          Skip this file
        </button>
        <button type="button" className="gdsync-btn gdsync-btn--ghost" onClick={() => onDone(decisions)}>
          Skip all remaining
        </button>
      </div>
      <p className="gdsync-hint">Skipped files stay unchanged on both sides and are reported when the sync finishes. Esc skips the rest.</p>
    </section>
  )
}
