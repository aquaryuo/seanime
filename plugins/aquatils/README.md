# Aqua's Utils

Seanime **plugin** (`aquatils`) — two tools in one tray (toggle at the top):

- **Solver** — downloads & manages **aquatils-solver**, a self-contained helper that gets past **Cloudflare and DDoS-Guard** so blocked sources (e.g. animepahe) load. No Docker, no Python, no system Chrome.
- **Errors** — surfaces custom errors that provider extensions report (Seanime swallows provider errors before the client).

## Solver

**aquatils-solver** is a single static Go binary that presents a genuine Chrome TLS/HTTP fingerprint (uTLS) and harvests the `__ddg*` / `cf_clearance` cookies sites expect. It clears Cloudflare's passive checks **and** DDoS-Guard from your own connection — the gate is IP reputation, so it runs **on your machine**, never through a shared server. It speaks the FlareSolverr `/v1` API on `127.0.0.1:8191`, so consumers (e.g. the animepahe provider's `solverUrl`) point at it unchanged. It is **not** Seanime-specific — anything that can POST to a FlareSolverr-`/v1` endpoint can use it. Inside the plugin it's just called **solver**.

Two launch modes (toggle in the tab, persisted):

- **Binary** *(default)* — downloads the right build for your OS/arch and runs it locally: Linux & macOS (x64/arm64), Windows (x64). Cached under `$CACHE/aquatils/<version>/solver/` and launched via `sh -c` / `cmd /c` with `HOST=127.0.0.1`.
- **Remote** — point at a solver you run yourself (any FlareSolverr-`/v1` endpoint — another box, a NAS, a container you manage). The plugin only manages sessions + status; set Host/Port.

**First download (consent)** — the first time, the Solver tab shows a **Download** button. Clicking it explains what `aquatils-solver` is and where it comes from, and asks you to confirm. On confirm, Seanime shows its own **Allow** prompt for the download (click Allow — remembered ~3 min). After that the tab just shows **Start** / **Stop**.

**Status & diagnostics** — a colored badge shows Off / Starting / Running (with URL + version + uptime when up). **Test** runs a real `request.get` and reports OK + timing; **Doctor** (Advanced) checks the cache dir, the port, and whether the binary is downloaded. With **Auto-start** on (Advanced, default off) the solver starts on plugin load and auto-restarts if it crashes (after two failed polls); a manual **Stop** is always respected.

**Secure mode** — in Seanime's *strict* secure mode `$os` / `$osExtra` / `ctx.downloader` are unavailable, so Binary mode can't download or run — only **Remote** works there.

The real ceiling is **IP reputation**: from a datacenter/VPS/flagged IP, DDoS-Guard fails regardless of engine. Run it from a residential connection.

Consumer side — POST the FlareSolverr `/v1` API directly (reuse `cookies` + `userAgent` on follow-ups):

```ts
const SOLVER = "http://127.0.0.1:8191/v1"
const SESSION = "seanime"

async function solveGet(url: string) {
    const res = await fetch(SOLVER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, session: SESSION, maxTimeout: 60000 }),
        timeout: 70,
    })
    if (!res.ok) return null
    const data = res.json<any>()
    if (!data || data.status !== "ok" || !data.solution) return null
    return { html: data.solution.response, cookies: data.solution.cookies || [], userAgent: data.solution.userAgent }
}
```

## Errors

Extensions can't hand an error to a plugin directly (isolated runtimes). The channel is the **server log**: extension `console.*` → `seanime-*.log` → local API `/api/v1/logs/latest`. The tool polls it, parses marker lines, and lists them (grouped with counts, auto-expire after 6h, tap to copy, **Copy all** / **Clear**). **Toast/system notifications are off by default** — enable them in **Settings** (the ⚙ top-right). Requires **no server password** (else `/logs/latest` → 401, shown once), **non-strict** secure mode, and the correct Seanime URL (default `http://127.0.0.1:43211`, editable in Settings).

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

## Permissions

- Scopes: `system`, `storage`, `notification`.
- `networkAccess: ["*"]` — loopback (log API + local solver), a user-configured Remote solver (any host), and the GitHub release download. Kept broad because Remote can point anywhere and Seanime has no runtime per-host grant.
- `commandScopes`: `sh` / `cmd` — launch the solver binary (and stop it on Windows). Decline if you only use Remote mode.
- `readPaths` / `writePaths`: `$CACHE/aquatils` — the solver download/extract dir.
