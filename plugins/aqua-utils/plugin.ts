/// <reference path="./d.ts/core.d.ts" />
/// <reference path="./d.ts/system.d.ts" />
/// <reference path="./d.ts/app.d.ts" />
/// <reference path="./d.ts/plugin.d.ts" />

type SehError = { id: string; t: number; ext: string; scope: string; msg: string }

function init() {
    $ui.register((ctx) => {
        const SEH_MARKER = "SEHERRv1"
        const SEH_MAX_KEEP = 100
        const SEH_MAX_SEEN = 500
        const SEH_POLL_MS = 6000
        const SEH_DEFAULT_APP = "http://127.0.0.1:43211"
        const FS_CONTAINER = "flaresolverr"
        const FS_IMAGE = "ghcr.io/flaresolverr/flaresolverr:latest"
        const FS_VERSION = "v3.5.0"
        const FS_DEFAULT_HOST = "127.0.0.1"
        const FS_DEFAULT_PORT = "8191"
        const FS_DEFAULT_SESSION = "seanime"
        const FS_POLL_MS = 5000

        const view = ctx.state<string>("errors")
        const uiMode = ctx.state<string>($storage.get<string>("ui.mode") || "simple")

        const appBase = ctx.state<string>($storage.get<string>("seh.appBase") || SEH_DEFAULT_APP)
        const errors = ctx.state<SehError[]>($storage.get<SehError[]>("seh.errors") || [])
        const seen = ctx.state<string[]>($storage.get<string[]>("seh.seen") || [])
        const appRef = ctx.fieldRef<string>(appBase.get())
        let sehAuthWarned = false

        const fsMode = ctx.state<string>($storage.get<string>("fs.mode") || "remote")
        const fsHost = ctx.state<string>($storage.get<string>("fs.host") || FS_DEFAULT_HOST)
        const fsPort = ctx.state<string>($storage.get<string>("fs.port") || FS_DEFAULT_PORT)
        const fsSession = ctx.state<string>($storage.get<string>("fs.session") || FS_DEFAULT_SESSION)
        const fsAutoStart = ctx.state<boolean>($storage.get<boolean>("fs.autoStart") || false)
        const fsStatus = ctx.state<string>("unknown")
        const fsSessions = ctx.state<string[]>([])
        const fsNote = ctx.state<string>("")
        const fsHostRef = ctx.fieldRef<string>(fsHost.get())
        const fsPortRef = ctx.fieldRef<string>(fsPort.get())
        const fsSessionRef = ctx.fieldRef<string>(fsSession.get())
        let fsBusy = false
        let fsBinary: $os.Cmd | null = null
        const dockerExe = ctx.state<string>("docker")
        let dockerResolved = false

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/extensions/animepahe/icon.png",
            withContent: true,
            width: "480px",
        })

        function sehPersist(): void {
            $storage.set("seh.errors", errors.get())
            $storage.set("seh.seen", seen.get())
            $storage.set("seh.appBase", appBase.get())
        }

        function sehLabel(e: SehError): string {
            const head = e.scope ? e.ext + " · " + e.scope : e.ext
            return "[" + head + "] " + e.msg
        }

        function sehParse(content: string): SehError[] {
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

        function sehIngest(found: SehError[]): void {
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
                ctx.toast.error(sehLabel(fresh[i]))
                try {
                    ctx.notification.send(sehLabel(fresh[i]))
                } catch (_e) {}
            }
            const nextErrors = errors.get().concat(fresh)
            errors.set(nextErrors.slice(Math.max(0, nextErrors.length - SEH_MAX_KEEP)))
            const nextSeen = seenList.concat(fresh.map((e) => e.id))
            seen.set(nextSeen.slice(Math.max(0, nextSeen.length - SEH_MAX_SEEN)))
            sehPersist()
            tray.update()
        }

        async function sehPoll(): Promise<void> {
            try {
                const url = (appBase.get() || SEH_DEFAULT_APP).replace(/\/+$/, "") + "/api/v1/logs/latest"
                const res = await ctx.fetch(url, { method: "GET", timeout: 20 })
                if (!res.ok) {
                    if (!sehAuthWarned && (res.status === 401 || res.status === 403)) {
                        sehAuthWarned = true
                        ctx.toast.warning("Aqua's Utils can't read logs (HTTP " + res.status + "). A server password or strict mode blocks it.")
                    }
                    return
                }
                sehAuthWarned = false
                const body = res.json<{ data?: string }>()
                const content = body && typeof body.data === "string" ? body.data : ""
                if (content) sehIngest(sehParse(content))
            } catch (_e) {
                return
            }
        }

        function fsBase(): string {
            return "http://" + (fsHost.get() || FS_DEFAULT_HOST) + ":" + (fsPort.get() || FS_DEFAULT_PORT)
        }

        function fsPersist(): void {
            $storage.set("fs.mode", fsMode.get())
            $storage.set("fs.host", fsHost.get())
            $storage.set("fs.port", fsPort.get())
            $storage.set("fs.session", fsSession.get())
            $storage.set("fs.autoStart", fsAutoStart.get())
        }

        async function fsApi(cmd: string, extra: { [k: string]: any }): Promise<any> {
            try {
                const res = await ctx.fetch(fsBase() + "/v1", {
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

        async function fsEnsureSession(): Promise<void> {
            const name = (fsSession.get() || FS_DEFAULT_SESSION).trim()
            if (!name) return
            await fsApi("sessions.create", { session: name })
        }

        async function fsRefresh(): Promise<void> {
            const r = await fsApi("sessions.list", {})
            if (r && r.status === "ok") {
                fsStatus.set("up")
                const list: string[] = Array.isArray(r.sessions) ? r.sessions : []
                fsSessions.set(list)
                if (fsSession.get() && list.indexOf(fsSession.get()) < 0) await fsEnsureSession()
            } else {
                if (fsStatus.get() !== "starting") fsStatus.set("down")
                fsSessions.set([])
            }
            tray.update()
        }

        function dockerCandidates(): string[] {
            if ($os.platform === "windows") {
                return ["docker", "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", "C:\\Program Files\\Docker\\Docker\\resources\\docker.exe"]
            }
            return ["docker", "/usr/local/bin/docker", "/usr/bin/docker", "/opt/homebrew/bin/docker", "/snap/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]
        }

        function resolveDocker(cb: (exe: string | null, up: boolean) => void): void {
            const cands = dockerCandidates()
            let i = 0
            function tryNext(): void {
                if (i >= cands.length) {
                    cb(null, false)
                    return
                }
                const cand = cands[i++]
                let done = false
                try {
                    const probe = $osExtra.asyncCmd(cand, "info")
                    probe.run((_d, _e, code, _s) => {
                        if (code === undefined || done) return
                        done = true
                        cb(cand, code === 0)
                    })
                } catch (_e) {
                    tryNext()
                }
            }
            tryNext()
        }

        function ensureDockerExe(cb: (exe: string | null) => void): void {
            if (dockerResolved) {
                cb(dockerExe.get() || null)
                return
            }
            resolveDocker((exe, _up) => {
                dockerResolved = true
                if (exe) dockerExe.set(exe)
                cb(exe)
            })
        }

        function dockerStart(): void {
            if (fsBusy) return
            ensureDockerExe((exe) => {
                if (!exe) {
                    fsStatus.set("down")
                    fsNote.set("Docker not found. Install Docker Desktop and restart Seanime, or use Binary/Remote mode.")
                    ctx.toast.error(fsNote.get())
                    tray.update()
                    return
                }
                fsBusy = true
                fsStatus.set("starting")
                fsNote.set("Starting FlareSolverr container…")
                tray.update()
                const run = $osExtra.asyncCmd(exe, "run", "-d", "--name", FS_CONTAINER, "-p", fsPort.get() + ":8191", "-e", "LOG_LEVEL=info", "--restart", "unless-stopped", FS_IMAGE)
                run.run((_d, _e, code, _s) => {
                    if (code === undefined) return
                    if (code === 0) {
                        fsBusy = false
                        fsNote.set("Container created; waiting for it to come up…")
                        tray.update()
                        return
                    }
                    const start = $osExtra.asyncCmd(exe, "start", FS_CONTAINER)
                    start.run((_d2, _e2, code2, _s2) => {
                        if (code2 === undefined) return
                        fsBusy = false
                        if (code2 === 0) {
                            fsNote.set("Container started; waiting for it to come up…")
                        } else {
                            fsStatus.set("down")
                            fsNote.set("Could not start the container — is the Docker daemon running?")
                            ctx.toast.error(fsNote.get())
                        }
                        tray.update()
                    })
                })
            })
        }

        function dockerStop(): void {
            if (fsBusy) return
            ensureDockerExe((exe) => {
                if (!exe) return
                fsBusy = true
                const stop = $osExtra.asyncCmd(exe, "stop", FS_CONTAINER)
                stop.run((_d, _e, code, _s) => {
                    if (code === undefined) return
                    fsBusy = false
                    fsStatus.set("down")
                    fsNote.set(code === 0 ? "Container stopped." : "Stop failed — the container may not exist.")
                    tray.update()
                })
            })
        }

        function binaryAsset(): { asset: string; zip: boolean } | null {
            if ($os.platform === "linux" && $os.arch === "amd64") return { asset: "flaresolverr_linux_x64.tar.gz", zip: false }
            if ($os.platform === "windows" && $os.arch === "amd64") return { asset: "flaresolverr_windows_x64.zip", zip: true }
            return null
        }

        function binaryLaunch(binPath: string): void {
            binaryStop()
            const ac = $os.platform === "windows" ? $osExtra.asyncCmd("cmd", "/c", binPath) : $osExtra.asyncCmd("sh", "-c", "exec '" + binPath + "'")
            const c = ac.getCommand()
            fsBinary = c
            try {
                c.start()
                fsStatus.set("starting")
                fsNote.set("FlareSolverr binary started; waiting for it to come up…")
            } catch (_e) {
                fsBinary = null
                fsStatus.set("down")
                fsNote.set("Launch failed — the binary may need Chrome/Chromium installed.")
                ctx.toast.error(fsNote.get())
            }
            tray.update()
        }

        function binaryStop(): void {
            if (fsBinary && fsBinary.process) {
                try {
                    fsBinary.process.kill()
                } catch (_e) {}
            }
            fsBinary = null
        }

        function downloaderReady(): boolean {
            try {
                return typeof $downloader !== "undefined" && !!$downloader && typeof $downloader.download === "function"
            } catch (_e) {
                return false
            }
        }

        function binaryEnsureAndStart(): void {
            if (fsBusy) return
            if (typeof $os === "undefined" || typeof $downloader === "undefined") {
                fsStatus.set("down")
                fsNote.set("Seanime's strict secure mode blocks local file & download access — only Remote mode works here. Turn off strict secure mode in Seanime settings, or use Remote mode with a FlareSolverr you run yourself.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            const pick = binaryAsset()
            if (!pick) {
                fsNote.set("Binary mode supports Linux/Windows x64 only. Use Docker or Remote here.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            let cacheDir = ""
            try {
                cacheDir = $os.cacheDir()
            } catch (_e) {
                fsNote.set("No cache-dir access for the download.")
                tray.update()
                return
            }
            const dir = $filepath.join(cacheDir, "seanime-flaresolverr")
            const archive = $filepath.join(dir, pick.asset)
            const binPath = $filepath.join(dir, FS_CONTAINER, pick.zip ? "flaresolverr.exe" : "flaresolverr")
            try {
                if ($os.stat(binPath)) {
                    binaryLaunch(binPath)
                    return
                }
            } catch (_e) {}
            try {
                $os.mkdirAll(dir, 493)
            } catch (_e) {}
            if (!downloaderReady()) {
                fsStatus.set("down")
                fsNote.set("FlareSolverr auto-download isn't available here. Use Docker or Remote mode.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            fsBusy = true
            fsStatus.set("starting")
            fsNote.set("Downloading FlareSolverr " + FS_VERSION + " — if Seanime asks, click Allow to permit the download.")
            tray.update()
            const url = "https://github.com/FlareSolverr/FlareSolverr/releases/download/" + FS_VERSION + "/" + pick.asset
            let id = ""
            try {
                id = $downloader.download(url, archive)
            } catch (_e) {
                fsBusy = false
                fsStatus.set("down")
                const em = String(_e)
                let msg = "Download blocked: " + em + " — try Docker or Remote mode."
                if (em.indexOf("denied") >= 0) msg = "Download declined. Re-run setup and click Allow on the Seanime popup, or use Docker/Remote mode."
                else if (em.indexOf("unavailable") >= 0) msg = "Seanime couldn't show the permission popup (no app window connected). Open the Seanime app window, then re-run setup."
                else if (em.indexOf("deadline") >= 0 || em.indexOf("timeout") >= 0 || em.indexOf("context") >= 0) msg = "The permission popup timed out. Re-run setup and click Allow."
                else if (em.indexOf("not authorized") >= 0) msg = "Download path not authorized — please report this (plugin bug)."
                fsNote.set(msg)
                ctx.toast.error(fsNote.get())
                tray.update()
                return
            }
            const cancel = $downloader.watch(id, (p) => {
                if (!p) return
                if (p.status === "downloading") {
                    fsNote.set("Downloading… " + Math.round(p.percentage) + "%")
                    tray.update()
                } else if (p.status === "completed") {
                    cancel()
                    fsNote.set("Extracting…")
                    tray.update()
                    try {
                        if (pick.zip) $osExtra.unzip(archive, dir)
                        else $osExtra.unwrapAndMove(archive, dir)
                    } catch (_e) {
                        fsBusy = false
                        fsStatus.set("down")
                        fsNote.set("Extraction failed.")
                        tray.update()
                        return
                    }
                    fsBusy = false
                    binaryLaunch(binPath)
                } else if (p.status === "error") {
                    cancel()
                    fsBusy = false
                    fsStatus.set("down")
                    fsNote.set("Download failed: " + (p.error || ""))
                    tray.update()
                }
            })
        }

        function fsStart(): void {
            const m = fsMode.get()
            if (m === "docker") dockerStart()
            else if (m === "binary") binaryEnsureAndStart()
            else {
                fsNote.set("Remote mode: start FlareSolverr yourself; this only manages sessions at " + fsBase() + ".")
                tray.update()
                void fsRefresh()
            }
        }

        function fsStop(): void {
            const m = fsMode.get()
            if (m === "docker") dockerStop()
            else if (m === "binary") {
                binaryStop()
                fsStatus.set("down")
                fsNote.set("Binary stopped.")
                tray.update()
            } else {
                fsNote.set("Remote mode: stop FlareSolverr on its host.")
                tray.update()
            }
        }

        function simpleSetup(): void {
            void fsRefresh().then(() => {
                if (fsStatus.get() === "up") return
                fsNote.set("Setting up Cloudflare bypass automatically…")
                tray.update()
                resolveDocker((exe, up) => {
                    if (exe) {
                        dockerResolved = true
                        dockerExe.set(exe)
                    }
                    if (exe && up) {
                        fsMode.set("docker")
                        fsAutoStart.set(true)
                        fsPersist()
                        dockerStart()
                        return
                    }
                    if (exe) {
                        fsNote.set("Docker is installed but its daemon isn't running — start Docker Desktop, then re-run setup. Using the bundled binary for now…")
                        tray.update()
                    }
                    fsMode.set("binary")
                    fsAutoStart.set(true)
                    fsPersist()
                    binaryEnsureAndStart()
                })
            })
        }

        ctx.registerEventHandler("view-errors", () => view.set("errors"))
        ctx.registerEventHandler("view-cf", () => view.set("cf"))

        ctx.registerEventHandler("seh-clear", () => {
            errors.set([])
            seen.set([])
            sehPersist()
            tray.update()
            ctx.toast.info("Cleared recorded errors")
        })
        ctx.registerEventHandler("seh-save", () => {
            appBase.set((appRef.current || "").trim() || SEH_DEFAULT_APP)
            sehAuthWarned = false
            sehPersist()
            ctx.toast.success("Saved Seanime URL")
            void sehPoll()
        })

        ctx.registerEventHandler("fs-start", () => fsStart())
        ctx.registerEventHandler("fs-stop", () => fsStop())
        ctx.registerEventHandler("fs-refresh", () => {
            void fsRefresh()
        })
        ctx.registerEventHandler("fs-create-session", () => {
            void fsEnsureSession().then(() => fsRefresh())
        })
        ctx.registerEventHandler("fs-mode-remote", () => {
            fsMode.set("remote")
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-mode-docker", () => {
            fsMode.set("docker")
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-mode-binary", () => {
            fsMode.set("binary")
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-autostart-toggle", () => {
            fsAutoStart.set(!fsAutoStart.get())
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("ui-mode-toggle", () => {
            uiMode.set(uiMode.get() === "simple" ? "advanced" : "simple")
            $storage.set("ui.mode", uiMode.get())
            if (uiMode.get() === "simple") simpleSetup()
            tray.update()
        })
        ctx.registerEventHandler("fs-simple-setup", () => simpleSetup())
        ctx.registerEventHandler("fs-save", () => {
            fsHost.set((fsHostRef.current || "").trim() || FS_DEFAULT_HOST)
            fsPort.set((fsPortRef.current || "").trim() || FS_DEFAULT_PORT)
            fsSession.set((fsSessionRef.current || "").trim() || FS_DEFAULT_SESSION)
            fsPersist()
            ctx.toast.success("Saved FlareSolverr settings")
            void fsRefresh()
        })

        function errorRows(): any[] {
            const list = errors.get()
            const rows: any[] = []
            rows.push(tray.text("Reported errors: " + list.length))
            if (list.length === 0) {
                rows.push(tray.text("No errors reported yet."))
            } else {
                const recent = list.slice(Math.max(0, list.length - 25)).reverse()
                for (let i = 0; i < recent.length; i++) rows.push(tray.text(sehLabel(recent[i])))
                rows.push(tray.button({ label: "Clear", onClick: "seh-clear", intent: "alert", size: "sm" }))
            }
            rows.push(tray.text("Seanime server URL"))
            rows.push(tray.input({ fieldRef: appRef, placeholder: SEH_DEFAULT_APP }))
            rows.push(tray.button({ label: "Save", onClick: "seh-save", intent: "primary", size: "sm" }))
            return rows
        }

        function fsStatusLabel(): string {
            const st = fsStatus.get()
            if (st === "up") return "Running — " + fsBase()
            if (st === "starting") return "Starting…"
            if (st === "down") return "Not running"
            return "Checking…"
        }

        function cfRows(): any[] {
            const rows: any[] = []
            rows.push(tray.text(fsStatusLabel()))
            if (fsNote.get()) rows.push(tray.text(fsNote.get()))
            if (uiMode.get() !== "advanced") {
                const up = fsStatus.get() === "up"
                rows.push(tray.text(up ? "Cloudflare bypass is ready — nothing to configure." : "Cloudflare bypass is set up automatically. If it stays down, install Docker or use a Chrome-equipped machine."))
                rows.push(tray.flex([
                    tray.button({ label: up ? "Re-check" : "Re-run setup", onClick: "fs-simple-setup", intent: "success", size: "sm" }),
                    tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray", size: "sm" }),
                ]))
                return rows
            }
            rows.push(tray.button({ label: "← Simple mode", onClick: "ui-mode-toggle", intent: "gray", size: "sm" }))
            rows.push(tray.text("Launch mode: " + fsMode.get()))
            rows.push(tray.flex([
                tray.button({ label: "Remote", onClick: "fs-mode-remote", intent: fsMode.get() === "remote" ? "primary" : "gray", size: "sm" }),
                tray.button({ label: "Docker", onClick: "fs-mode-docker", intent: fsMode.get() === "docker" ? "primary" : "gray", size: "sm" }),
                tray.button({ label: "Binary", onClick: "fs-mode-binary", intent: fsMode.get() === "binary" ? "primary" : "gray", size: "sm" }),
            ]))
            rows.push(tray.flex([
                tray.button({ label: "Start", onClick: "fs-start", intent: "success", size: "sm" }),
                tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm" }),
                tray.button({ label: "Refresh", onClick: "fs-refresh", intent: "gray", size: "sm" }),
            ]))
            rows.push(
                tray.button({
                    label: fsAutoStart.get() ? "Auto-start on launch: ON" : "Auto-start on launch: OFF",
                    onClick: "fs-autostart-toggle",
                    intent: fsAutoStart.get() ? "primary" : "gray",
                    size: "sm",
                }),
            )
            if (fsAutoStart.get() && fsMode.get() === "remote") rows.push(tray.text("Auto-start needs Docker or Binary mode — Remote points at a solver you run yourself."))
            const ss = fsSessions.get()
            rows.push(tray.text("Sessions: " + (ss.length ? ss.join(", ") : "none")))
            rows.push(tray.button({ label: "Create \"" + (fsSession.get() || FS_DEFAULT_SESSION) + "\" session", onClick: "fs-create-session", intent: "gray", size: "sm" }))
            rows.push(tray.text("Host / Port"))
            rows.push(tray.input({ fieldRef: fsHostRef, placeholder: FS_DEFAULT_HOST }))
            rows.push(tray.input({ fieldRef: fsPortRef, placeholder: FS_DEFAULT_PORT }))
            rows.push(tray.text("Default session name"))
            rows.push(tray.input({ fieldRef: fsSessionRef, placeholder: FS_DEFAULT_SESSION }))
            rows.push(tray.button({ label: "Save", onClick: "fs-save", intent: "primary", size: "sm" }))
            return rows
        }

        tray.render(() => {
            const rows: any[] = []
            rows.push(tray.flex([
                tray.button({ label: "Errors (" + errors.get().length + ")", onClick: "view-errors", intent: view.get() === "errors" ? "primary" : "gray", size: "sm" }),
                tray.button({ label: "Cloudflare", onClick: "view-cf", intent: view.get() === "cf" ? "primary" : "gray", size: "sm" }),
            ]))
            const section = view.get() === "cf" ? cfRows() : errorRows()
            for (let i = 0; i < section.length; i++) rows.push(section[i])
            return tray.stack({ items: rows, gap: 3 })
        })

        ctx.jobs.poll("aqua-seh-poll", sehPoll, SEH_POLL_MS, { immediate: true })
        ctx.jobs.poll("aqua-fs-poll", fsRefresh, FS_POLL_MS, { immediate: true })

        if (uiMode.get() !== "advanced") {
            simpleSetup()
        } else if (fsAutoStart.get() && fsMode.get() !== "remote") {
            void fsRefresh().then(() => {
                if (fsStatus.get() !== "up") fsStart()
            })
        }
    })
}
