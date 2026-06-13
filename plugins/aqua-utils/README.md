# Aqua's Utils

A toolbox Seanime **plugin** combining two tools in one tray (toggle between them at the top):

1. **Errors** — surfaces custom errors that provider extensions report, since Seanime swallows provider errors before they reach the client.
2. **Cloudflare** — launches & manages a local or remote [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) so other extensions can fetch from Cloudflare-protected sites (e.g. animepahe).

> Replaces the separate `errorhandler` and `flaresolverr` plugins.

---

## Errors tool

Provider extensions can't hand a custom error to a plugin directly (isolated runtimes, no shared store, no plugin HTTP route). The one crossing channel is the **server log**: extension `console.*` is written to `seanime-*.log`, readable via the local API at `/api/v1/logs/latest`. This tool polls it, finds marker lines, and shows them as toasts + a tray list.

**What a provider dev adds** — paste this and call it where you catch/throw (keep the message plain ASCII so the log anonymizer doesn't mangle the JSON):

```ts
const SEH_MARKER = "SEHERRv1"
function reportError(ext: string, scope: string, message: string): void {
    try {
        console.error(SEH_MARKER + " " + JSON.stringify({ t: Date.now(), ext: ext, scope: scope, msg: String(message) }))
    } catch (_e) {
        console.error(SEH_MARKER + " " + JSON.stringify({ t: 0, ext: ext, scope: "unknown", msg: "report failed" }))
    }
}
```

Requires: **no server password** (otherwise `/api/v1/logs/latest` 401s — shown as a one-time warning), a **non-strict** secure mode, `ViewLogs` enabled (default), and the correct Seanime URL (default `http://127.0.0.1:43211`, editable in the tab).

---

## Cloudflare tool

### You often don't need it

Seanime's built-in `fetch` already bypasses standard Cloudflare via in-process Chrome **TLS-fingerprint impersonation** (`req.C().ImpersonateChrome()`), on by default — **zero dependencies**. That's why most providers work without any of this. For harder JS challenges, providers can use Seanime's built-in **`ChromeDP`** (drives an *installed* browser — no Docker). FlareSolverr is only for the toughest **interactive** challenges ("Verifying you are human" / Turnstile), and it inherently needs a real browser, so it can't be dependency-free.

Recommended provider pattern: built-in `fetch` → on challenge, `ChromeDP` → FlareSolverr last.

### Launch modes

Pick one in the tab (persisted):

- **Remote** (default, cleanest) — point at a FlareSolverr you run by any means (a local binary, another box, a NAS). The plugin only manages sessions + status. No Docker, no special exec. Set Host/Port in the tab.
- **Docker** — `docker run/start/stop` a `flaresolverr` container. Needs Docker.
- **Binary** *(experimental, no Docker)* — downloads the FlareSolverr release from GitHub into your cache dir and runs it. **Linux/Windows x64 only**, and FlareSolverr still **requires Chrome/Chromium installed**. Because Seanime only allows commands by exact name, the binary is launched via a `sh -c` / `cmd /c` wrapper — that's why the plugin asks for the broad `sh`/`cmd` permission. If you don't want that, use Remote or Docker.

### Using it from another extension

A provider hits FlareSolverr's own API directly (no plugin↔extension IPC needed). Pass the returned `cookies` + `userAgent` on follow-up direct requests.

```ts
const FS_ENDPOINT = "http://127.0.0.1:8191/v1"
const FS_SESSION = "seanime"

async function cfGet(url: string): Promise<{ html: string; cookies: { name: string; value: string }[]; userAgent: string } | null> {
    try {
        const res = await fetch(FS_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "request.get", url: url, session: FS_SESSION, maxTimeout: 60000 }),
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

---

## Permissions it requests (approved on install)

- `system`, `storage`, `notification` scopes.
- `networkAccess: ["*"]` — loopback (log API), a user-configured remote FlareSolverr host, and the GitHub release download. Tighten to `127.0.0.1`/`localhost` if you only use the Errors tool + a local FlareSolverr.
- `commandScopes`: `docker` (Docker mode), `sh`/`cmd` (Binary mode launch). Decline the `sh`/`cmd` ones if you won't use Binary mode.
- `readPaths`/`writePaths` under `$CACHE/seanime-flaresolverr` (Binary mode download/extract).
