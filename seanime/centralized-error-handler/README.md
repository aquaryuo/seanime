# Centralized Error Handler

A Seanime **plugin** that surfaces custom errors from provider extensions to the user as toasts, OS notifications, and a tray list — working around the fact that Seanime swallows online-stream provider errors before they reach the client and shows a generic player message instead.

## Why it has to work this way

Seanime's sandbox gives an extension and a plugin no shared channel: `$store` and `$shared` are per-runtime, plugins can't register HTTP routes, no server hook wraps a provider's thrown error, and a plugin can't subscribe to the `ConsoleLog` WebSocket events. The one channel that crosses the boundary is the **server log**: every extension `console.*` call is written to `seanime-<ts>.log`, and that file is readable over the local API at `GET /api/v1/logs/latest`.

So:

1. A provider extension reports an error with `console.error` using a fixed marker (`SEHERRv1`) + a small JSON payload.
2. This plugin polls `/api/v1/logs/latest` (loopback) every few seconds, scans for marker lines, parses the payload, de-duplicates, and shows the real message.

## What an extension developer does

Paste this helper into your provider and call it wherever you catch or throw. Keep the message plain ASCII (no URLs / file paths / usernames) so Seanime's log anonymizer doesn't rewrite the JSON.

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

Example, in an online-stream provider:

```ts
const m3u8 = this.firstMatch(html, /https?:\/\/[^"'\s]+\/master\.m3u8/)
if (!m3u8) {
    reportError("anizone", "findEpisodeServer", "No playable stream found for this episode")
    throw "anizone: no stream found for this episode"
}
```

The user sees a toast `[anizone · findEpisodeServer] No playable stream found for this episode` instead of Seanime's generic failure.

### Payload fields

| field | meaning |
| --- | --- |
| `t` | timestamp (ms); falls back to `0` if `Date.now()` is unavailable |
| `ext` | extension id/name (shown in the toast) |
| `scope` | where it happened, e.g. the method name |
| `msg` | the user-facing message |

## Tray

The plugin adds a tray icon with a red badge counting recorded errors, a list of the most recent 25 (`[ext · scope] message`), a **Clear** button, and a **Server URL** field (default `http://127.0.0.1:43211`) for installs that run Seanime on a non-default port. The list and de-dupe state persist across reloads via `$storage`.

## Requirements / limitations

- **No server password.** `/api/v1/logs/latest` is gated by `OptionalAuthMiddleware`, which is a no-op only when no server password is set. With a password the plugin can't read logs and shows a one-time warning.
- **Non-strict secure mode.** `default` / `lax` / `hardened` work; `strict` blocks both the loopback fetch and the log endpoint.
- **`ViewLogs` feature enabled** (the default).
- Errors lag a few seconds (logs flush on a ~5s cadence) and are de-duplicated, so the same error won't re-toast.
- The marker is advisory, not authenticated — any extension can emit it. The `ext`/`scope` fields are informational.
- Only helps providers that adopt the `reportError` convention; it cannot recover errors Seanime swallows before the provider's own `catch` runs.
