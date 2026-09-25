# Aqua's Utils (`aquatils`)

Seanime plugin. One tray, two tools (tab toggle at top): **Solver** and **Errors**.

## Solver

Downloads and supervises **aquatils-solver** — a single static Go binary that clears **Cloudflare** and **DDoS-Guard** so gated providers (e.g. animepahe) load. No Docker, no Python. Speaks the **FlareSolverr `/v1`** API on `127.0.0.1:8191`; any consumer that POSTs `/v1` uses it unchanged. The gate is **IP reputation**, so it runs **on your machine / your residential IP** — never a shared server.

Two stages, escalated automatically per request:

- **Stage A — uTLS.** Impersonates a current Chrome TLS ClientHello + HTTP/2 (Akamai) fingerprint and persists/replays `__ddg*` / `cf_clearance` / `__cf_bm` cookies. Clears passive checks and DDoS-Guard. No JS engine.
- **Stage B — browser.** When Stage A hits a JS challenge ("Just a moment", Turnstile), it drives a real Chromium: **WebView2** (Windows default — off-screen, no taskbar button) or a **Chromium** the plugin downloads from Chrome for Testing and re-checks for updates weekly; an update downloads while the solver runs, then one restart swaps it in (on Linux/macOS with that download turned off, a Chromium already on `PATH`). Anti-detection: no `Runtime.enable`, isolated-world eval, document-create stealth injection, geometry-based trusted-click for interactive Turnstile. Harvests `cf_clearance` for Stage-A reuse.

On Linux, Stage B needs Xvfb and Chromium's system libraries. On Debian/Ubuntu the tray offers to install them with `apt-get` when you press Install (root or passwordless sudo); elsewhere it names what to install.

Launch modes (persisted):

- **Binary** *(default)* — fetches the OS/arch build (Linux/macOS x64+arm64, Windows x64) into `$CACHE/aquatils/<ver>/solver/`, runs it via `sh -c` / `cmd /c` bound to `127.0.0.1`. First run: one **consent** click + Seanime's **Allow** download prompt.
- **Remote** — point Host/Port at an aquatils-solver you run (box / NAS / container), started with `HOST=0.0.0.0 SOLVER_ALLOW_EXTERNAL=1`. It has no password: keep it on your LAN or a VPN, never port-forward it. A plain FlareSolverr is detected and refused. Diagnostics show only `remote:<port>`, not the host. The plugin only manages sessions + status. Mandatory under Seanime **strict** secure mode (no `$os` / `$osExtra` / `ctx.downloader`).

Advanced/Settings: **Test** (fetches a test page through the solver + timing, then says whether hard challenges can be solved here), **Doctor** (cache/port/binary), **Stealth** (validates the live TLS fingerprint against `tls.peet.ws`), browser engine (Windows), the Chromium download, encrypted DNS (DoH), adaptive rate-limit pacing, own-spec TLS fingerprint, Auto-start + crash-restart. Auto-start is offered once, after the first successful start.

**Ceiling: IP reputation.** A datacenter / VPS / flagged IP fails regardless of engine. Use a residential connection.

Consumer (reuse `cookies` + `userAgent` on follow-ups):

```ts
const r = await fetch("http://127.0.0.1:8191/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, session: "seanime", maxTimeout: 60000 }),
})
const d = r.json<any>() // d.status === "ok" → d.solution.{ response, cookies, userAgent }
```

## Errors

Surfaces errors provider extensions report — Seanime swallows provider errors before the client. Extensions can't call a plugin directly (isolated runtimes), so the channel is the **server log**: extension `console.error` → `seanime-*.log` → local API `/api/v1/logs/latest`. The tool polls it, parses marked lines, groups by count with the time of the latest one, auto-expires after 6h, copy/clear. The tab says whether it can read the log, and the tray badge counts only errors you haven't opened yet. Toasts off by default (Settings). Not available when a server password is set (`/logs/latest` → 401). Also needs non-strict secure mode and the correct Seanime URL (`http://127.0.0.1:43211`, editable; Save checks it).

Provider side — one `console.error` line per report: the marker `SEHERRv1`, a space, then a JSON object (`console.warn` is logged at debug level and can be dropped):

```ts
console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext, scope, msg, lvl }))
```

- `t` — ms epoch (`Date.now()`). A record without one, more than 60 s ahead, or older than 6h is dropped.
- `ext` — extension id, e.g. `aq-anikoto`.
- `scope` — free text naming the step, e.g. `search`, `episodes`, `server`.
- `msg` — plain ASCII on one line; the log anonymizer mangles non-ASCII JSON.
- `lvl` — optional. Leave it out for an error. `"warn"` marks a recovered fallback, `"info"` an expected answer (e.g. no dub for this episode); both show dimmed and labelled, and neither counts toward the badge or notifications. Any other value is treated as an error. `JSON.stringify` drops `lvl: undefined`, so errors carry no `lvl` field.

## Permissions

- Scopes: `system`, `storage`, `notification`.
- `networkAccess: ["*"]` — loopback (log API + solver), a user-set Remote host (anywhere), GitHub release download, Chrome for Testing (index on `googlechromelabs.github.io`, the Chromium zip from `storage.googleapis.com`; Google publishes no digest for it, so it is checked only by HTTPS and its exact URL). Broad because Remote is arbitrary and Seanime has no runtime per-host grant.
- `commandScopes` `sh` / `cmd` — start the downloaded solver and prepare the downloaded Chromium (`chmod` and the macOS quarantine strip on both; on Windows `.\solver.exe` from its own folder); hash the download before it runs (`sha256sum` / `shasum` / `certutil`); unpack Chromium on macOS (`ditto`); check Chromium's system libraries (`Xvfb`, `ldd`, `dpkg-query`, whether `apt-get` exists) and look for an installed Chromium; `apt-get install` the missing packages as root or passwordless sudo, only when you press Install; stop the plugin's own solver and Chromium processes (`pkill` / `kill`, PowerShell), matched on an aquatils folder in their path, and wait for the port to close (`ss` / `lsof`). Decline if Remote-only.
- `readPaths` / `writePaths`: `$CACHE/aquatils` — solver download/extract dir.
