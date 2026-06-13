/// <reference path="./d.ts/core.d.ts" />
/// <reference path="./d.ts/system.d.ts" />
/// <reference path="./d.ts/app.d.ts" />
/// <reference path="./d.ts/plugin.d.ts" />

const FS_CONTAINER = "flaresolverr"
const FS_IMAGE = "ghcr.io/flaresolverr/flaresolverr:latest"
const FS_DEFAULT_PORT = "8191"
const FS_DEFAULT_SESSION = "seanime"
const FS_POLL_MS = 5000

function init() {
    $ui.register((ctx) => {
        const port = ctx.state<string>($storage.get<string>("fs.port") || FS_DEFAULT_PORT)
        const sessionName = ctx.state<string>($storage.get<string>("fs.session") || FS_DEFAULT_SESSION)
        const status = ctx.state<string>("unknown")
        const sessions = ctx.state<string[]>([])
        const note = ctx.state<string>("")
        const portRef = ctx.fieldRef<string>(port.get())
        const sessionRef = ctx.fieldRef<string>(sessionName.get())
        let busy = false

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/seanime/flaresolverr/icon.png",
            withContent: true,
            width: "460px",
        })

        function base(): string {
            return "http://127.0.0.1:" + (port.get() || FS_DEFAULT_PORT)
        }

        function persist(): void {
            $storage.set("fs.port", port.get())
            $storage.set("fs.session", sessionName.get())
        }

        async function api(cmd: string, extra: { [k: string]: any }): Promise<any> {
            try {
                const res = await ctx.fetch(base() + "/v1", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(Object.assign({ cmd: cmd }, extra || {})),
                    timeout: 25,
                })
                if (!res.ok) return null
                return res.json<any>()
            } catch (_e) {
                return null
            }
        }

        async function ensureSession(): Promise<void> {
            const name = (sessionName.get() || FS_DEFAULT_SESSION).trim()
            if (!name) return
            await api("sessions.create", { session: name })
        }

        async function refresh(): Promise<void> {
            const r = await api("sessions.list", {})
            if (r && r.status === "ok") {
                status.set("up")
                const list: string[] = Array.isArray(r.sessions) ? r.sessions : []
                sessions.set(list)
                if (sessionName.get() && list.indexOf(sessionName.get()) < 0) {
                    await ensureSession()
                }
            } else {
                if (status.get() !== "starting") status.set("down")
                sessions.set([])
            }
            tray.update()
        }

        function dockerStart(): void {
            if (busy) return
            busy = true
            status.set("starting")
            note.set("Starting FlareSolverr…")
            tray.update()
            const run = $osExtra.asyncCmd("docker", "run", "-d", "--name", FS_CONTAINER, "-p", port.get() + ":8191", "-e", "LOG_LEVEL=info", "--restart", "unless-stopped", FS_IMAGE)
            run.run((_d, _e, code, _s) => {
                if (code === undefined) return
                if (code === 0) {
                    busy = false
                    note.set("Container created; waiting for it to come up…")
                    ctx.toast.info(note.get())
                    tray.update()
                    return
                }
                const start = $osExtra.asyncCmd("docker", "start", FS_CONTAINER)
                start.run((_d2, _e2, code2, _s2) => {
                    if (code2 === undefined) return
                    busy = false
                    if (code2 === 0) {
                        note.set("Container started; waiting for it to come up…")
                        ctx.toast.info(note.get())
                    } else {
                        status.set("down")
                        note.set("Could not start FlareSolverr — is Docker installed and running?")
                        ctx.toast.error(note.get())
                    }
                    tray.update()
                })
            })
        }

        function dockerStop(): void {
            if (busy) return
            busy = true
            const stop = $osExtra.asyncCmd("docker", "stop", FS_CONTAINER)
            stop.run((_d, _e, code, _s) => {
                if (code === undefined) return
                busy = false
                if (code === 0) {
                    status.set("down")
                    note.set("FlareSolverr stopped.")
                    ctx.toast.info(note.get())
                } else {
                    note.set("Stop failed — the container may not exist.")
                    ctx.toast.warning(note.get())
                }
                tray.update()
            })
        }

        ctx.registerEventHandler("fs-start", () => dockerStart())
        ctx.registerEventHandler("fs-stop", () => dockerStop())
        ctx.registerEventHandler("fs-refresh", () => {
            void refresh()
        })
        ctx.registerEventHandler("fs-create-session", () => {
            void ensureSession().then(() => refresh())
        })
        ctx.registerEventHandler("fs-save", () => {
            port.set((portRef.current || "").trim() || FS_DEFAULT_PORT)
            sessionName.set((sessionRef.current || "").trim() || FS_DEFAULT_SESSION)
            persist()
            ctx.toast.success("Saved FlareSolverr settings")
            void refresh()
        })

        function statusLabel(): string {
            const st = status.get()
            if (st === "up") return "Running — " + base()
            if (st === "starting") return "Starting…"
            if (st === "down") return "Not running"
            return "Checking…"
        }

        tray.render(() => {
            const rows: any[] = []
            rows.push(tray.text(statusLabel()))
            if (note.get()) rows.push(tray.text(note.get()))
            rows.push(tray.flex([
                tray.button({ label: "Start", onClick: "fs-start", intent: "primary", size: "sm" }),
                tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm" }),
                tray.button({ label: "Refresh", onClick: "fs-refresh", intent: "gray", size: "sm" }),
            ]))
            const ss = sessions.get()
            rows.push(tray.text("Sessions: " + (ss.length ? ss.join(", ") : "none")))
            rows.push(tray.button({ label: "Create \"" + (sessionName.get() || FS_DEFAULT_SESSION) + "\" session", onClick: "fs-create-session", intent: "gray", size: "sm" }))
            rows.push(tray.text("Port"))
            rows.push(tray.input({ fieldRef: portRef, placeholder: FS_DEFAULT_PORT }))
            rows.push(tray.text("Default session name"))
            rows.push(tray.input({ fieldRef: sessionRef, placeholder: FS_DEFAULT_SESSION }))
            rows.push(tray.button({ label: "Save", onClick: "fs-save", intent: "primary", size: "sm" }))
            return tray.stack({ items: rows, gap: 3 })
        })

        ctx.jobs.poll("fs-refresh-poll", refresh, FS_POLL_MS, { immediate: true })
    })
}
