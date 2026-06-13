/// <reference path="./d.ts/core.d.ts" />
/// <reference path="./d.ts/system.d.ts" />
/// <reference path="./d.ts/app.d.ts" />
/// <reference path="./d.ts/plugin.d.ts" />

const SEH_MARKER = "SEHERRv1"
const SEH_DEFAULT_BASE = "http://127.0.0.1:43211"
const SEH_POLL_MS = 6000
const SEH_MAX_KEEP = 100
const SEH_MAX_SEEN = 500

type SehError = { id: string; t: number; ext: string; scope: string; msg: string }

function init() {
    $ui.register((ctx) => {
        const baseUrl = ctx.state<string>($storage.get<string>("seh.baseUrl") || SEH_DEFAULT_BASE)
        const errors = ctx.state<SehError[]>($storage.get<SehError[]>("seh.errors") || [])
        const seen = ctx.state<string[]>($storage.get<string[]>("seh.seen") || [])
        const baseRef = ctx.fieldRef<string>(baseUrl.get())
        let authWarned = false

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/seanime/errorhandler/icon.png",
            withContent: true,
            width: "440px",
        })

        function persist(): void {
            $storage.set("seh.errors", errors.get())
            $storage.set("seh.seen", seen.get())
            $storage.set("seh.baseUrl", baseUrl.get())
        }

        function logUrl(): string {
            const b = (baseUrl.get() || SEH_DEFAULT_BASE).replace(/\/+$/, "")
            return b + "/api/v1/logs/latest"
        }

        function parsePayloads(content: string): SehError[] {
            const out: SehError[] = []
            const lines = content.split("\n")
            for (let i = 0; i < lines.length; i++) {
                const at = lines[i].indexOf(SEH_MARKER)
                if (at < 0) continue
                const rest = lines[i].slice(at + SEH_MARKER.length)
                const start = rest.indexOf("{")
                const end = rest.lastIndexOf("}")
                if (start < 0 || end <= start) continue
                try {
                    const p = JSON.parse(rest.slice(start, end + 1)) as { t?: number; ext?: string; scope?: string; msg?: string }
                    const msg = String(p.msg || "")
                    if (!msg) continue
                    const t = typeof p.t === "number" ? p.t : 0
                    const ext = String(p.ext || "unknown")
                    const scope = String(p.scope || "")
                    out.push({ id: t + "|" + ext + "|" + scope + "|" + msg, t: t, ext: ext, scope: scope, msg: msg })
                } catch (_e) {
                    continue
                }
            }
            return out
        }

        function label(e: SehError): string {
            const head = e.scope ? e.ext + " · " + e.scope : e.ext
            return "[" + head + "] " + e.msg
        }

        function ingest(found: SehError[]): void {
            const seenList = seen.get()
            const seenSet: { [k: string]: boolean } = {}
            for (let i = 0; i < seenList.length; i++) seenSet[seenList[i]] = true

            const fresh: SehError[] = []
            for (let i = 0; i < found.length; i++) {
                if (seenSet[found[i].id]) continue
                seenSet[found[i].id] = true
                fresh.push(found[i])
            }
            if (fresh.length === 0) return

            for (let i = 0; i < fresh.length; i++) {
                ctx.toast.error(label(fresh[i]))
                try {
                    ctx.notification.send(label(fresh[i]))
                } catch (_e) {}
            }

            const nextErrors = errors.get().concat(fresh)
            errors.set(nextErrors.slice(Math.max(0, nextErrors.length - SEH_MAX_KEEP)))
            const nextSeen = seenList.concat(fresh.map((e) => e.id))
            seen.set(nextSeen.slice(Math.max(0, nextSeen.length - SEH_MAX_SEEN)))

            persist()
            tray.updateBadge({ number: errors.get().length, intent: "error" })
            tray.update()
        }

        async function pollOnce(): Promise<void> {
            try {
                const res = await ctx.fetch(logUrl(), { method: "GET", timeout: 20 })
                if (!res.ok) {
                    if (!authWarned && (res.status === 401 || res.status === 403)) {
                        authWarned = true
                        ctx.toast.warning("Error handler can't read logs (HTTP " + res.status + "). A server password or strict secure-mode blocks it — check the URL in the tray.")
                    }
                    return
                }
                authWarned = false
                const body = res.json<{ data?: string }>()
                const content = body && typeof body.data === "string" ? body.data : ""
                if (content) ingest(parsePayloads(content))
            } catch (_e) {
                return
            }
        }

        ctx.registerEventHandler("seh-clear", () => {
            errors.set([])
            seen.set([])
            persist()
            tray.updateBadge({ number: 0 })
            tray.update()
            ctx.toast.info("Cleared recorded errors")
        })

        ctx.registerEventHandler("seh-save-url", () => {
            const v = (baseRef.current || "").trim() || SEH_DEFAULT_BASE
            baseUrl.set(v)
            persist()
            authWarned = false
            ctx.toast.success("Saved server URL")
            tray.update()
        })

        tray.render(() => {
            const list = errors.get()
            const rows: any[] = []
            rows.push(tray.text("Extension errors: " + list.length))
            if (list.length === 0) {
                rows.push(tray.text("No errors reported yet."))
            } else {
                const recent = list.slice(Math.max(0, list.length - 25)).reverse()
                for (let i = 0; i < recent.length; i++) rows.push(tray.text(label(recent[i])))
                rows.push(tray.button({ label: "Clear", onClick: "seh-clear", intent: "alert", size: "sm" }))
            }
            rows.push(tray.text("Server URL"))
            rows.push(tray.input({ fieldRef: baseRef, placeholder: SEH_DEFAULT_BASE }))
            rows.push(tray.button({ label: "Save URL", onClick: "seh-save-url", intent: "primary", size: "sm" }))
            return tray.stack({ items: rows, gap: 2 })
        })

        tray.updateBadge({ number: errors.get().length, intent: "error" })
        ctx.jobs.poll("seh-log-poll", pollOnce, SEH_POLL_MS, { immediate: true })
    })
}
