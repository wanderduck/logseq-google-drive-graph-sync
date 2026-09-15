// M5 DoD: "manual smoke test on the test graph". A scripted run of the local file layer inside Logseq,
// started from the demo controls: bridge + dot dir, listing, cold and warm scans, text/byte reads, atomic
// create/overwrite with a bak copy, a binary round trip, rename, move-to-bak, and a read-only look at the
// profile root. Lives in src/mock/ (deleted in M7).
//
// It only runs when the current graph lives under ~/logseq-test-graphs/ (D11). Everything it creates ends
// up in `logseq/bak/gdsync/smoke-<ts>/` (ignored by Logseq and by our scanner); a failed run moves whatever
// it had created there too, best effort, and the report names the folder.

import { writeFileAtomic, listTempFiles } from '../fs/atomicWrite'
import { createBakSession, type BakSession } from '../fs/bak'
import { isFsNotFound, type GraphFs } from '../fs/graphFs'
import { sha256Hex } from '../fs/hash'
import { scanFiles, type ScanCacheEntry, type ScanResult } from '../fs/scanner'
import { createHostGraphFs, createHostProfileFs, getDotDirRoot, hostBridge } from '../logseq/fsHost'

export interface FsSmokeReport {
  passed: number
  total: number
  failedStep: string | null
  error: string | null
  /** Where the run's files were moved (always, success or not). */
  bakDir: string | null
  durationMs: number
}

export interface FsSmokeDeps {
  graph: { name: string; path: string } | null
  log: (line: string, detail?: unknown) => void
  onStep: (label: string, index: number, total: number) => void
}

const TEST_GRAPH_MARKER = '/logseq-test-graphs/'
const PAGE = 'pages/gdsync-smoke.md'
const PAGE_RENAMED = 'pages/gdsync-smoke-renamed.md'
const ASSET = 'assets/gdsync-smoke.bin'
const ASSET_BYTES = 300 * 1024 + 7
/** Long enough for the host watcher (`awaitWriteFinish`, ≈2 s) to index the page before it is renamed away. */
const WATCHER_PAUSE_MS = 3000

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65_536)))
  return out
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cacheOf(scan: ScanResult): (path: string) => ScanCacheEntry | undefined {
  const map = new Map(scan.files.map((f) => [f.path, f]))
  return (path) => map.get(path)
}

export async function runFsSmoke(deps: FsSmokeDeps): Promise<FsSmokeReport> {
  const startedAt = Date.now()
  const { log } = deps
  if (!deps.graph || !deps.graph.path.includes(TEST_GRAPH_MARKER)) {
    return {
      passed: 0,
      total: 0,
      failedStep: 'preflight',
      error: `The file smoke test only runs with a graph under ~${TEST_GRAPH_MARKER} open (D11); current: ${deps.graph?.path ?? 'none'}.`,
      bakDir: null,
      durationMs: Date.now() - startedAt,
    }
  }

  const steps: Array<[string, () => Promise<string>]> = []
  const step = (name: string, run: () => Promise<string>): void => {
    steps.push([name, run])
  }

  let fs: GraphFs | null = null
  let bak: BakSession | null = null
  let coldScan: ScanResult | null = null
  let warmScan: ScanResult | null = null
  let text1 = ''
  let text2 = ''
  let assetSha = ''

  step('bridge + dot dir root', async () => {
    const bridge = hostBridge()
    const dotDir = await getDotDirRoot(bridge)
    if (!dotDir.endsWith('/.logseq')) throw new Error(`unexpected dot dir "${dotDir}"`)
    fs = createHostGraphFs(deps.graph!.path, bridge)
    bak = createBakSession(fs, new Date(startedAt), 'smoke')
    return `doAction reachable; ~/.logseq = ${dotDir}; graph root ${fs.root}; bak folder ${bak.dir}`
  })

  step('list the graph', async () => {
    const all = await fs!.list()
    for (const p of ['pages/Alpha.md', 'logseq/config.edn']) if (!all.includes(p)) throw new Error(`listing misses ${p}`)
    if (all.some((p) => p.startsWith('/'))) throw new Error('listing contains an absolute path')
    const pages = await fs!.list('pages')
    if (!pages.every((p) => p.startsWith('pages/'))) throw new Error('list(pages) returned paths outside pages/')
    if ((await fs!.list('no-such-dir')).length !== 0) throw new Error('a missing dir did not list as empty')
    return `${all.length} entries (${pages.length} under pages/); missing dir lists as empty`
  })

  step('cold scan (hash everything)', async () => {
    const t = Date.now()
    coldScan = await scanFiles(fs!)
    const paths = coldScan.files.map((f) => f.path)
    if (coldScan.hashed !== coldScan.files.length) throw new Error(`hashed ${coldScan.hashed} of ${coldScan.files.length}`)
    if (paths.some((p) => p.startsWith('logseq/.recycle') || p.startsWith('logseq/bak') || p.endsWith('.gdsync-tmp'))) throw new Error('an ignored path was scanned')
    if (!paths.includes('assets/big-noise.png')) throw new Error('assets/big-noise.png missing from the scan')
    return `${coldScan.files.length} files hashed in ${Date.now() - t} ms; ${coldScan.ignored} ignored, ${coldScan.vanished} vanished`
  })

  step('warm scan (cache hits only)', async () => {
    const t = Date.now()
    warmScan = await scanFiles(fs!, { cache: cacheOf(coldScan!) })
    if (warmScan.hashed !== 0 || warmScan.reused !== coldScan!.files.length) throw new Error(`hashed ${warmScan.hashed}, reused ${warmScan.reused}`)
    if (JSON.stringify(warmScan.files) !== JSON.stringify(coldScan!.files)) throw new Error('warm scan differs from the cold scan')
    return `${warmScan.reused} cache hits, 0 hashed, in ${Date.now() - t} ms`
  })

  step('read text + bytes', async () => {
    const edn = await fs!.readText('logseq/config.edn')
    if (!edn.trimStart().startsWith('{')) throw new Error('config.edn does not look like EDN')
    const t = Date.now()
    const bytes = await fs!.readBytes('assets/big-noise.png')
    const sha = await sha256Hex(bytes)
    const scanned = coldScan!.files.find((f) => f.path === 'assets/big-noise.png')!
    if (sha !== scanned.sha256) throw new Error('readBytes hash differs from the scan')
    if (bytes.byteLength !== scanned.size) throw new Error(`size ${bytes.byteLength} ≠ stat ${scanned.size}`)
    return `config.edn ${edn.length} chars; big-noise.png ${bytes.byteLength} bytes in ${Date.now() - t} ms, sha256 matches the scan`
  })

  step('missing paths', async () => {
    if ((await fs!.stat('pages/gdsync-no-such-page.md')) !== null) throw new Error('stat of a missing file is not null')
    try {
      await fs!.readBytes('pages/gdsync-no-such-page.md')
      throw new Error('readBytes of a missing file did not fail')
    } catch (err) {
      if (!isFsNotFound(err)) throw err
    }
    return 'stat → null, readBytes → ENOENT FsError'
  })

  step('atomic create', async () => {
    text1 = `- gdsync file smoke, written at ${new Date(startedAt).toISOString()}\n`
    const stat = await writeFileAtomic(fs!, PAGE, text1)
    const after = await fs!.stat(PAGE)
    if (!after || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error(`stat after write ${JSON.stringify(after)} ≠ returned ${JSON.stringify(stat)}`)
    if ((await listTempFiles(fs!)).length !== 0) throw new Error('a .gdsync-tmp file was left behind')
    if (!(await fs!.list('pages')).includes(PAGE)) throw new Error('the new page is not listed')
    return `${PAGE} created (${stat.size} bytes, mtime ${new Date(stat.mtimeMs).toISOString()}), no temp file left`
  })

  step('backup copy + atomic overwrite', async () => {
    const copy = await bak!.backupCopy(PAGE)
    text2 = `${text1}- second line, overwritten atomically\n`
    await writeFileAtomic(fs!, PAGE, text2)
    if ((await fs!.readText(PAGE)) !== text2) throw new Error('overwritten content differs')
    if ((await fs!.readText(copy)) !== text1) throw new Error('the bak copy does not hold the previous content')
    await new Promise((resolve) => setTimeout(resolve, WATCHER_PAUSE_MS))
    return `previous content copied to ${copy}; page overwritten in place; waited ${WATCHER_PAUSE_MS} ms for the watcher`
  })

  step('binary round trip', async () => {
    const bytes = randomBytes(ASSET_BYTES)
    assetSha = await sha256Hex(bytes)
    const t = Date.now()
    const stat = await writeFileAtomic(fs!, ASSET, bytes)
    const back = await fs!.readBytes(ASSET)
    if (stat.size !== ASSET_BYTES || back.byteLength !== ASSET_BYTES) throw new Error(`size ${stat.size}/${back.byteLength} ≠ ${ASSET_BYTES}`)
    if ((await sha256Hex(back)) !== assetSha) throw new Error('bytes differ after the round trip')
    return `${ASSET_BYTES} random bytes written and read back byte-identical in ${Date.now() - t} ms`
  })

  step('rescan sees exactly the two new files', async () => {
    const scan = await scanFiles(fs!, { cache: cacheOf(warmScan!) })
    if (scan.hashed !== 2 || scan.reused !== warmScan!.files.length) throw new Error(`hashed ${scan.hashed}, reused ${scan.reused}`)
    const asset = scan.files.find((f) => f.path === ASSET)
    if (!asset || asset.sha256 !== assetSha) throw new Error('the asset hash in the scan is wrong')
    return `${scan.files.length} files: 2 hashed (the new page and asset), ${scan.reused} reused`
  })

  step('rename', async () => {
    await fs!.rename(PAGE, PAGE_RENAMED)
    if ((await fs!.stat(PAGE)) !== null) throw new Error('the old name still exists')
    if ((await fs!.readText(PAGE_RENAMED)) !== text2) throw new Error('content differs after rename')
    return `${PAGE} → ${PAGE_RENAMED}`
  })

  step('move to bak (the sync "delete")', async () => {
    const a = await bak!.moveIn(PAGE_RENAMED)
    const b = await bak!.moveIn(ASSET)
    const all = await fs!.list()
    if (all.includes(PAGE_RENAMED) || all.includes(ASSET)) throw new Error('moved files are still in the graph')
    const inBak = (await fs!.list(bak!.dir)).sort()
    if (inBak.length !== 3) throw new Error(`expected 3 files in ${bak!.dir}, found ${inBak.length}: ${inBak.join(', ')}`)
    if ((await sha256Hex(await fs!.readBytes(b))) !== assetSha) throw new Error('the asset changed on its way to bak')
    const scan = await scanFiles(fs!, { cache: cacheOf(warmScan!) })
    if (scan.files.length !== coldScan!.files.length || scan.hashed !== 0) throw new Error(`final scan: ${scan.files.length} files, ${scan.hashed} hashed`)
    if ((await fs!.list('logseq/.recycle')).some((p) => p.includes('gdsync-smoke'))) throw new Error('something landed in logseq/.recycle')
    return `${a}, ${b}; graph back to ${scan.files.length} files, nothing in .recycle`
  })

  step('profile root (read-only)', async () => {
    const profile = await createHostProfileFs()
    if (!profile.root.endsWith('/.logseq')) throw new Error(`profile root is ${profile.root}`)
    const settings = await profile.list('settings')
    const prefs = await profile.readText('preferences.json')
    JSON.parse(prefs)
    const config = await profile.stat('config/config.edn')
    return `${profile.root}: ${settings.length} settings files, preferences.json is valid JSON (${prefs.length} chars), config/config.edn ${config ? `${config.size} bytes` : 'absent'}`
  })

  const cleanupAfterFailure = async (): Promise<void> => {
    if (!fs || !bak) return
    for (const p of [PAGE, PAGE_RENAMED, ASSET]) {
      try {
        if ((await fs.stat(p)) !== null) log(`smoke cleanup: moved ${p} to ${await bak.moveIn(p)}`)
      } catch (err) {
        log(`smoke cleanup: could not move ${p}`, err)
      }
    }
  }

  let passed = 0
  for (let i = 0; i < steps.length; i++) {
    const [name, run] = steps[i]
    deps.onStep(name, i + 1, steps.length)
    const t = Date.now()
    try {
      const detail = await run()
      passed++
      log(`fs smoke ${i + 1}/${steps.length} ok (${Date.now() - t} ms): ${name} — ${detail}`)
    } catch (err) {
      const error = describeError(err)
      log(`fs smoke ${i + 1}/${steps.length} FAILED: ${name} — ${error}`, err)
      await cleanupAfterFailure()
      return { passed, total: steps.length, failedStep: name, error, bakDir: bak ? (bak as BakSession).dir : null, durationMs: Date.now() - startedAt }
    }
  }
  log(`fs smoke passed ${passed}/${steps.length} in ${Date.now() - startedAt} ms`)
  return { passed, total: steps.length, failedStep: null, error: null, bakDir: bak ? (bak as BakSession).dir : null, durationMs: Date.now() - startedAt }
}
