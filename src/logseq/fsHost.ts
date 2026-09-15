// Host wiring for src/fs/: finds the Electron bridge on the host window (`window.top.apis.doAction`,
// spike §2 item 2a) and builds `GraphFs` instances for the graph directory and for `~/.logseq`.
// This is the only place that knows where the bridge lives, so a Logseq update that moves or removes it
// fails here with one clear error (plan §7 risk table).

import { createHostBridgeFs, type BridgeCall } from '../fs/hostBridgeFs'
import type { GraphFs } from '../fs/graphFs'

export class BridgeUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The Logseq file bridge is not reachable (${detail}). Google Drive Graph Sync needs Logseq 0.10.x desktop ` +
        'and must be loaded as an unpacked plugin or with `effect: true`.',
    )
    this.name = 'BridgeUnavailableError'
  }
}

interface HostApis {
  doAction?: unknown
}

/** Pure so it is testable: extracts `apis.doAction` from the host window object. */
export function resolveBridge(hostWindow: unknown): BridgeCall {
  if (hostWindow === null || hostWindow === undefined) throw new BridgeUnavailableError('no host window')
  const apis = (hostWindow as { apis?: HostApis }).apis
  if (apis === null || typeof apis !== 'object') throw new BridgeUnavailableError('window.apis is missing')
  const doAction = apis.doAction
  if (typeof doAction !== 'function') throw new BridgeUnavailableError('window.apis.doAction is not a function')
  return (args) => (doAction as (a: unknown[]) => Promise<unknown>).call(apis, args)
}

/** `window.top` throws a `SecurityError` from a cross-origin (`lsp://`) frame; that also means "no bridge". */
export function hostBridge(): BridgeCall {
  let top: unknown
  try {
    top = window.top
  } catch (err) {
    throw new BridgeUnavailableError(`window.top is not accessible: ${err instanceof Error ? err.message : String(err)}`)
  }
  return resolveBridge(top)
}

/** `~/.logseq` (`handler.cljs :getLogseqDotDirRoot`), the profile root of plan §3.4. */
export async function getDotDirRoot(bridge: BridgeCall = hostBridge()): Promise<string> {
  const r = await bridge(['getLogseqDotDirRoot'])
  if (typeof r !== 'string' || r === '') throw new BridgeUnavailableError(`getLogseqDotDirRoot returned ${Object.prototype.toString.call(r)}`)
  return r
}

const fileFetch = (url: string): Promise<Response> => window.fetch(url)

/** `GraphFs` for a graph directory (`App.getCurrentGraph().path`). */
export function createHostGraphFs(root: string, bridge: BridgeCall = hostBridge()): GraphFs {
  return createHostBridgeFs({ root, bridge, fetch: fileFetch })
}

/** `GraphFs` rooted at `~/.logseq` (M8 profile bundle). `unlink` really deletes there (spike §2 item 2b). */
export async function createHostProfileFs(bridge: BridgeCall = hostBridge()): Promise<GraphFs> {
  return createHostBridgeFs({ root: await getDotDirRoot(bridge), bridge, fetch: fileFetch })
}
