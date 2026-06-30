# Aqua's Utils (`aquatils`)

Seanime plugin. One tray, two tools (tab toggle at top): **Solver** and **Errors**.

## Solver

Downloads and supervises **aquatils-solver** — a single static Go binary that clears **Cloudflare** and **DDoS-Guard** so gated providers (e.g. animepahe) load. No Docker, no Python, no system browser. Speaks the **FlareSolverr `/v1`** API on `127.0.0.1:8191`; any consumer that POSTs `/v1` uses it unchanged. The gate is **IP reputation**, so it runs **on your machine / your residential IP** — never a shared server.

Two stages, escalated automatically per request:

- **Stage A — uTLS.** Impersonates a current Chrome TLS ClientHello + HTTP/2 (Akamai) fingerprint and persists/replays `__ddg*` / `cf_clearance` / `__cf_bm` cookies. Clears passive checks and DDoS-Guard. No JS engine.
- **Stage B — browser.** When Stage A hits a JS challenge ("Just a moment", Turnstile), it drives a real Chromium over CDP: **WebView2** (default — off-screen, no taskbar button), **Chrome**, or **Edge**. Anti-detection: no `Runtime.enable`, isolated-world eval, document-create stealth injection, geometry-based trusted-click for interactive Turnstile. Harvests `cf_clearance` for Stage-A reuse.

Launch modes (persisted):

- **Binary** *(default)* — fetches the OS/arch build (Linux/macOS x64+arm64, Windows x64) into `$CACHE/aquatils-beta/<ver>/solver/`, runs it via `sh -c` / `cmd /c` bound to `127.0.0.1`. First run: one **consent** click + Seanime's **Allow** download prompt.
- **Remote** — point Host/Port at a FlareSolverr `/v1` endpoint you run (box / NAS / container). The plugin only manages sessions + status. Mandatory under Seanime **strict** secure mode (no `$os` / `$osExtra` / `ctx.downloader`).

Advanced/Settings: **Test** (real `request.get` + timing), **Doctor** (cache/port/binary), **Stealth** (validates the live TLS fingerprint against `tls.peet.ws`), browser engine + window mode, encrypted DNS (DoH), adaptive rate-limit pacing, own-spec TLS fingerprint, Auto-start + crash-restart.

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

Surfaces errors provider extensions report — Seanime swallows provider errors before the client. Extensions can't call a plugin directly (isolated runtimes), so the channel is the **server log**: extension `console.error` → `seanime-*.log` → local API `/api/v1/logs/latest`. The tool polls it, parses marked lines, groups by count, auto-expires after 6h, copy/clear. Toasts off by default (Settings). Requires: no server password (else `/logs/latest` → 401), non-strict secure mode, correct Seanime URL (`http://127.0.0.1:43211`, editable).

Provider side — emit a marked line (keep `msg` plain ASCII; the log anonymizer mangles non-ASCII JSON):

```ts
console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext, scope, msg: String(message) }))
```

## Permissions

- Scopes: `system`, `storage`, `notification`.
- `networkAccess: ["*"]` — loopback (log API + solver), a user-set Remote host (anywhere), GitHub release download. Broad because Remote is arbitrary and Seanime has no runtime per-host grant.
- `commandScopes` `sh` / `cmd` — launch/stop the binary. Decline if Remote-only.
- `readPaths` / `writePaths`: `$CACHE/aquatils-beta` — solver download/extract dir.
