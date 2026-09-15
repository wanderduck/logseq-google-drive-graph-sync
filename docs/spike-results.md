# M0 SPIKE RESULTS
- Run 2026-09-14/15 on this machine: Logseq **0.10.15** (`logseq-desktop-bin`), Electron **38.4.0**, Chrome **140.0.7339.240**, Arch Linux, Wayland.
- Spike plugin: `spikes/bridge/` (plain TS, `@logseq/libs` 0.0.17, esbuild, fflate). Deleted at the end of M0; the raw result files are summarised here.
- Variants run: `unpacked-noeffect` (72 checks) and `unpacked-effect` (59 checks + Google runs). Both load from `file://` and behaved identically. The dot-root (`lsp://`, marketplace-style) variant was deferred to the public-release milestone (D1).
- Evidence levels: **[live]** observed in the running host; **[source]** read from `logseq/logseq` @ tag `0.10.15`.

---

## 1. GATE DECISION
**GO for architecture B.** The Electron bridge (`window.top.apis.doAction`) is reachable from the plugin iframe and every file operation the sync needs works on the graph directory and on `~/.logseq`. M5 (HostBridgeFs) proceeds; M5-C (local helper) is not needed.

---

## 2. PER-ITEM RESULTS (plan §5 M0 steps 2–5)

| # | Item | Result | Evidence |
|---|---|---|---|
| 2a | `window.top.apis.doAction` reachable | **Yes**, in both variants. Plugin origin is `file://`; host is `file:///opt/logseq-desktop/resources/app/electron.html`. `window.top.logseq.api` (112 host functions) is reachable too. `logseq.Experiments.ensureHostScope()` returns the host window. | A2, A3 [live] |
| 2b | `readFile` | **Text only.** Host does `fs.readFileSync(p).toString()`; a 4004-byte PNG came back as a 3809-char string that re-encodes to 7352 bytes. Missing file → resolves `null`. | B4c, B4d [live]; `utils.cljs read-file` [source] |
| 2b | `writeFile` (text, ArrayBuffer, Uint8Array) | **Works, byte-exact** (196,731-byte random buffer round-tripped; Uint8Array view also accepted). Returns `{size, mtime, ctime}`. Signature `['writeFile', repo, path, content]`; `repo` is only used for the failure backup. | B6, B7, B7b [live] |
| 2b | `readdir` / `listdir` | `readdir` is **recursive**, skips symlinks and dot-prefixed names, returns absolute paths (14 files). `listdir [dir, flat]` lists everything incl. `.recycle`. Neither applies the `logseq/bak` ignore rules. | B2, B2b [live]; `common/graph.cljs` [source] |
| 2b | `stat` | Returns **only** `{size, mtime, ctime}`; no `isDirectory`. `mtime` is a host-realm `Date`: `instanceof Date` is **false** in the iframe, `Object.prototype.toString` says `[object Date]`, `getTime()` works. | B3, B3b [live] |
| 2b | `rename`, `mkdir-recur`, `copyFile` | All work on both roots. No `rmdir`/`rm -r` handler exists (empty dirs stay). | B5, B8, B9, C2, C2d [live] |
| 2b | `unlink` | Graph path → **moved to `<graph>/logseq/.recycle/<path with / → _>`** (not deleted). Path under `~/.logseq` → real `unlinkSync`. | B10, B11, C2e [live]; `handler.cljs :unlink` [source] |
| 2b | Error surface | A failing handler **resolves with the `Error` object** instead of rejecting (`ENOENT: no such file or directory, stat '…'`). Unknown action resolves `null`. `Error` is cross-realm: detect with `Object.prototype.toString.call(v) === '[object Error]'`. | B3d [live]; `handler.cljs set-ipc-handler!` [source] |
| 2b | `~/.logseq` location | `doAction(['getLogseqDotDirRoot'])` → `/home/wanderduck/.logseq`. All ops work there (read `preferences.json`, list `settings/` 102 files, `plugins/` 522 files, write/rename/delete under `storages/gdsync-spike/`). | B1, C1–C5 [live] |
| 2c | `fetch('file://…')` binary | **Yes, exact bytes**: PNG 4 KB, PNG 3 MB (13–67 ms), PDF; SHA-256 matches. Works outside the graph too (`~/.logseq/preferences.json`). Non-ASCII names work with `encodeURI`. Missing file or directory → `TypeError: Failed to fetch`. | D1–D2d, C1d [live] |
| 2c | `assets://` URLs (`Assets.makeUrl`) | `makeUrl` returns `assets:///abs/path` but **`fetch` of it fails**. Not usable for byte reads. | D3 [live] |
| 2d | `crypto.subtle.digest('SHA-256')` | **Yes**. 3 MB hashed in 27 ms. | A4, D1b [live] |
| 2e | `SettingSchemaDesc type: 'button'` | **No.** The item is not rendered at all in the settings panel. The 0.10.15 TS type and renderer only know `string number boolean enum object heading`. | F1 [live, user-confirmed]; `plugins_settings.cljs`, `LSPlugin.ts` [source] |
| 3 | Watcher, page **closed** (G1) | External append is indexed within 4 s (new block in DB). No dialog, no notification, **no write-back** (disk stays byte-identical to our write). No `logseq/bak` file. | G1 [live] |
| 3 | Watcher, page **open, not editing** (G2) | Indexed and **re-rendered** within 4 s; DOM shows the new block. No dialog, no write-back. | G2 [live] |
| 3 | Watcher, page open, **editing the very block that changed**, with unsaved typed text (G3) | Editor is **closed by the re-index**; the unsaved typed text is **lost silently** (not in DB, not on disk). No dialog, no notification. Disk = our write. | G3 [live] |
| 3 | Watcher, page open, editing **another** block, no typing (G4) | Editor **stays open**; the appended block is indexed. After exiting edit mode nothing is written back. | G4 [live] |
| 3 | `logseq/bak/` on external change | Written **only when the DB copy contains text that the disk copy no longer has** (`backupDbFile` → `string-some-deleted?`). Pure appends/insertions never create a bak file. | G1–G4 `bakNew: []` [live]; `handler.cljs :backupDbFile` [source] |
| 3 | Watcher latency | chokidar `awaitWriteFinish: true` → events ≈2 s after the last write; 4 s was always enough. | `fs_watcher.cljs` [source]; G1–G4 [live] |
| 4a | OAuth device code + token poll via **iframe `fetch`, form-urlencoded** | **Works.** `POST /device/code` 200; polling `POST /token` 8 × 5 s until approval → `access_token`, **`refresh_token`**, scope `drive.file`, `expires_in` 3599. Pre-approval polls return HTTP 428 `authorization_pending`. CORS is not an obstacle (a `file://` iframe; Google answers the preflight). | H1, H.tokenPoll.fetch [live] |
| 4b | Same via **`logseq.Request`, JSON body** | **Works.** Google's OAuth endpoints accept `application/json` bodies. 5 polls → refresh token. | H2, H.tokenPoll.request [live] |
| 4 | Token revoke via `fetch` (form) | 200. | H14 [live] |
| 4 | Wrong client type | A "Desktop"/"Web" OAuth client gets `invalid_client: Only clients of type 'TVs and Limited Input devices' can use …`. The client **must** be the TV/limited-input type (plan §4 step 4). | H1 first attempt [live] |
| 4 | Drive API not enabled | Every Drive call returns 403 `SERVICE_DISABLED` (`accessNotConfigured`) until the API is enabled in the project (plan §4 step 2); the OAuth flow itself still succeeds, so the error only appears at the first Drive call. Propagation took < 2 min. | H3/H4 first attempt [live] |
| 4 | Drive JSON GETs: `files.list`, `files.get?fields=…`, `about`, `changes.getStartPageToken`, `changes.list` | **Work via `fetch`** (Bearer header, 150–500 ms) **and via `logseq.Request`** (`returnType: 'json'`). | H3, H3b, H3c, H8, H10 [live] |
| 4 | Drive JSON writes: folder create (`POST files`), `PATCH files/{id}` (`appProperties`, `trashed`), `DELETE files/{id}` | **Work via `fetch` and via `Request`** (JSON bodies). `appProperties` PATCH merges keys (existing keys kept). `DELETE` on the folder returned 204 and removed its contents. | H4, H4b, H9, H9b, H11, H13 [live] |
| 4 | Multipart upload (`uploadType=multipart`, `multipart/related`, `Blob` body) | **Works via `fetch`**: 4 KB PNG in 1.6 s; response carries `id`, `size`, `md5Checksum`, and the `appProperties` `{sha256, relPath, deviceId}` we sent. **Fails via `Request`**: the body is JSON-quoted, Google answers a non-JSON "Invalid multipart request", and the host's `.json()` throws (`FetchError: invalid json response body`). | H5, H5b [live] |
| 4 | Resumable upload (`uploadType=resumable`, chunked `PUT`) | **Works via `fetch`**: the initiating POST returns 200 with the **`Location` header readable in the iframe** (Google exposes it); 1 MiB chunks with `Content-Range` → HTTP 308 with `Range: bytes=0-<end>` for intermediate chunks, final chunk → 200 with the file JSON. 3 MB in 2.56 s. | H6, H6b [live] |
| 4 | Binary download (`alt=media`) | **Works via `fetch`** → `arrayBuffer()` (4 KB in 369 ms; 3 MB in 696 ms; SHA-256 matches). **Also works via `Request`** with `returnType: 'arraybuffer'` (a real `ArrayBuffer`, hash matches) and `'base64'`. | H7, H7b, H7c, H7d [live] |
| 4 | `appProperties` round-trip and query | Set on upload, read back with `files.get`, and **`files.list q="appProperties has { key='sha256' and value='<hash>' } and trashed=false"` finds the file**. `'<folderId>' in parents` listing returns `md5Checksum`/`size`. | H8, H8b, H8c [live] |
| 4 | `changes` | `startPageToken` then `changes.list?pageToken=…` after a metadata PATCH returned both spike files (`fileId`, `file.name`, `file.parents`, `file.trashed`, `removed`) plus `newStartPageToken`. | H10, H10b [live] |
| 4 | CORS visibility | `Access-Control-Allow-Origin` is never readable from the iframe (not a safelisted response header), but every call succeeds, so CORS is satisfied for `oauth2.googleapis.com` and `www.googleapis.com` from a `file://` iframe. `Location` and `x-guploader-uploadid` are readable on upload responses. | all H rows [live] |
| 5 | fflate streaming zip inside the iframe | **Works.** 14 files / 3.17 MB → 3.17 MB zip in 61–91 ms (read 39–67 ms via `fetch(file://)`, deflate 19–22 ms, write 18–31 ms via `writeFile`). Contents **byte-identical** to the graph (SHA-256 of every extracted file). UTF-8 name flag (bit 11) is set; Info-ZIP `unzip` 6.0 mis-decodes such names but Python/fflate read them correctly. `performance.memory` showed no measurable heap growth at this size (≈228–257 MB used before and after). | I1 [live] + local verification |

### Other facts recorded on the way
- `logseq.Request` JSON round-trips work (Drive discovery doc via the host proxy, 290 ms). A string body is JSON-quoted on the wire: httpbin echoed form `{"\"a": "1", "b": "2\""}` for `a=1&b=2` → no form/multipart/binary *uploads* via `Request` (confirms Ref §6.7). Binary *downloads* via `Request` (`returnType: 'arraybuffer'` / `'base64'`) work. `Request` also cannot expose response headers or status codes (a non-2xx JSON body is returned as if it were success; a non-JSON error body makes the host throw). [D7, D8, H3b, H5b, H7b live]
- `logseq.Request` internally needs `window.top.logseq.api`, so it only works same-origin (file://). A marketplace `lsp://` install without `effect` would lose it. [source]
- `logseq.DB.datascriptQuery` `[:find (pull ?f [:file/path :file/content]) …]` returns **current** text for all 11 text files (pages, journals, `config.edn`, `custom.css`) with relative paths (`pages/Alpha.md`). H1 of the reference doc: confirmed. [D6 live]
- `logseq.Assets.listFilesOfCurrentGraph(['png','pdf'])` returns absolute paths with size and times. [D5 live]
- `logseq.FileStorage` lives at `~/.logseq/storages/<plugin-id>/<key>` (nested keys allowed). `setItem`/`getItem`/`hasItem`/`allKeys` are awaited round-trips; **`removeItem` and `clear` are fire-and-forget** in the SDK (`caller.call`), so `hasItem` immediately after `removeItem` still returns true; it was gone after 500 ms. [E1 live; `LSPlugin.Storage.ts` source]
- `App.getInfo('version')` → `"0.10.15"`. `App.getCurrentGraph()` → `{name, url: "logseq_local_<abs path>", path}`; the `url` is the host `repo` key. [A1 live]
- `performance.memory` is available in the plugin iframe. [A5 live]
- Loading a plugin with a **changed manifest** is picked up by the plugin dashboard's Reload; a full Logseq restart was not required for the `effect` flip.

---

## 3. CHOSEN TRANSPORT PER GOOGLE ENDPOINT
| Endpoint | Transport | Why |
|---|---|---|
| `oauth2.googleapis.com/device/code`, `/token` (device-code poll and refresh), `/revoke` | **iframe `fetch`, `application/x-www-form-urlencoded`** (the documented body type). `logseq.Request` with JSON is a proven fallback. | H1/H2/H14 |
| Drive JSON endpoints (`files.list/get/create/update/delete`, `changes.*`, `about`) | **`fetch`** with Bearer header: gives status codes and headers, which the backoff logic (429/403/5xx) needs. `Request` works for these too but hides status/headers, so it is kept only as a fallback. | H3, H4, H8–H11, H13 |
| Multipart upload (`uploadType=multipart`) | **`fetch`** (`multipart/related` `Blob`). `Request` is impossible (body JSON-quoted). | H5, H5b |
| Resumable upload (`uploadType=resumable`, chunked `PUT`) | **`fetch`**: `Location` is exposed, 308 + `Range` handling works. Chunk size multiple of 256 KiB (1 MiB used). | H6, H6b |
| Binary download (`alt=media`) | **`fetch`** → `arrayBuffer()`. `Request` `returnType: 'arraybuffer'` is a working fallback. | H7, H7b, H7d |

**Decision:** one HTTP transport, iframe `fetch`, for everything; `logseq.Request` is not used by the product code (it needs `window.top` anyway, so it buys nothing over `fetch` here). M3's "transport per M0 results" item collapses to a single `fetch`-based client with backoff.

---

## 4. CONSEQUENCES FOR THE DESIGN (inputs to M3–M7)
1. **`HostBridgeFs` (M5):** treat an `[object Error]` result as a rejection; convert `stat.mtime` with `getTime()`; read text with `readFile` (or `fetch`) and bytes with `fetch('file://' + encodeURI(path))`; write with `writeFile` (ArrayBuffer ok); atomic writes = `writeFile` to `<path>.gdsync-tmp` + `rename`; there is no directory delete, so "move to `logseq/bak/gdsync/<ts>/`" must be a `rename` (never `unlink`, which would land in `.recycle`); directory detection = `readdir`/`listdir` (stat cannot tell). `listdir` shows dot-dirs; the scanner applies plan §3.4 ignore rules itself.
2. **Sync must not race the editor (M7):** before the local scan, call `logseq.Editor.exitEditingMode()` so the open block is saved, then wait ≥1 s for the file flush and rescan. A download that overwrites the page being edited closes the editor and discards unsaved keystrokes with **no prompt**, so the executor must never write to the currently edited file without doing that first. (Answers plan §3.6 step 7 "exact behavior set by the M0 finding": **defer + force-save**, no host prompt exists.)
3. **Logseq's `bak/` is not a safety net for our writes** (only deletions trigger it). Recommendation for M6/M7 sign-off: copy the previous local content to `logseq/bak/gdsync/<ts>/` before any download-overwrite, not only before deletes.
4. **Token/state store (M3):** `FileStorage.setItem` is safe to await; never rely on `removeItem`/`clear` having completed. Store JSON strings only.
5. **Manifest:** keep `effect: true`. Unpacked dev builds are same-origin either way, but a dot-root/marketplace install without `effect` gets `lsp://` and loses both the bridge and `logseq.Request`.
6. **Settings UI:** no `button` type; actions live in the plugin panel/command palette (M2 already assumes this).
7. **Snapshots (M8):** fflate `Zip` + `ZipPassThrough` for already-compressed assets and `ZipDeflate` for text is fast enough; the 5k-file/hundreds-of-MB check stays in M9.
8. **Drive layer (M4):** `appProperties` (`sha256`, `relPath`, `deviceId`) survive upload/patch/list and are queryable with `appProperties has {…}`; Drive's `md5Checksum` comes back on every list/get and can serve as a cheap remote-change check in addition to `sha256`. `changes.list` filtered by parent works as planned. Trash = `PATCH {trashed:true}`; folder `DELETE` cascades.
9. **GCP setup (README, M9):** the OAuth client must be of type "TVs and Limited Input devices" and the Drive API must be enabled in the same project; both mistakes surface only at runtime with clear error bodies (`invalid_client`, `SERVICE_DISABLED`).
