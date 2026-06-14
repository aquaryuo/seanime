# Aqua's Utils

Seanime **plugin** — two tools in one tray (top toggle). Replaces the separate `errorhandler` + `flaresolverr` plugins.

- **Errors** — surfaces custom errors from provider extensions (Seanime swallows provider errors before the client).
- **Cloudflare** — runs/manages a local or remote [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) for Cloudflare-gated sites (e.g. animepahe).

## Errors

Extensions can't hand an error to a plugin directly (isolated runtimes, no shared store/route). The only channel is the **server log**: extension `console.*` → `seanime-*.log` → local API `/api/v1/logs/latest`. The tool polls it, parses marker lines, and shows toasts + a tray list.

Provider side — emit a marked line where you catch/throw (keep `msg` plain ASCII so the log anonymizer doesn't break the JSON):

```ts
const SEH_MARKER = "SEHERRv1"
function reportError(ext: string, scope: string, message: string): void {
    try {
        console.error(SEH_MARKER + " " + JSON.stringify({ t: Date.now(), ext, scope, msg: String(message) }))
    } catch (_e) {
        console.error(SEH_MARKER + " " + JSON.stringify({ t: 0, ext, scope: "unknown", msg: "report failed" }))
    }
}
```

Requires: **no server password** (else `/logs/latest` → 401, shown once), **non-strict** secure mode, `ViewLogs` enabled (default), correct Seanime URL (default `http://127.0.0.1:43211`, editable in the tab).

## Cloudflare

Most providers don't need this — try in order:

1. **`fetch`** (built-in) — in-process Chrome TLS-fingerprint impersonation (`req.C().ImpersonateChrome()`), default-on, zero deps. Clears standard Cloudflare.
2. **`ChromeDP`** (built-in) — drives an installed browser, no Docker. For harder JS challenges.
3. **FlareSolverr** — only for interactive challenges ("Verifying you are human" / Turnstile); needs a real browser, so not dependency-free.

The tab has two modes (toggle in the tab, persisted):

- **Simple** *(default)* — zero-config. On plugin load it brings FlareSolverr up automatically: Docker if the daemon is reachable (`docker info` exit 0), otherwise it downloads + runs the self-contained binary. It binds the default port `8191`, which is the default `solverUrl` consumers (e.g. animepahe) route to, so they're covered with no setup. The tab shows only status + Re-run/Re-check. The auto-download path needs Seanime's **extension secure mode off (non-strict)** — strict mode never binds `$downloader`, so use Docker or Remote there; the tab says so if it's blocked.
- **Advanced** — exposes the full controls below.

**Launch modes** *(Advanced)* — pick one in the tab, persisted:

- **Remote** — point at a FlareSolverr you run yourself (binary / another box / NAS); the plugin only manages sessions + status. Set Host/Port.
- **Docker** — `docker run/start/stop` a `flaresolverr` container. Needs Docker.
- **Binary** — downloads the GitHub release into your cache dir and runs it. **Linux/Windows x64 only**, still needs Chrome/Chromium. Launched via `sh -c` / `cmd /c` (Seanime allows commands by exact name only) — hence the broad `sh`/`cmd` permission; avoid it with Remote.

**Auto-start on launch** *(Advanced)* — a toggle in the tab. When on (Docker/Binary mode), FlareSolverr is started on plugin load if not already up. Simple mode always auto-starts; this toggle only matters once you've switched to Advanced and picked Remote.

Consumer side — hit FlareSolverr's API directly (no plugin IPC); reuse `cookies` + `userAgent` on follow-up requests:

```ts
const FS_ENDPOINT = "http://127.0.0.1:8191/v1"
const FS_SESSION = "seanime"

async function cfGet(url: string): Promise<{ html: string; cookies: { name: string; value: string }[]; userAgent: string } | null> {
    try {
        const res = await fetch(FS_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "request.get", url, session: FS_SESSION, maxTimeout: 60000 }),
            timeout: 70,
        })
        if (!res.ok) return null
        const data = res.json<any>()
        if (!data || data.status !== "ok" || !data.solution) return null
        return {
            html: data.solution.response,
            cookies: (data.solution.cookies || []).map((c: any) => ({ name: c.name, value: c.value })),
            userAgent: data.solution.userAgent,
        }
    } catch (_e) {
        return null
    }
}
```

## Permissions

- Scopes: `system`, `storage`, `notification`.
- `networkAccess: ["*"]` — loopback (log API) + configured remote FlareSolverr + GitHub release download. Narrow to `127.0.0.1`/`localhost` for Errors + local FlareSolverr only.
- `commandScopes`: `docker` (Docker mode), `sh`/`cmd` (Binary launch) — decline `sh`/`cmd` if not using Binary.
- `readPaths`/`writePaths`: `$CACHE/seanime-flaresolverr` (Binary download/extract).
