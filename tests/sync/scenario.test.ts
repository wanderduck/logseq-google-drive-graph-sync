// M6 step 5 / DoD: randomized two-device runs over one FakeDrive with fault injection and simulated crashes.
// Per run, the invariant is "the sync never destroys content": every content that was live on either device
// or on Drive before the run is still somewhere after it (either graph including logseq/bak, Drive live or
// trashed), except a Drive version the syncing device itself had synced before and now replaced with its own
// newer one (a plain upload; the other device gets a bak copy when it downloads). At the end both devices
// must converge with Drive and go quiet. Seeds are fixed so a failure is reproducible; `GDSYNC_FUZZ_SEEDS`
// raises the count for a longer local run.

import { describe, expect, it } from 'vitest'
import { FsError } from '../../src/fs/graphFs'
import { HttpError } from '../../src/google/errors'
import type { ConflictChoice, ConflictItem, ConflictResolution } from '../../src/sync/conflict'
import type { SyncRunResult } from '../../src/sync/engine'
import { jsonResponse, networkError } from '../google/helpers'
import { SimulatedCrash, createWorld, crashAtExecuteEvent, mulberry32, resolveAll, shaOf, type Device, type World } from './world'

const PATHS = ['pages/a.md', 'pages/b.md', 'pages/c.md', 'journals/2026_09_15.md', 'assets/x.bin', 'logseq/config.edn', 'deep/er/f.md', 'pages/d.md']
const CHOICES: ConflictChoice[] = ['keep-local', 'keep-remote', 'keep-both']
const ROUNDS = 14
const SEEDS = Number(process.env.GDSYNC_FUZZ_SEEDS ?? 40)

interface Rng {
  next(): number
  int(n: number): number
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
}

function rng(seed: number): Rng {
  const next = mulberry32(seed)
  return { next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p, pick: (items) => items[Math.floor(next() * items.length)] }
}

function randomResolver(r: Rng): (items: ConflictItem[]) => Promise<ConflictResolution[]> {
  return async (items) => items.filter(() => !r.chance(0.2)).map((i) => ({ path: i.path, choice: r.pick(CHOICES) }))
}

let contentCounter = 0
function freshContent(r: Rng): string {
  return `v${++contentCounter}-${r.int(1_000_000)}`
}

function injectFault(w: World, d: Device, r: Rng): string {
  const kind = r.int(6)
  const server = (status: number) => jsonResponse(status, { error: { code: status, message: `injected ${status}` } })
  switch (kind) {
    case 0:
      w.drive.failNext({ match: () => true, answer: server(500), times: 1 + r.int(3) })
      return 'drive 500 ×few'
    case 1:
      w.drive.failNext({ match: () => true, answer: networkError(), times: 1 + r.int(2) })
      return 'drive network ×few'
    case 2:
      w.drive.failNext({ match: (c) => c.url.pathname.startsWith('/upload/'), answer: server(503), times: 4 + r.int(6) })
      return 'drive 503 on uploads, persistent'
    case 3:
      w.drive.failNext({ match: (c) => c.method === 'POST' && c.url.pathname.startsWith('/upload/'), answer: networkError(), after: true })
      return 'lost upload response (server did the work)'
    case 4:
      d.graph.host.failNext({ match: (c) => c.action === 'writeFile', answer: null })
      return 'host writeFile swallowed'
    default:
      d.graph.host.failNext({ match: (c) => c.action === 'rename', answer: new Error('EPERM: operation not permitted, rename') })
      return 'host rename EPERM'
  }
}

function mutate(d: Device, r: Rng): string[] {
  const log: string[] = []
  const count = r.int(4)
  for (let i = 0; i < count; i++) {
    const path = r.pick(PATHS)
    if (d.has(path) && r.chance(0.3)) {
      d.remove(path)
      log.push(`${d.name} rm ${path}`)
    } else {
      const content = freshContent(r)
      d.write(path, content)
      log.push(`${d.name} write ${path}`)
    }
  }
  return log
}

function liveContents(w: World, devices: Device[]): Set<string> {
  const out = new Set<string>()
  for (const d of devices) for (const c of d.files().values()) out.add(c)
  for (const c of w.driveFiles().values()) out.add(c)
  return out
}

function everywhere(w: World, devices: Device[]): Set<string> {
  const out = new Set<string>(w.allDriveContents())
  for (const d of devices) for (const c of d.allContents()) out.add(c)
  return out
}

/** Runs `d.sync`, tolerating the failures the harness injects; anything else is a bug. */
async function trySync(d: Device, hooks: Parameters<Device['sync']>[0]): Promise<{ result: SyncRunResult | null; error: string | null }> {
  try {
    return { result: await d.sync(hooks), error: null }
  } catch (err) {
    if (err instanceof SimulatedCrash || err instanceof HttpError || err instanceof FsError || (err instanceof TypeError && err.message === 'Failed to fetch')) {
      return { result: null, error: err.message }
    }
    throw err
  }
}

async function runScenario(seed: number): Promise<void> {
  const r = rng(seed)
  const w = await createWorld({ concurrency: 1 + r.int(4) })
  const A = w.addDevice('A', { 'pages/a.md': 'seed a', 'logseq/config.edn': '{}' })
  const B = w.addDevice('B', { 'pages/b.md': 'seed b', 'logseq/config.edn': '{}' })
  const devices = [A, B]
  const trace: string[] = []

  for (let round = 0; round < ROUNDS; round++) {
    const d = r.pick(devices)
    trace.push(...mutate(d, r))
    if (r.chance(0.35)) trace.push(`fault: ${injectFault(w, d, r)}`)
    const crash = r.chance(0.15) ? 1 + r.int(4) : 0
    if (crash) trace.push(`${d.name} crashes at execute event ${crash}`)

    const before = liveContents(w, devices)
    const baseShas = new Set(Object.values((await d.state()).entries).map((e) => e.sha256))
    const { result, error } = await trySync(d, { resolveConflicts: randomResolver(r), onProgress: crash ? crashAtExecuteEvent(crash) : undefined })
    trace.push(`${d.name} sync → ${error ?? `up ${result!.uploaded} down ${result!.downloaded} delL ${result!.deletedLocal} delR ${result!.deletedRemote} conf ${result!.conflicts}/${result!.conflictsSkipped} fail ${result!.failures.length}`}`)

    const after = everywhere(w, devices)
    for (const content of before) {
      if (after.has(content)) continue
      const replacedOwnVersion = baseShas.has(await shaOf(content))
      expect(replacedOwnVersion, `seed ${seed} round ${round}: content "${content}" vanished\n${trace.join('\n')}`).toBe(true)
    }
  }

  // Settle: no more edits or faults; conflicts resolved deterministically; every run must eventually be quiet.
  let quiet = 0
  for (let i = 0; i < 12 && quiet < 3; i++) {
    const d = devices[i % 2]
    const { result, error } = await trySync(d, { resolveConflicts: resolveAll(r.pick(CHOICES)) })
    trace.push(`settle ${d.name} → ${error ?? `planned ${result!.planned} conf ${result!.conflicts} fail ${result!.failures.length} skipped ${result!.skippedOps.length}`}`)
    if (result && result.planned === 0 && result.conflicts === 0 && result.failures.length === 0 && result.skippedOps.length === 0) quiet++
    else quiet = 0
  }
  const detail = `seed ${seed}\n${trace.join('\n')}`
  expect(quiet, `did not settle: ${detail}`).toBeGreaterThanOrEqual(3)

  // Convergence: both graphs equal each other and Drive, one live file per Drive path (lost-response twins
  // were trashed), the states describe the files exactly.
  expect(A.files(), detail).toEqual(B.files())
  expect(w.driveFiles(), detail).toEqual(A.files())
  for (const [path, dupes] of w.driveFilesByPath()) expect(dupes.length, `${detail}\nduplicates of ${path}`).toBe(1)
  for (const d of devices) {
    const s = await d.state()
    expect(Object.keys(s.entries).sort(), detail).toEqual([...d.files().keys()].sort())
    expect(Object.keys(s.remote).sort(), detail).toEqual([...d.files().keys()].sort())
    for (const [path, content] of d.files()) {
      expect(s.entries[path].sha256, `${detail}\n${d.name} ${path}`).toBe(await shaOf(content))
      expect(s.remote[path].id, `${detail}\n${d.name} ${path}`).toBe(w.driveFile(path)!.id)
      expect(s.entries[path].driveId, `${detail}\n${d.name} ${path}`).toBe(w.driveFile(path)!.id)
    }
    expect([...d.files().keys()].some((p) => p.endsWith('.gdsync-tmp')), detail).toBe(false)
    expect(d.storage.files.get(`journal/${w.graphKey}.json`) ?? 'null', detail).toBe('null')
  }
}

describe(`randomized two-device scenarios (M6 step 5), ${SEEDS} seeds × ${ROUNDS} rounds`, () => {
  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))('seed %i converges with no content lost', async (seed) => {
    await runScenario(seed)
  })
})
