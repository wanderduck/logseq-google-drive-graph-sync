// Plan M4 step 1: the folder layout of plan §3.3, created on demand under My Drive:
//   <RootFolder>/graphs/<graph>/      the two-way mirror (+ .gdsync/lock.json)
//   <RootFolder>/snapshots/<graph>/   graph zip snapshots
//   <RootFolder>/profile/             Logseq profile bundles
// Everything is created by this app, so all of it is reachable under the `drive.file` scope.

import { ROOT_ID, isNotFound, type DriveClient, type DriveFile } from './drive'

export const GRAPHS_DIR = 'graphs'
export const SNAPSHOTS_DIR = 'snapshots'
export const PROFILE_DIR = 'profile'

export interface DriveLayout {
  rootId: string
  graphsId: string
  graphFolderId: string
  snapshotsId: string
  snapshotsGraphId: string
  profileId: string
}

export interface LayoutSpec {
  /** Settings `rootFolderName`. */
  rootFolderName: string
  /** The Logseq graph name (`App.getCurrentGraph().name`). */
  graphName: string
}

/** Drive names are free text except that `/` would read as a path; empty names are not allowed. */
export function driveFolderName(raw: string, fallback: string): string {
  const cleaned = raw.trim().replace(/\//g, '_')
  return cleaned === '' ? fallback : cleaned
}

export async function bootstrapLayout(client: DriveClient, spec: LayoutSpec): Promise<DriveLayout> {
  const rootName = driveFolderName(spec.rootFolderName, 'Logseq Graph Sync')
  const graphName = driveFolderName(spec.graphName, 'graph')
  const rootId = await client.ensureFolder(ROOT_ID, rootName)
  const graphsId = await client.ensureFolder(rootId, GRAPHS_DIR)
  const graphFolderId = await client.ensureFolder(graphsId, graphName)
  const snapshotsId = await client.ensureFolder(rootId, SNAPSHOTS_DIR)
  const snapshotsGraphId = await client.ensureFolder(snapshotsId, graphName)
  const profileId = await client.ensureFolder(rootId, PROFILE_DIR)
  return { rootId, graphsId, graphFolderId, snapshotsId, snapshotsGraphId, profileId }
}

/** The two ids the sync persists in `state/<graph-key>.json` (plan §3.5 `driveRootId`, `graphFolderId`). */
export interface LayoutIds {
  driveRootId: string
  graphFolderId: string
}

async function liveFolder(client: DriveClient, id: string): Promise<DriveFile | null> {
  try {
    const f = await client.getFile(id)
    return f.isFolder && !f.trashed ? f : null
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/**
 * `known` still names the layout of `spec` when both folders are live, the root carries the configured name
 * and the graph folder sits at `<root>/graphs/<graph>`: three requests instead of the six lookups of
 * `bootstrapLayout` (≈1.5 s each, M4). A root renamed in settings or a folder trashed/deleted in Drive
 * fails the check, and the caller starts a fresh mirror (session.ts).
 */
export async function verifyLayout(client: DriveClient, spec: LayoutSpec, known: LayoutIds): Promise<boolean> {
  const rootName = driveFolderName(spec.rootFolderName, 'Logseq Graph Sync')
  const graphName = driveFolderName(spec.graphName, 'graph')
  const root = await liveFolder(client, known.driveRootId)
  if (!root || root.name !== rootName) return false
  const graph = await liveFolder(client, known.graphFolderId)
  if (!graph || graph.name !== graphName) return false
  const segments = await client.pathUnder(graph, root.id)
  if (segments === null || segments.join('/') !== `${GRAPHS_DIR}/${graphName}`) return false
  client.folders.set(ROOT_ID, rootName, root.id)
  return true
}

/** Persisted ids when they verify, otherwise the full bootstrap (creating what is missing). */
export async function resolveLayout(client: DriveClient, spec: LayoutSpec, known: LayoutIds | null): Promise<LayoutIds & { reused: boolean }> {
  if (known && (await verifyLayout(client, spec, known))) return { ...known, reused: true }
  const layout = await bootstrapLayout(client, spec)
  return { driveRootId: layout.rootId, graphFolderId: layout.graphFolderId, reused: false }
}

/** Find-only twin of `resolveLayout` for the panel's remote check (D9): `null` when the graph has no mirror folder yet. */
export async function findLayout(client: DriveClient, spec: LayoutSpec, known: LayoutIds | null): Promise<LayoutIds | null> {
  if (known && (await verifyLayout(client, spec, known))) return known
  const rootName = driveFolderName(spec.rootFolderName, 'Logseq Graph Sync')
  const graphName = driveFolderName(spec.graphName, 'graph')
  const root = await client.findChild(ROOT_ID, rootName, true)
  if (!root) return null
  const graphs = await client.findChild(root.id, GRAPHS_DIR, true)
  if (!graphs) return null
  const graph = await client.findChild(graphs.id, graphName, true)
  if (!graph) return null
  client.folders.set(ROOT_ID, rootName, root.id)
  client.folders.set(root.id, GRAPHS_DIR, graphs.id)
  client.folders.set(graphs.id, graphName, graph.id)
  return { driveRootId: root.id, graphFolderId: graph.id }
}
