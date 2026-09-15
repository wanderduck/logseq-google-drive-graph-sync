# LOGSEQ PLUGIN CREATION REFERENCE
- Synthesized 2026-09-14 from the sources in `docs/logseq-plugins_links.md`, the `logseq/logseq` source tree, the npm registry, and the `logseq/marketplace` repo.
- Evidence levels used below:
  - **[verified]** — read directly from source code, registry data, or official docs.
  - **[inference]** — reasoned from verified facts but not stated anywhere; confirm before relying on it.
  - **[untested]** — plausible and partly evidenced, but needs to be tried in a running Logseq.

---

## 1. SOURCE RELIABILITY (read this first)
| Source | Status (2026-09-14) | Use it for |
|---|---|---|
| `docs.logseq.com/#/page/plugins*` (4 pages) | SPA; content comes from GitHub `logseq/docs` `pages/Plugins*.md`. Last edited 2023–2024. | Concepts, the hello-world walkthrough, the dev-mode loading steps. Its API usage is old. |
| `plugins-doc.logseq.com` | **Effectively empty.** A landing page that links to `logseq.github.io/plugins`; every per-namespace route returns 404 or "No documentation data found". | Nothing beyond the link. |
| `logseq.github.io/plugins` | TypeDoc site built from the `logseq/plugins` repo, last pushed 2026-01-06 (about `@logseq/libs` 0.2.11/0.2.12). | API reference. It is **ahead of** the file-based app (0.10.x) and **behind** `libs@next` (0.3.4). |
| `logseq/logseq` `libs/src/*.ts` (at a release tag) | Ground truth for the client SDK. | Exact signatures. **Always read it at the tag of the app version you target** (e.g. `0.10.15`), not `master`. |
| `logseq/logseq` `src/electron/electron/handler.cljs`, `src/main/logseq/api.cljs` | Ground truth for what the host actually does. | Behavior behind the proxies (requests, storage, file system). |
| `pengx17/logseq-plugin-template-react` | Maintained deps, but the toolchain is dated (Vite 4, TS 4.9, React 18, Node 16 CI). | `vite-plugin-logseq` dev loop, release-zip workflow. |
| `logseq/logseq-plugin-samples` | 13 samples using `@logseq/libs` versions from alpha.20 to 0.2.11. | Usage patterns, not version pins. |

---

## 2. VERSION LANDSCAPE
### 2.1 Two Logseq product lines [verified]
| Line | Latest | Graph storage | Plugin SDK the host ships |
|---|---|---|---|
| File-based | **0.10.15** (2025-12-01). No release since; the line looks frozen. | Markdown/Org files on disk (`pages/`, `journals/`, `assets/`, `logseq/config.edn`) | `@logseq/libs` **0.0.17** (from `libs/package.json` at tag `0.10.15`) |
| DB-based ("Logseq 2.0") | **2.0.1 Beta** (2026-07-13). Not GA. | Database (not plain files) | 0.2.x/0.3.x train |
- This machine runs `logseq-desktop-bin 0.10.15-1` (file-based line) [verified via `pacman -Qs logseq`].
- Official position (discuss.logseq.com, April 2024): both graph types will continue to be supported. No official statement exists on plugin-API compatibility between them [verified absence in the sources retrieved].

### 2.2 `@logseq/libs` on npm [verified]
- dist-tags: `latest` = **0.0.17** (stale, 2023-12-30); `next` = **0.3.4** (2026-06-24). `alpha` and `beta` tags are also stale.
- Recent publishes: 0.2.12 (2026-01-19), 0.3.1 and 0.3.2 (2026-04-18), 0.3.3 (2026-04-28), 0.3.4 (2026-06-24).
- `npm install @logseq/libs` gives you 0.0.17. Newer versions require an explicit version or `@next`.

### 2.3 What the SDK version actually means [verified + inference]
- The SDK is a **thin client**. Most namespaces (`App`, `Editor`, `DB`, `UI`, `Git`, `Assets`) are JS `Proxy` objects. They marshal *any* method name to the host via `caller.callAsync('api:call', …)` [verified, `LSPlugin.user.ts`].
- A method works only if the **host app** implements it. Newer SDK typings on an older app compile fine but fail at runtime for newer methods (e.g. `App.checkCurrentIsDbGraph`, `logseq.Net`, tag/property APIs) [inference].
- Real classes in the SDK (`LSPluginRequest`, `LSPluginFileStorage`, `LSPluginExperiments`, and `LSPluginNet` in 0.3.x) are client code whose host counterpart must also exist [verified].
- **Rule: pin the SDK to the version the target app ships (0.0.17 for 0.10.15), or verify every call against that tag's host code.**
- Marketplace guidance ("keep @logseq/libs as up-to-date as possible") targets the current app line [verified quote], so it conflicts with this rule on the frozen file-based line.

---

## 3. RUNTIME MODEL
### 3.1 Where plugin code runs [verified]
- Plugins are **desktop-only** on the file-based line ("not available for mobile or the browser"). The DB changelog mentions "Support Plugins for Web" (2025-01-06), and the marketplace manifest has a `web` flag.
- There are two modes (`logseq.mode` in `package.json`):
  - `iframe` (default) — `postmate` creates a real `<iframe>`. **No `sandbox` attribute is set.** An optional `allow` (Permissions Policy) is configurable. Plugin ↔ host communication is `postMessage` RPC.
  - `shadow` — the plugin UI mounts in a Shadow DOM inside the host document.
- **Entry origin**: `_resolveResourceFullUrl` converts to the `lsp://` protocol when `!effect && isInstalledInDotRoot`. Otherwise it uses `file://` (`LSPlugin.core.ts` @0.10.15). So:
  - Marketplace-installed, non-`effect` plugins → `lsp://` origin (separate from the host).
  - `effect: true` plugins and unpacked dev plugins → `file://` origin.
- `effect: true` (marketplace manifest): "the plugin's sandbox runs same-origin as host". It is **discouraged and gets stricter review**, but it is allowed.

### 3.2 No Node/Electron access through the documented API [verified]
- Every documented capability routes through the host: storage, HTTP, git.
- The Electron main process exposes a full file-system IPC surface, `window.apis.doAction([...])`, to the **host renderer** (`resources/js/preload.js`). Handlers include `:readFile`, `:writeFile` (accepts `ArrayBuffer`), `:readdir`, `:stat`, `:unlink`, `:mkdir-recur`, `:rename`, `:copyFile` (`handler.cljs` @0.10.15).
- A plugin can reach it only by accessing the host window (`window.top` / `parent`). That requires same-origin, i.e. `effect: true` or an unpacked `file://` plugin [inference from 3.1; **untested**].
- `logseq.Experiments.ensureHostScope()` returns `window.top`. It is explicitly unstable: "might be adjusted at any time … may not be supported on the Marketplace" [verified].

### 3.3 Lifecycle [verified]
- `logseq.ready([model], [callback])` — the only start hook. It connects the RPC, merges `baseInfo` and settings, then runs the callback. Calling it twice is a no-op. Nothing `logseq.*` works before it resolves.
- `logseq.beforeunload(async () => {…})` — a single teardown hook. The host **awaits** its promise (plugin disable, reload, or app quit). No timeout constant was found.
- There is no background/service-worker concept. Timers (`setInterval`/`setTimeout`) run only while Logseq is open and the plugin is enabled.
- The connect handshake timeout is `HANDSHAKE_TIMEOUT = 8000` ms.

---

## 4. PROJECT SETUP
### 4.1 `package.json` manifest [verified]
- The host reads these top-level fields: `name`, `version`, `description`, `author`, `repository`/`repo`, `title`, `effect`, `sponsors`, `main`.
- It also reads a nested `logseq` object (`LSPluginPkgConfig`):
```jsonc
{
  "name": "logseq-google-drive-graph-sync",
  "version": "0.1.0",
  "main": "dist/index.html",          // built HTML entry (top-level `main` and `logseq.main`/`entry` are both accepted)
  "logseq": {
    "id": "logseq-google-drive-graph-sync", // must be globally unique; auto-generated + written back in dev mode if absent
    "title": "Google Drive Graph Sync",
    "icon": "./icon.svg",
    "mode": "iframe",                   // or "shadow"
    "devEntry": "http://localhost:5173" // optional: dev-server entry used during development
  }
}
```
- The official samples place `main`/`icon` inconsistently (top level vs. inside `logseq`); both are accepted by the loader.
- The docs' minimal valid manifest is just `name`, `main`, and `logseq: {}`.

### 4.2 Toolchain options [verified]
| Option | Notes |
|---|---|
| **Vite + `vite-plugin-logseq`** (template) | Forces `base: ''` and CORS on the dev server. Rewrites `dist/index.html` to point at the live dev server, which gives HMR *inside Logseq*, and forces a full iframe reload when an update falls outside the HMR boundary. |
| Vite + `logseq.devEntry` (imdb sample) | Same goal, native manifest field, no extra plugin. |
| Parcel 2 (several samples, `../logseq-chessticles`) | Works. Parcel 1 (`parcel-bundler`) is legacy. |
| No bundler, CDN `<script src=".../lsplugin.user.min.js">` | Docs call it a simplification only. Not reproducible (unpinned). |
- TypeScript: `import '@logseq/libs'` registers the global `logseq`. The template imports `package.json` to read `logseq.id`.

### 4.3 Dev loop [verified]
1. Logseq → Settings → enable **Developer mode**.
2. `t p` (or the ⋯ menu → Plugins) → **Load unpacked plugin** → select the **project root** (the folder containing `package.json`), not `dist/`.
3. For build-and-load, run `npm run build` first. For live reload, run the dev server (`vite-plugin-logseq` or `devEntry`) and load once.
4. Use the plugin's **Reload** button in the plugin dashboard after manifest changes [inference].
5. Debug with the Electron DevTools (the host's DevTools include the plugin iframe) [inference].
- Plugin update checks for marketplace plugins run every 12 h [verified].

---

## 5. CORE API (`logseq` global)
### 5.1 Settings [verified]
```ts
logseq.useSettingsSchema(schema: SettingSchemaDesc[])   // call before or after ready(); drives the built-in settings panel (gear icon)
type SettingSchemaDesc = {
  key: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'heading' | 'button'
  default: string | number | boolean | any[] | object | null
  title: string
  description: string                                   // markdown supported
  inputAs?: 'color' | 'date' | 'datetime-local' | 'range' | 'textarea'
  enumChoices?: string[]; enumPicker?: 'select' | 'radio' | 'checkbox'
  buttonText?: string; buttonAction?: string            // 'button' type → provideModel method name (seen on master; verify on 0.10.15)
}
logseq.settings                                          // current values (+ `disabled`)
logseq.updateSettings(patch)                             // async round-trip — does NOT update logseq.settings synchronously (source TODO)
logseq.onSettingsChanged((next, prev) => {})             // == logseq.on('settings:changed', …) — read fresh values here
logseq.showSettingsUI() / hideSettingsUI()
```
- **Persistence:** plaintext JSON at `~/.logseq/settings/<plugin-id>.json`. It is per user (**not per graph**), unencrypted, and has no secret-field concept [verified, `plugin.cljs`; the directory exists on this machine].
- **Gotcha:** never keep long-lived secrets there without telling the user. `FileStorage` (6.6) is also plaintext on disk.

### 5.2 UI [verified]
```ts
logseq.provideModel({ methodName(e) {} })                 // handlers for data-on-click="methodName" in templates (e.dataset, e.rect with data-rect)
logseq.App.registerUIItem('toolbar' | 'pagebar', { key, template })
logseq.provideUI({ key, slot?, path?, template, reset?, close?: 'outside', style?, attrs? })
logseq.provideStyle(css | { key, style })                  // inject CSS into host; target injected items via div[data-injected-ui=<key>-<pluginId>]
logseq.showMainUI({ autoFocus? }) / hideMainUI({ restoreEditingCursor? }) / toggleMainUI(); logseq.isMainUIVisible
logseq.setMainUIInlineStyle({ position, zIndex, top, left, … }) / setMainUIAttrs({ draggable, resizable })
logseq.on('ui:visible:changed', ({ visible }) => {})
logseq.UI.showMsg(content, 'info'|'success'|'warning'|'error', { key?, timeout? })  // timeout: 0 = sticky; returns key; hiccup strings allowed
logseq.UI.closeMsg(key)                                    // (older samples use logseq.App.showMsg)
// Verified @0.10.15 (`logseq/sdk/ui.cljs -show_msg`, `handler/notification.cljs show!`): `clear? = (timeout ≠ 0)`;
// a call with an existing `key` replaces that toast's content in place (map assoc by uid); every call with a
// non-zero timeout schedules its own auto-clear, so update sticky toasts and close them explicitly.
// `UI.*` calls are dispatched as `ui_<method>` → `logseq.sdk.ui/<snake_case>` (e.g. `close_msg`).
logseq.Editor.registerSlashCommand(label, handler)
logseq.Editor.registerBlockContextMenuItem(label, ({ blockId }) => {})
logseq.App.registerCommandPalette({ key, label, keybinding? }, handler) / registerCommandShortcut(...)
```
- **Updating an item in place:** re-call `provideUI` with the same `key` + `reset: true`. A `registerUIItem` toolbar/pagebar item **can also be re-registered with the same `key`**: `frontend/handler/plugin.cljs register-plugin-ui-item` @0.10.15 filters out the existing entry with that key before adding the new one, and `components/plugins.cljs ui-item-renderer` re-runs `setupInjectedUI` when `template` changes. (Corrected 2026-09-15; the earlier "don't re-register" note was unverified.)
- **Toolbar item DOM (verified `components/plugins.cljs` @0.10.15):** each item is wrapped in `div#injected-ui-item-<key>-<pid>.injected-ui-item-toolbar`, which is the `slot` handed to `setupInjectedUI`. Items are listed inline only while the user has **no** pinned-items set (`:plugin/preferences :pinnedToolbarItems`); once any item is pinned, unpinned items move into the toolbar "plugins" dropdown, rendered again with `prefix "pl-"` and key `pl-<key>`. Scope injected CSS by your own class names, not by these ids/attributes.
- **`provideStyle({ key, style })` does not replace:** `register-plugin-resources` only stores a keyed resource when that key is absent (`#{:error nil}`), so a keyed style is write-once per plugin load. Put state into the DOM (`data-*` attributes) and keep the CSS static.
- **The main UI is a full-window overlay.** The plugin must implement click-outside **and** Escape-to-close itself; the template does click-outside only.
- **React bridge (template):** `useSyncExternalStore(subscribe('ui:visible:changed'), () => visible)`.
- **Emit order (verified in `lsplugin.user.js` 0.0.17):** `showMainUI`/`hideMainUI` do `caller.call('main-ui:visible', p)`, then `emit('ui:visible:changed', p)`, and only **then** `_ui.set(...)`, which is what `isMainUIVisible` reads. So a `getSnapshot` that reads `logseq.isMainUIVisible` sees the stale value at notification time and React does not re-render. Take `visible` from the event payload `{ key, visible, autoFocus }` (`src/ui/useMainUiVisible.ts`).

### 5.3 Events [verified]
- `LSPluginUserEvents`: only `'ui:visible:changed' | 'settings:changed'`.
- App hooks (`.subscribe`-style `onX(cb)` returning an off-function):
  - `onCurrentGraphChanged` (no payload — re-query `getCurrentGraph()`)
  - `onGraphAfterIndexed({ repo })` — safe-to-start signal
  - `onRouteChanged`, `onThemeModeChanged`, `onThemeChanged`, `onTodayJournalCreated`, `onSidebarVisibleChanged`
  - `onBeforeCommandInvoked`, `onAfterCommandInvoked`
  - `onMacroRendererSlotted`, `onPageHeadActionsSlotted`, `onBlockRendererSlotted`
- DB hooks: see 6.2.
- Editor: `onInputSelectionEnd`.

---

## 6. DATA, FILE, AND NETWORK API (as of host 0.10.15 / SDK 0.0.17)
### 6.1 Editor (pages/blocks) [verified]
- **Pages:**
  - `getAllPages(repo?)`, `getPage(name|id, { includeChildren? })`
  - `createPage(name, props?, { redirect?, createFirstBlock?, format?, journal? })`
  - `deletePage`, `renamePage`, `getPagesFromNamespace`, `getPagesTreeFromNamespace`
- **Trees:** `getCurrentPageBlocksTree()`, `getPageBlocksTree(page)`, `getPageLinkedReferences(page)`.
- **Blocks:**
  - `insertBlock(src, content, { before?, sibling?, isPageBlock?, customUUID?, properties? })`
  - `insertBatchBlock(src, batch, { before?, sibling?, keepUUID? })`
  - `updateBlock(src, content, { properties? })`, `removeBlock`, `getBlock`, `moveBlock`
  - `prependBlockInPage`, `appendBlockInPage`, `newBlockUUID()`
- **Properties:** `upsertBlockProperty`, `removeBlockProperty`, `getBlockProperty`, `getBlockProperties`.
- `PageEntity`/`BlockEntity` carry `file?: { id }`. No Editor method resolves it to a path or content.
- DB-graph-only APIs (`upsertProperty`, `createTag`, `addTagProperty`, `addBlockTag`) are **not** for file graphs.
- Pitfall (reddit sample): `createPage(…, { redirect: true })` followed by a fixed `delay(500)` before editing is racy.

### 6.2 DB (Datascript) [verified]
```ts
logseq.DB.q(dsl: string)                                  // simple-query DSL
logseq.DB.datascriptQuery(query: string, ...inputs)       // raw Datalog
logseq.DB.onChanged(({ blocks, txData, txMeta }) => {})   // every transaction; txData = [e, a, v, t, added]; txMeta.outlinerOp e.g. 'save-block' | 'insert-blocks' | 'delete-blocks' | 'move-blocks'
logseq.DB.onBlockChanged(uuid, (block, txData, txMeta) => {})
```
- **Error convention** (query-playground sample): a failed `datascriptQuery` may *resolve* with an object containing the key `"#lspmsg#error#"` instead of rejecting. Check for it explicitly. Seen in an old SDK; re-verify.
- **File-graph schema includes `:file/path` (unique) and `:file/content`** [verified, `deps/db/src/logseq/db/schema.cljs` @0.10.15]. Datalog such as `[:find (pull ?f [:file/path :file/content]) :where [?f :file/path]]` should return raw file text for indexed pages and journals, **without any file-system access** [**untested** — check that content is populated and current after edits].
- **Journals in a month** (journals-calendar sample):
  `[:find (pull ?p [*]) :where [?b :block/page ?p] [?p :block/journal? true] [?p :block/journal-day ?d] [(>= ?d 20260901)] [(<= ?d 20260931)]]`
- `onChanged` is **transaction-level (in memory)**, not file-level. How long until the `.md` file is written to disk is undocumented.

### 6.3 App [verified]
- `getCurrentGraph()` → `{ name, url, path }`, where `path` is the graph's absolute directory.
- `getCurrentGraphConfigs(...keys)` / `setCurrentGraphConfigs(obj)` — structured `config.edn` access.
- `getUserConfigs()` → preferred format, date format, theme, `currentGraph`, …
- `openExternalLink(url)` opens the OS browser. `getInfo('version')`. `relaunch()`, `quit()`. `invokeExternalCommand(cmd, …)`. `pushState('page', { name })`.
- `execGitCommand` is **deprecated** → use `logseq.Git.execCommand`.

### 6.4 Git [verified]
- `logseq.Git.execCommand(args: string[]) → { stdout, stderr, exitCode }` runs bundled git (dugite) in the graph directory. Also `loadIgnoreFile()` / `saveIgnoreFile(content)`.
- Useful only if the graph is a git repo. It returns stdout, not arbitrary file bytes.

### 6.5 Assets [verified]
- `listFilesOfCurrentGraph(exts?)` → `[{ path, size, accessTime, modifiedTime, changeTime, birthTime }]`. **Metadata only.**
- `makeUrl(path)` → an `assets://` URL for an existing graph asset. Fetching its bytes from the plugin is **untested**.
- `builtInOpen(path)`.
- `makeSandboxStorage()` → an `IAsyncStorage` in the plugin's own assets storage area (not the graph's `assets/`).

### 6.6 FileStorage [verified]
- `logseq.FileStorage`: `setItem(key, string)`, `getItem`, `removeItem`, `hasItem`, `allKeys`, `clear`.
- Backed by files in a host-managed per-plugin directory. The key may contain nested paths. No path traversal into the graph. No client-side size limit.
- **Values are strings only.** Store state as JSON.

### 6.7 Network [verified]
- `logseq.Request._request({ url, method, headers, data, returnType: 'json'|'text'|'base64'|'arraybuffer', abortable, timeout })`:
  - **Host-proxied.** The SDK calls `Experiments.invokeExperMethod('request')`, and the Electron main process runs `utils/fetch`. It is **not subject to browser CORS**.
- **Critical limitation @0.10.15:** the host always sends `body = JSON.stringify(data)` for non-GET/HEAD requests (source comment: `TODO: support type of arrayBuffer`). As a result:
  - **No binary uploads.**
  - **No form-urlencoded or multipart bodies.** A string body gets JSON-quoted.
  - Content-Type must be set manually via `headers`.
  - Responses in any `returnType` work.
- `logseq.Net` (get/post/…, retry, `AbortSignal`, documented CORS proxying) exists only in SDK 0.3.x and **does not exist on 0.10.15**.
- **Plain `fetch()` from the plugin iframe** works like browser fetch and is subject to CORS. The reddit sample abandoned its live endpoint for a static fixture, which suggests CORS trouble with that API.
- APIs that send CORS headers (most Google APIs do) should work [**untested** here].

### 6.8 Capability matrix (file-based graph, host 0.10.15)
| Need | Documented API | Undocumented / `effect` route |
|---|---|---|
| Read page/journal content | ✅ Editor / DB | — |
| Read raw `.md` text | ⚠️ `:file/content` via `datascriptQuery` (untested) | `fetch('file://…')` or `apis.doAction(['readFile', p])` (untested) |
| Read binary assets | ⚠️ metadata only; `makeUrl` + fetch (untested) | `fetch('file://…')` (Super Sync does this) |
| Write raw graph files | ❌ | `window.top.apis.doAction(['writeFile', repo, path, content])` (untested; needs same-origin) |
| Detect in-app edits | ✅ `DB.onChanged` | — |
| Detect external file changes | ❌ (host watcher re-indexes silently) | `readdir` + `stat` polling via the bridge |
| Plugin state storage | ✅ FileStorage / settings | — |
| CORS-free JSON HTTP | ✅ `logseq.Request` | — |
| Binary / multipart upload | ❌ via Request | iframe `fetch` if the server supports CORS |
| Graph switch | ✅ `onCurrentGraphChanged`, `onGraphAfterIndexed` | — |

---

## 7. PATTERNS FROM THE TEMPLATE AND SAMPLES [verified]
- **Bootstrap:** `logseq.ready(main).catch(console.error)`. Gate all work behind it.
- **Toolbar entry point:**
  ```ts
  logseq.provideModel({ open() { logseq.showMainUI() } })
  logseq.App.registerUIItem('toolbar', { key: 'my-open', template: `<a data-on-click="open" data-rect>…</a>` })
  ```
  With `data-rect`, the click `rect` is passed to position a popover via `setMainUIInlineStyle`.
- **Long bulk jobs** (imdb importer):
  1. `const key = await logseq.UI.showMsg('Working…', 'info', { timeout: 0 })`
  2. Loop with `await sleep(100)` throttling; update the message using the same key.
  3. `logseq.UI.closeMsg(key)`.
- **Bulk writes:** `insertBatchBlock` rather than many `insertBlock` calls.
- **Debounce reactive work:** query-playground debounces re-queries by 300 ms.
- **Timers:** the pomodoro sample re-renders every 1 s through `provideUI`, and its README warns this causes host ↔ sandbox messaging overhead. Keep polling coarse. Stop timers on `beforeunload` and when their UI is gone (`App.queryElementById`).
- **Lazy main UI:** build the heavy UI on `ui:visible:changed → visible` and tear it down on hide (mind-map sample).

---

## 8. PUBLISHING TO THE MARKETPLACE [verified, `logseq/marketplace` README]
1. Plugin repo requirements:
   - A GitHub Actions `publish.yml` that builds on tag.
   - A GitHub Release with an **attached zip asset** (not just the auto source zip).
   - A README explaining usage with **at least one image or gif**.
2. Template zip contents: `dist/`, `readme.md`, icon, `LICENSE`, `package.json`. The template builds and publishes this zip via semantic-release (`npmPublish: false`, conventional commits).
3. Fork `logseq/marketplace` → add `packages/<plugin-name>/manifest.json` (+ icon) → open a PR.
4. `manifest.json`:
   - Required: `title`, `description`, `author`, `repo` (`user/repo`).
   - Optional: `icon`, `theme`, `sponsors`, `web` (default false), `effect` (default false; stricter review), **`supportsDB`**, **`supportsDBOnly`** (both default false).
5. Prior art: existing graph-sync plugins **`logseq-super-sync`** and **`logseq-github-auto-sync`** are both listed with `effect: true`, so `effect` plugins are accepted.

---

## 9. PRIOR ART: SYNC/BACKUP PLUGINS [verified by reading their source]
| Plugin | Approach | Lesson |
|---|---|---|
| `top/logseq-super-sync` (S3/WebDAV/local) | `effect: true`. **Rebuilds markdown from block trees** (`getPageBlocksTree`). Reads assets with `fetch('file://' + path)`. Debounced backup after editing stops. | Block-tree reconstruction is lossy (formatting, properties, whitespace). `file://` fetch is a working read path under `effect`. |
| `kadaliao/logseq-github-auto-sync` | `effect: true` plugin **plus a local Node helper server** (`scripts/sync-server.js`) the user must run. The helper does the real file/git work. | Robust two-way file sync pushed out of the plugin. The cost is an extra install/run step. |

---

## 10. GOTCHAS (consolidated)
1. `npm i @logseq/libs` → 0.0.17. The TypeDoc site documents newer APIs your host (0.10.15) may lack.
2. `logseq.updateSettings()` is not reflected in `logseq.settings` until `settings:changed` fires.
3. Settings and FileStorage are **plaintext on disk**.
4. `logseq.Request` JSON-stringifies bodies on 0.10.15.
5. `datascriptQuery` errors may come back as `"#lspmsg#error#"` instead of a rejection.
6. No documented raw-file write. Writing files requires the unofficial host bridge (`effect: true`).
7. `DB.onChanged` fires on DB transactions, not on disk flushes, and not for files changed outside Logseq.
8. Plugins run only while the desktop app is open. There is no mobile plugin support on the file line.
9. Main-UI overlays need hand-rolled Escape and click-outside handling.
10. Manifest `main`/`icon` placement is inconsistent across samples. Keep `main` top-level plus `logseq.id`/`title`/`icon`.
11. `logseq.Experiments.*` is unstable and marketplace-hostile. Isolate any use behind an adapter.
12. Setting `logseq.id` wrongly or leaving it absent makes dev mode auto-generate an id and write it back into `package.json`.

---

## 11. OPEN ITEMS — ANSWERED BY THE M0 SPIKE (2026-09-15, details in `docs/spike-results.md`)
- H1: **Yes.** `[:find (pull ?f [:file/path :file/content]) :where [?f :file/path]]` returns current text for pages, journals, `logseq/config.edn`, `logseq/custom.css`; paths are graph-relative.
- H2: **Yes, both.** Unpacked plugins load from `file://` whether or not `effect` is set (only a dot-root install without `effect` gets `lsp://`). `window.top.apis.doAction` and `window.top.logseq.api` are reachable. All handlers work on the graph dir and `~/.logseq`. Gotchas: `readFile` is UTF-8 text only (binary → `fetch('file://…')`); `writeFile` takes string/ArrayBuffer/Uint8Array and returns `{size,mtime,ctime}`; `stat` has no `isDirectory`; `unlink` moves graph files to `logseq/.recycle/`; failures **resolve with a host-realm `Error` object** (use `Object.prototype.toString`), unknown actions resolve `null`; `Date` values are host-realm (use `getTime()`).
- H3: **Yes.** chokidar (`awaitWriteFinish`) re-indexes ~2–4 s after the write, page closed or open, with no dialog and no write-back. If the block **being edited** is changed on disk, the editor closes and unsaved input is lost silently; if another block changes, the editor stays open. `logseq/bak/` is written only when the DB copy had text the disk copy lacks.
- H4: `fetch('file://…')` **yes** (exact bytes, also outside the graph; missing → `TypeError`). `fetch('assets://…')` **no**.
- H5: not measured (the sync is manual; the executor force-saves via `Editor.exitEditingMode()` and waits before scanning).
- H6: not measured; deferred to M7/M9 (uploads are journaled and resumable anyway).
- H7: **No.** `type: 'button'` items are not rendered at all on 0.10.15.
- Also verified live: `logseq.Request` works for JSON and for binary *downloads* (`arraybuffer`/`base64`) but not for form/multipart uploads and exposes no status/headers; it needs `window.top` (same-origin). Google OAuth device flow and every Drive v3 call used by the plan work from the plugin iframe with plain `fetch` (CORS ok, resumable `Location` header exposed). `FileStorage` = `~/.logseq/storages/<id>/<key>`; `removeItem`/`clear` are fire-and-forget. fflate zips 3 MB in < 100 ms in-iframe.
