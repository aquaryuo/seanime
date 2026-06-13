# FlareSolverr

A Seanime **plugin** that launches and manages a local [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance and its sessions, so other extensions can fetch from Cloudflare-protected sites (e.g. animepahe) that show a *"Verifying you're a human"* gate.

## How it fits together

FlareSolverr runs a real browser to pass Cloudflare and exposes an HTTP API on `:8191`. Seanime sandboxes each extension and plugin separately (no shared memory, no plugin HTTP routes), but every extension *can* make outbound requests. So:

- **This plugin** owns the FlareSolverr lifecycle: start/stop the container, keep a warm session, show status. It does **not** proxy requests.
- **Provider extensions** (the ones scraping the site) talk to FlareSolverr's own API at `http://127.0.0.1:8191/v1` directly. No plugin-to-extension IPC is needed or possible.

## Requirements

- **Docker** for the built-in Start/Stop buttons — they run `docker run/start/stop` for a `flaresolverr` container (you'll approve the `docker` command permission on install). First start pulls `ghcr.io/flaresolverr/flaresolverr:latest`, which can take a minute.
- If you run FlareSolverr another way (a binary, an existing container, a remote host on the LAN), you don't need Docker: just start it yourself and the plugin will detect it and manage sessions. Set the **Port** in the tray if it isn't `8191`.
- A **non-strict** secure mode (`default`/`lax`/`hardened`), so loopback requests are allowed.

## Tray

Shows status (Running / Starting / Not running), the active session list, **Start / Stop / Refresh** buttons, a **Create session** button, and **Port** + **Default session name** fields. It polls FlareSolverr every 5s and auto-creates the default session (`seanime`) when the server is up. State persists across reloads via `$storage`.

## Using it from another extension

A provider runs in its own runtime and calls FlareSolverr's API directly. Drop this helper into your provider and route Cloudflare-locked fetches through it. Pass the returned `cookies` + `userAgent` on any follow-up direct requests to the same site.

```ts
const FS_ENDPOINT = "http://127.0.0.1:8191/v1"
const FS_SESSION = "seanime"

type CfResult = { html: string; cookies: { name: string; value: string }[]; userAgent: string }

async function cfGet(url: string): Promise<CfResult | null> {
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

For form posts use `cmd: "request.post"` with `postData: "a=b&c=d"`. If you omit `session`, FlareSolverr handles an ephemeral one; using the shared `seanime` session keeps a browser warm and is faster.

## Notes / limitations

- The plugin needs the `system` scope + the `docker` command permission (granted on install) to launch the container. If you deny it, the launch buttons won't work but session management against an already-running FlareSolverr still does.
- FlareSolverr is heavy (a headless browser per session). Keep the session count low; destroy sessions you don't need.
- Cookies from FlareSolverr are bound to the `userAgent` it returns — send that same UA on follow-up requests or Cloudflare will re-challenge.
