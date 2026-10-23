# Download Manager

A Windows desktop download manager modelled on Internet Download Manager (IDM). It is built with Electron and React, and it includes a Model Context Protocol (MCP) server so that Claude, or any other MCP client, can queue and control downloads.

![Main window](docs/screenshot.png)

## Features

| Feature | Behaviour |
| --- | --- |
| Multi-connection downloads | Files are split into up to 32 byte ranges (default 8), and the ranges are downloaded in parallel over HTTP `Range` requests. |
| Dynamic segmentation | When a connection finishes its range early, it takes over half of the largest remaining range, so all connections stay busy until the file is complete. |
| Pause and resume | Downloads stop and continue from the saved byte offsets, including after the app is restarted. Servers without range support fall back to a single connection. |
| Retry | Failed connections are retried up to five times with exponential back-off. HTTP 4xx errors are treated as final. |
| Queue | A configurable number of downloads run at once (default 3). The others wait in the queue. |
| Speed limiter | A global bandwidth cap in KB/s, shared across all connections. |
| Categories | Files are sorted into Compressed, Documents, Music, Programs, Video and Other, with optional sub-folders for each category. |
| Clipboard capture | When a direct file link is copied, the Add dialog opens with that link. |
| Batch add | Several URLs can be pasted into the Add dialog, one per line. |
| Segment map | The details pane draws each connection's progress at its byte offset in the file. |
| MCP server | 10 tools for adding, listing, pausing, resuming and removing downloads, and for changing settings. |

## Download the `.exe`

GitHub Actions builds the Windows executables on every push. Open the **Actions** tab, select the latest **Build Windows exe** run, and download the `download-manager-windows` artifact. The artifact contains:

- `Download Manager-Setup-1.0.0.exe`: the installer, which creates Start-menu and desktop shortcuts.
- `Download Manager-Portable-1.0.0.exe`: a single-file portable build that needs no installation.

When a tag such as `v1.0.0` is pushed, the workflow also attaches both files to a GitHub Release.

The executables are not code-signed. On first launch, Windows SmartScreen shows a warning; select **More info → Run anyway**.

## Connecting Claude via MCP

1. Start Download Manager.
2. Open **Options → MCP / AI** and copy the configuration that is shown there. It contains the correct paths for your installation.
3. Paste the configuration into `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude Desktop.

For a default per-user installation, the configuration looks like this:

```json
{
  "mcpServers": {
    "download-manager": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Download Manager\\Download Manager.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Download Manager\\resources\\mcp\\download-manager-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` makes the app's own runtime execute the MCP server, so Node.js does not need to be installed. If Node.js is installed, `"command": "node"` with the same script path also works.

The MCP server provides the following tools:

| Tool | Purpose |
| --- | --- |
| `add_download` | Queue a URL. Optional inputs: file name, folder, number of connections, and whether to start immediately. |
| `list_downloads` | List downloads, optionally filtered by status. |
| `get_download` | Show the details of one download, including each connection segment. |
| `pause_download` / `resume_download` | Stop or continue a download. Resuming a failed download retries it. |
| `pause_all` / `resume_all` | Stop or continue the whole queue. |
| `remove_download` | Remove a download from the list, and optionally delete the file. |
| `get_settings` / `update_settings` | Read or change the folder, concurrency, connections and speed limit. |

Example prompt: *"Download the Sentinel-2 tile at https://… into D:\Data\S2 with 16 connections, and tell me when it finishes."*

### How the MCP server reaches the app

```
Claude Desktop ──stdio──▶ download-manager-mcp.cjs ──HTTP + token──▶ Download Manager (127.0.0.1:6801)
```

The app runs a REST API that listens on `127.0.0.1` only. Every request must carry a bearer token, and any request with an `Origin` header (that is, from a web page) is rejected. The port and token are written to `%APPDATA%\Download Manager\api.json`, and the MCP server reads them from that file. Clients that cannot read the file can set the `DM_API_URL` and `DM_API_TOKEN` environment variables instead.

REST endpoints: `GET|POST /api/downloads`, `GET|DELETE /api/downloads/:id`, `POST /api/downloads/:id/pause|resume`, `POST /api/pause-all|resume-all`, `GET|PATCH /api/settings`.

## Development

Requirements: Node.js 20 or later.

```bash
npm install
npm run dev        # Vite dev server + Electron with hot reload
npm test           # engine, API and MCP end-to-end tests
npm run dist:win   # build release/*.exe (run on Windows; on Linux only the portable target builds without Wine)
```

`npx vite` serves the interface in an ordinary browser. In that mode a simulated backend is used, which is useful for work on the interface alone.

### Project layout

```
electron/
  main.js                 window, IPC, clipboard monitor, notifications, starts the API
  preload.js              the only bridge between the UI and the main process
  api-server.js           local REST API used by the MCP server
  engine/
    Download.js           probing, segmenting, range workers, dynamic splitting, resume
    DownloadManager.js    queue, concurrency, persistence, settings
    RateLimiter.js        shared bandwidth limiter
    utils.js              file names, categories, unique paths
mcp/server.mjs            MCP server (bundled to dist-mcp/ by esbuild)
src/                      React interface
test/                     node:test suites (engine, API and MCP)
```

Settings and the download list are stored as JSON in `%APPDATA%\Download Manager\`. Partial downloads are stored next to the target file with the extension `.dmpart`.

## Differences from IDM

This application does not yet include the following IDM features:

- browser integration (a browser extension that intercepts downloads);
- capture of video streams from web pages (HLS/DASH);
- a scheduler;
- authentication prompts for downloads that need a login;
- FTP support.

The browser extension is the most practical next step: the local API already accepts `POST /api/downloads`.

## Licence

MIT
