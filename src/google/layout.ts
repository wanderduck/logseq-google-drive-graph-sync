// Plan M4 step 1: the folder layout of plan §3.3, created on demand under My Drive:
//   <RootFolder>/graphs/<graph>/      the two-way mirror (+ .gdsync/lock.json)
//   <RootFolder>/snapshots/<graph>/   graph zip snapshots
//   <RootFolder>/profile/             Logseq profile bundles
// Everything is created by this app, so all of it is reachable under the `drive.file` scope.

import { ROOT_ID, type DriveClient } from './drive'

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
