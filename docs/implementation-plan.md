# IMPLEMENTATION PLAN — Logseq ↔ Google Drive Graph Sync
- **Status:** APPROVED 2026-09-14. Scope: v1, personal use.
- **Companion docs:**
  - `docs/logseq-plugins_creation-reference.md` — Logseq API facts and gotchas; section numbers are cited below as "Ref §N".
  - `docs/progress.md` — the live status and handoff log. Update it at the end of every milestone and every session.

---

## 1. DECISIONS (user-approved)
| # | Topic | Decision |
|---|---|---|
| D1 | Distribution | Personal use first. A public release is a future goal, so keep the design release-friendly but don't build for it now. |
| D2 | Sync topology | **True two-way sync across 2+ desktops.** |
| D3 | Graph type | **File-based graphs only** (Logseq 0.10.x; SDK surface = `@logseq/libs` 0.0.17). DB graphs (Logseq 2.0) are deferred. |
| D4 | Architecture | **B: an `effect: true` plugin that does file I/O through the host's Electron file-system bridge**, pending the M0 gate. **Fallback if M0 fails: C, a local helper process** (milestone M5-C). |
| D5 | Google credentials | **Built-in OAuth client** from a GCP project the user owns. ID/secret are injected at build time from `.env.local` (never committed). A settings field allows overriding them. |
| D6 | Backups | Two-way mirror plus **zip snapshots** (graph zip, plus a separate profile zip). |
| D7 | Conflicts | **Prompt per file:** keep local / keep remote / keep both / apply choice to all remaining. |
| D8 | Sync scope | Everything needed to reproduce the setup on a new device: the graph folder **plus a Logseq profile bundle** (see §3.4). |
| D9 | Trigger | **Manual only:** Sync button (toolbar + command palette). No background polling or change listeners. The only automatic call is a remote-status check when the panel opens. "Sync on startup" is a setting, off by default. |
| D10 | Stack | Match `../logseq-gemini-predictive-text-plugin`: Vite 8, `@vitejs/plugin-react`, React 19, TypeScript ~6 (project refs `tsconfig.app.json`/`tsconfig.node.json`), npm, oxlint (react/typescript/oxc plugins), `base: './'`, tag-triggered `publish.yml`. **Addition: Vitest** (required for the sync engine). |
| D11 | Dev safety | Development and testing use only the disposable graph `~/logseq-test-graphs/gdsync-dev`, plus a second folder to simulate device 2. The user's real graph is touched only in M9, after a backup. |
| C1 | Plugin settings in profile backup | **Included by default, with a warning in the UI.** 9 of the user's settings files contain API keys/tokens. |
| C2 | Snapshot defaults | Auto-snapshot during Sync if the last snapshot is > 24 h old. Retention: **10** graph snapshots, **3** profile snapshots. |

---

## 2. VERIFIED CONSTRAINTS DRIVING THE DESIGN
1. There is no documented plugin API for raw graph file read/write (Ref §6.8). The host's Electron main process has `readFile`/`writeFile` (ArrayBuffer ok)/`readdir`/`stat`/`rename`/`mkdir-recur`/`unlink`/`copyFile` handlers, exposed to the host renderer as `window.apis.doAction([...])` (Ref §3.2). A plugin reaches it only with same-origin access (`effect: true`). **Untested.**
2. `logseq.Request` bypasses CORS but **JSON-stringifies every request body** on host 0.10.15, so it cannot do binary, multipart, or form uploads (Ref §6.7). Drive uploads must use iframe `fetch` (subject to CORS; **untested**).
3. Host 0.10.15 ships `@logseq/libs` **0.0.17**. Pin to it; newer SDK methods fail at runtime (Ref §2).
4. Google device-code OAuth flow supports `drive.file` and `drive.appdata` [verified, Google docs]. Token polling requires `client_secret`. The documented request body is `application/x-www-form-urlencoded`.
5. `drive.file` is a **non-sensitive** scope [verified]. A consent screen left in **"Testing"** status issues **refresh tokens that expire after 7 days** [verified], so the GCP app must be **published "In production"**.
6. Settings and FileStorage are plaintext under `~/.logseq/` (Ref §5.1, §6.6). Tokens and plugin secrets end up in plaintext locally and inside the profile snapshot. This must be documented in the README.
7. Plugins run only while the desktop app is open; there is no mobile plugin support (Ref §3.3).
8. User machine facts: `logseq-desktop-bin 0.10.15`. `~/.logseq/plugins` = 66 MB, `settings/` = 408 KB, `config/` = `config.edn` + `plugins.edn`, `graphs/` = caches.
9. Prior art (Ref §9):
   - `top/logseq-super-sync` — `effect: true`, reads assets via `fetch('file://…')`.
   - `kadaliao/logseq-github-auto-sync` — `effect: true` plus a local Node helper server; useful reference for M5-C.

---

## 3. ARCHITECTURE
### 3.1 Code layout
```
src/main.tsx          bootstrap: logseq.ready → register UI, commands, services; onCurrentGraphChanged; beforeunload
src/logseq/           settings schema, toolbar button/status, command palette, toasts, host-version check
src/ui/               React: status panel, conflict dialog, auth (device-code) view, restore wizard
src/fs/               GraphFs interface → HostBridgeFs (roots: graph dir + ~/.logseq); scanner; ignore rules; hashing
src/google/           auth (device flow, token store, refresh, revoke) · http transport (fetch vs logseq.Request, backoff)
                      · drive client (folder/ID cache, list, upload multipart/resumable, download, trash, appProperties, changes, lock)
src/sync/             PURE TS (no logseq/google imports): state model/store, three-way planner, conflict model,
                      executor (concurrency limit, journal, resume), snapshot builder (fflate), restore planner
tests/                Vitest; in-memory FakeGraphFs + FakeDrive; randomized two-device scenario tests
spikes/               M0 only; deleted at end of M0
```

### 3.2 Environment
- `.env.local` (gitignored): `VITE_GOOGLE_CLIENT_ID=…`, `VITE_GOOGLE_CLIENT_SECRET=…`.
- Advanced settings `googleClientId` / `googleClientSecret` override them when non-empty.

### 3.3 Drive layout (all created by the app, so reachable under `drive.file`)
```
<RootFolder>/graphs/<graph-name>/…                 two-way mirror; each file appProperties: { sha256, relPath, deviceId }
<RootFolder>/graphs/<graph-name>/.gdsync/lock.json { deviceId, deviceName, acquiredAt, expiresAt }
<RootFolder>/snapshots/<graph-name>/<ISO-ts>.zip   graph files + snapshot.json (createdAt, deviceId, logseqVersion, pluginVersion, files[{path,sha256,size}])
<RootFolder>/profile/profile-<ISO-ts>.zip          Logseq profile bundle; uploaded only when bundle content hash changed
```

### 3.4 Sync scope
- **Graph folder:** everything except `logseq/bak/`, `logseq/.recycle/`, `logseq/version-files/`, `.git/`, `.DS_Store`, `Thumbs.db`, `*.swp`, `*~`.
- **Profile bundle (`~/.logseq/`):**
  - Included: `config/` (`config.edn`, `plugins.edn`), `preferences.json`, `plugins/`, `settings/*.json` (C1: on by default, with a warning).
  - Excluded: `graphs/` (caches), **this plugin's own** settings file, and its FileStorage directory (tokens).

### 3.5 Local state (FileStorage, JSON strings)
- `device.json`: `{ deviceId (uuid), createdAt }`. The device *name* comes from settings.
- `state/<graph-key>.json`: `{ version, driveRootId, graphFolderId, changesPageToken, lastSyncAt, lastSnapshotAt, lastProfileHash, entries: { [relPath]: { sha256, size, mtime, driveId, driveModifiedTime, syncedAt } } }`.
- `journal/<graph-key>.json`: pending executor operations, so an interrupted sync resumes idempotently.

### 3.6 Sync flow (button press)
1. Preflight: auth valid; host version is 0.10.x (else warn); graph indexed; no sync already running.
2. Acquire the Drive lock. Refuse if another device holds an unexpired lock; offer to break it if expired.
3. **Local scan:** walk the graph dir with ignore rules. Re-hash (SHA-256) only when mtime or size differs from state.
4. **Remote delta:** `changes.list` since `changesPageToken`, filtered to the graph folder. On first sync or an invalid token, fall back to a full paged `files.list`.
5. **Plan (three-way per path)** with L = local, R = remote, B = base (last synced):
   - L = B, R = B → no-op
   - L ≠ B, R = B → upload
   - L = B, R ≠ B → download
   - L ≠ B, R ≠ B, L = R → update base only
   - L ≠ B, R ≠ B, L ≠ R → **conflict**
   - Deletes: absent-vs-base is a delete. Delete on one side with a modify on the other → **conflict**. Deleted on both → drop entry.
   - Renames are treated as delete + add (v1).
6. **Conflict dialog (D7):** keep local / keep remote / keep both (`name.conflict-<deviceName>-<YYYYMMDD-HHmm>.ext`) / apply to all. Unresolved conflicts are skipped and reported.
7. **Execute** with a concurrency limit, journaled per operation:
   - Downloads use atomic writes (`<path>.gdsync-tmp` → rename). **Before overwriting an existing local file, its previous content is copied to `logseq/bak/gdsync/<ts>/`** (amendment approved 2026-09-15; Logseq's own `bak/` only fires on deletions, see `docs/spike-results.md` §4.3).
   - Local deletions are moved to `logseq/bak/gdsync/<ts>/`.
   - Remote deletions go to Drive trash.
   - Writes to the page currently open in the editor: **M0 finding — the host shows no prompt and an external write to the block being edited closes the editor and drops unsaved input.** The executor therefore force-saves with `logseq.Editor.exitEditingMode()` before the local scan and before any write, then waits for the flush (`docs/spike-results.md` §4.2).
8. Persist state and the new `changesPageToken`. Clear the journal.
9. **Snapshot (C2):** if `now - lastSnapshotAt > 24h`, build the graph zip (streaming fflate), do a resumable upload, and apply retention 10. Recompute the profile bundle hash; if it changed, upload the profile zip and apply retention 3.
10. Release the lock. Update toolbar status and panel. Show a summary toast.

### 3.7 Restore (new device)
1. Prerequisites: Logseq installed, plugin installed, **empty graph created in Logseq**, Google connected.
2. The wizard lists graphs in Drive. For each: "latest mirror" or a chosen snapshot.
3. Safety check: the target graph dir must be empty. If not, a full safety copy goes to `logseq/bak/gdsync/restore-<ts>/`.
4. Write files atomically, then seed `state/<graph-key>.json` from what was written, so the next sync is a no-op.
5. Optional profile restore (with warning): write into `~/.logseq/`, excluding this plugin's own settings and storage.
6. Prompt: re-index the graph and restart Logseq.

---

## 4. USER PREREQUISITE (before M0 step 4)
In the Google Cloud Console:
1. Create a project.
2. Enable the **Google Drive API**.
3. Set up the **OAuth consent screen**: External; app name; add scope `https://www.googleapis.com/auth/drive.file`; **Publish app → "In production"** (avoids 7-day token expiry).
4. **Credentials → Create OAuth client ID → "TVs and Limited Input devices"**.
5. Put the ID and secret into `.env.local` at the repo root (see §3.2).

---

## 5. MILESTONES
**Every milestone must end with:**
- lint, test, and build green (from M1 on)
- `docs/progress.md` updated (status, decisions made, deviations, next step)
- `CLAUDE.md` kept current
- a commit (only with user approval)
- a prompt to the user to clear context before starting the next milestone

### M0 — Feasibility spike (architecture gate)
1. Create the disposable test graph `~/logseq-test-graphs/gdsync-dev`: several pages, 3+ journals, binary assets (png, pdf), `logseq/config.edn`, `logseq/custom.css`. Create a second empty folder `~/logseq-test-graphs/gdsync-dev-2` for device-2 simulation later.
2. Build a throwaway plugin in `spikes/bridge/` (plain HTML/TS; no scaffold needed). Load it two ways: unpacked without `effect`, and with `effect: true`. Record for each:
   - Is `window.top.apis.doAction` reachable?
   - Do `readFile`, `writeFile` (text + ArrayBuffer), `readdir`, `stat`, `rename`, `mkdir-recur`, `unlink` work on the graph dir **and** on `~/.logseq`? How is `~/.logseq` located (host API or doAction)?
   - Does `fetch('file://…')` work for binary data?
   - Is `crypto.subtle.digest('SHA-256')` available?
   - Does `SettingSchemaDesc` `type: 'button'` exist on 0.10.15?
3. Logseq watcher behavior: after an external write via the bridge, does the page re-index when the page is **closed**? When it is **open in the editor** (dialog? silent overwrite? lost edits)?
4. Google (requires §4): device-code request plus token polling via (a) iframe `fetch` with a form body and (b) `logseq.Request` with a JSON body. Then Drive `files.list`, multipart upload, resumable upload, binary download, and `appProperties` round-trip. Record CORS results.
5. Zip test: fflate streaming zip of the test graph inside the plugin iframe; record time and memory.
6. Write `docs/spike-results.md` with a go/no-go per item and the chosen transport per Google endpoint. Delete `spikes/`.
- **Gate:** file bridge works → continue with B. Bridge fails → do **M5-C** in place of M5.
- **DoD:** every item has recorded evidence; the architecture is confirmed in `docs/progress.md`.

### M1 — Scaffold
1. Match the Gemini plugin setup: Vite 8, React 19, TS ~6 project refs, oxlint config, npm scripts (`dev`, `build` = `tsc -b && vite build`, `lint`), `base: './'`, `index.html`.
2. `package.json` manifest: top-level `main: dist/index.html`; `effect: true`; `logseq: { id, title, description, author, icon }`. Pin `@logseq/libs` to `0.0.17`.
3. Add Vitest (`test` and a single-test script), `.gitignore` (incl. `*.local`), `.env.local` typing.
4. Adapt `publish.yml`: tag `v*` → build → zip `dist`, `package.json`, `README.md`, `icon.svg`, `LICENSE`.
5. Hello-world toolbar icon loads in Logseq. Update `CLAUDE.md` with real commands.
- **DoD:** plugin loads; lint, test, and build green.

### M2 — UI shell (mock data)
1. Settings schema: root folder name, device name, snapshot interval (24 h) and retention (10/3), profile backup toggles (settings JSONs on + warning), sync-on-startup (off), advanced client ID/secret override.
2. Toolbar Sync button with states (idle / syncing / conflict / error / signed-out).
3. Command palette: "Sync now", "Backup now", "Open sync panel".
4. Status panel (Esc and click-outside close) showing last sync, remote status, and actions.
5. Conflict dialog component and sticky progress toasts.
- **DoD:** all UI states demoable with mock data.

### M3 — Google auth
1. Client credential resolution (env → settings override).
2. Device-code UI: show `user_code`, "Open" (`App.openExternalLink`), poll at `interval`, handle `slow_down` / `access_denied` / `expired_token`.
3. Token store (FileStorage), refresh on expiry/401, disconnect + revoke.
4. HTTP transport per M0 results. Backoff with jitter on 429, 5xx, and 403 rate-limit reasons. Unit tests with fake HTTP.
- **DoD:** connected state survives a Logseq restart; tests green.

### M4 — Drive layer
1. Root/graphs/snapshots/profile folder bootstrap and a path↔folder-ID cache.
2. Paged list, download (binary), upload (multipart ≤ 5 MB, resumable above; chunk sizes multiple of 256 KiB), update, trash, `appProperties`.
3. `changes.getStartPageToken` / `changes.list`.
4. Lock file acquire, release, and break-expired.
5. FakeDrive implementation and tests.
- **DoD:** tests green; manual smoke test against real Drive with the test graph.

### M5 — Local file layer (architecture B)
1. `GraphFs` interface (list/stat/read/write/rename/delete; ArrayBuffer-safe; roots: graph + profile).
2. `HostBridgeFs` implementation.
3. Scanner with ignore rules (§3.4) and an mtime/size hash cache. SHA-256 via SubtleCrypto (JS fallback if M0 says so).
4. Atomic write and move-to-`logseq/bak/gdsync/<ts>/`. FakeGraphFs and tests.
- **DoD:** tests green; manual smoke test on the test graph.

### M5-C — Local helper (ONLY if the M0 gate fails; replaces M5)
1. Node helper: localhost HTTP with a random bearer token and CORS for the plugin origin. File ops only; Google calls stay in the plugin.
2. systemd user unit and install docs.
3. `HelperFs` adapter implementing `GraphFs`. Tests.

### M6 — Sync engine core (pure TS)
1. State model and store (§3.5).
2. Three-way planner incl. deletes, add/add-identical, and both-deleted (§3.6 step 5).
3. Conflict model surfaced to the UI, with "apply to all".
4. Executor: concurrency limit, journal, idempotent resume after a simulated crash.
5. Randomized scenario tests with two simulated devices sharing a FakeDrive.
- **DoD:** convergence and no data loss across randomized runs and fault injection.

### M7 — Manual two-way sync end-to-end
1. Wire the full Sync flow (§3.6 steps 1–8) to UI and commands.
2. First-run modes: local → Drive (empty remote), Drive → local (empty graph), both non-empty (full conflict-aware merge).
3. Graph-switch handling (`onCurrentGraphChanged`); remote-status check on panel open; optional sync-on-startup.
4. Manual E2E: `gdsync-dev` and `gdsync-dev-2` as two devices; edit both; sync; resolve prompts.
- **DoD:** both folders reconcile; conflicts prompt per D7; hashes match.

### M8 — Snapshots, profile bundle, restore
1. Streaming graph zip with `snapshot.json`, resumable upload, retention, "Backup now", auto-snapshot during Sync (C2).
2. Profile bundle (§3.4), hash-gated upload, retention 3, secrets warning (C1).
3. Restore wizard (§3.7), mirror or snapshot, optional profile restore to a chosen root.
4. New-device test: restore into an empty graph folder and a scratch profile directory; compare hashes against the manifest.
- **DoD:** the restored graph is byte-identical per the manifest.

### M9 — Personal release
1. Large-graph test (~5k files, several hundred MB of assets): timing, memory, API call counts.
2. Error, offline, and expired-auth UX polish.
3. README (features, GCP setup, security notes: plaintext tokens, secrets inside profile snapshots, `effect: true` meaning), LICENSE, demo image.
4. Tag `v0.1.0` release zip. **Back up the real graph**, install, first real sync plus a restore drill.
- **DoD:** the real graph syncs and restores.

---

## 6. DEFERRED (out of scope for v1)
- Public marketplace release: Google branding/verification review, `effect` review, BYO-client docs, `manifest.json` with `supportsDB: false`.
- DB-graph (Logseq 2.0) support.
- Automatic, live, or background sync.

## 7. RISKS & MITIGATIONS
| Risk | Mitigation |
|---|---|
| A Logseq update breaks the unofficial bridge | All file I/O behind `GraphFs`; host version check at startup; M5-C fallback design |
| A download overwrites a page open in the editor | M0 measures the behavior; executor defers or prompts for the open page |
| No atomic lock on Drive | Lock file with expiry; manual single-user sync makes races unlikely; documented |
| Memory pressure with large assets | Streaming zip and chunked resumable uploads; M9 load test |
| 7-day refresh-token expiry | GCP consent screen must be "In production" (§4) |
| Secrets in plaintext / in profile snapshot | Warning UI (C1); README security section; own plugin tokens are never included in the bundle |
