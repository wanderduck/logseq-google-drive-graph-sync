# Logseq Google Drive Graph Sync

Logseq desktop plugin (file-based graphs, Logseq 0.10.x) that syncs a graph with Google Drive on demand, keeps zip snapshots, and restores a graph onto a new device.

## Features
- Manual two-way sync: press the toolbar button or run the command-palette entry. There is no background polling; nothing is uploaded until you ask.
- Works across two or more desktops. Conflicts are resolved per file: keep local, keep remote, or keep both.
- Zip snapshots of the graph and of the Logseq profile (config, plugins, settings) with retention, stored in your Drive.
- Restore onto a new device from the latest mirror or from a chosen snapshot.
- Setup and configuration through the plugin's own panel and the Logseq settings UI.

## Status
Under development (milestone M1 of M9: project scaffold). Not usable for syncing yet.


## Progress
See [docs/progress.md](docs/progress.md) for a detailed progress report.
