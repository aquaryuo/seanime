type SehError = { id: string; t: number; ext: string; scope: string; msg: string }

function init() {
    $ui.register((ctx) => {
        const SEH_MARKER = "SEHERRv1"
        const SEH_MAX_KEEP = 100
        const SEH_MAX_SEEN = 500
        const SEH_POLL_MS = 6000
        const SEH_TTL = 21600000
        const SEH_DEFAULT_APP = "http://127.0.0.1:43211"
        const FS_CONTAINER = "solver"
        const SOLVER_REPO = "aquaryuo/seanime"
        const SOLVER_VERSION = "0.1.52"
        const FS_VERSION = SOLVER_VERSION
        const FS_DEFAULT_HOST = "127.0.0.1"
        const FS_DEFAULT_PORT = "8191"
        const FS_DEFAULT_SESSION = "seanime"
        const FS_POLL_MS = 5000

        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return (v === undefined || v === null) ? d : v } catch (_e) { return d }
        }

        const view = ctx.state<string>("cf")
        const uiMode = ctx.state<string>(sget<string>("ui.mode", "simple"))

        const appBase = ctx.state<string>(sget<string>("seh.appBase", SEH_DEFAULT_APP))
        const errors = ctx.state<SehError[]>(sget<SehError[]>("seh.errors", []))
        const seen = ctx.state<string[]>(sget<string[]>("seh.seen", []))
        const notify = ctx.state<boolean>(sget<boolean>("seh.notify", false))
        const appRef = ctx.fieldRef<string>(appBase.get())
        let sehAuthWarned = false

        const _storedMode = sget<string>("fs.mode", "")
        const fsMode = ctx.state<string>((!_storedMode || _storedMode === "native" || _storedMode === "docker") ? "binary" : _storedMode)
        const fsHost = ctx.state<string>(sget<string>("fs.host", FS_DEFAULT_HOST))
        const fsPort = ctx.state<string>(sget<string>("fs.port", FS_DEFAULT_PORT))
        const fsSession = ctx.state<string>(sget<string>("fs.session", FS_DEFAULT_SESSION))
        const fsAutoStart = ctx.state<boolean>(sget<boolean>("fs.autoStart", false))
        const fsWantChromium = ctx.state<boolean>(sget<boolean>("fs.wantChromium", false))
        const fsAutoUpdate = ctx.state<boolean>(sget<boolean>("fs.autoUpdate", false))
        const fsBrowserMode = ctx.state<string>(sget<string>("fs.browserMode", "headless"))
        const fsEngine = ctx.state<string>(sget<string>("fs.engine", "webview2"))
        const fsWv2Warm = ctx.state<boolean>(sget<boolean>("fs.wv2warm", true))
        const fsWv2Refresh = ctx.state<boolean>(sget<boolean>("fs.wv2refresh", false))
        const fsWv2Utls = ctx.state<boolean>(sget<boolean>("fs.wv2utls", false))
        const fsDns = ctx.state<string>(sget<string>("fs.dns", "off"))
        const fsDnsCustom = ctx.state<string>(sget<string>("fs.dnsCustom", ""))
        const fsPacing = ctx.state<boolean>(sget<boolean>("fs.pacing", false))
        const fsVerbose = ctx.state<boolean>(sget<boolean>("fs.verbose", false))
        const fsCustomTls = ctx.state<boolean>(sget<boolean>("fs.customTls", false))
        const fsMetrics = ctx.state<any>(null)
        const fsStatus = ctx.state<string>("unknown")
        const fsSessions = ctx.state<string[]>([])
        const fsNote = ctx.state<string>("")
        const fsHostRef = ctx.fieldRef<string>(fsHost.get())
        const fsPortRef = ctx.fieldRef<string>(fsPort.get())
        const fsSessionRef = ctx.fieldRef<string>(fsSession.get())
        const fsDnsCustomRef = ctx.fieldRef<string>(fsDnsCustom.get())
        let fsBusy = false
        let fsBinary: $os.Cmd | null = null
        let fsStartTicks = 0
        let fsBinaryGen = 0
        let fsBadStarts = 0
        let fsAvBlocked = sget<boolean>("fs.avBlocked", false)
        let fsDownloadId = ""
        let fsLastOut = ""
        let fsCleanOut = ""
        let fsPollSkip = false
        let fsRestarting = false
        let fsUpSince = 0
        let fsDownStreak = 0
        let fsTesting = false
        let fsTestUntil = 0
        let fsLastLiveUpdate = 0
        let fsManualStop = sget<boolean>("fs.manualStop", false)
        let fsAutoUpgradeTried = false
        let fsChromiumAutoChecked = false
        const fsNotified: { [k: string]: boolean } = {}
        const dl = (ctx as any).downloader
        const fsErr = ctx.state<string>("")
        const fsHint = ctx.state<string>("")
        const fsVersion = ctx.state<string>("")
        const fsTest = ctx.state<string>("")
        const fsLogFilter = ctx.state<boolean>(true)
        const fsConsent = ctx.state<boolean>(sget<boolean>("fs.consent", false))
        let sehGroups: { key: string; label: string; count: number; t: number }[] = []

        function nowMs(): number {
            try {
                return Date.now()
            } catch (_e) {
                return 0
            }
        }

        function scrubLog(s: string): string {
            if (!s) return s
            return s
                .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>)\]]+/gi, "$1://<redacted>")
                .replace(/[A-Z]:\\Users\\[^\\\s"']+/gi, "C:\\Users\\<redacted>")
                .replace(/\/(?:home|Users)\/[^/\s"']+/g, "/<redacted>")
                .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
                .replace(/\b[0-9a-f]{20,}\b/gi, "<redacted>")
                .replace(/[A-Za-z0-9_-]{32,}={0,2}/g, "<redacted>")
        }

        function logAppend(prev: string, chunk: string): string {
            if (!chunk) return prev
            const piece = chunk.charAt(chunk.length - 1) === "\n" ? chunk : chunk + "\n"
            return (prev + piece).slice(-12000)
        }

        function isPollingLine(l: string): boolean {
            const isPoll = l.indexOf("sessions.list") >= 0 || l.indexOf("sessions.create") >= 0
            if (l.indexOf("Incoming request") >= 0) { fsPollSkip = isPoll; return isPoll }
            if (isPoll) { fsPollSkip = true; return true }
            if (fsPollSkip) {
                fsPollSkip = false
                if (l.indexOf("Response in") >= 0 || l.indexOf("200 OK") >= 0 || l.indexOf("POST http") >= 0) return true
            }
            return false
        }

        function pushLog(chunk: string): void {
            if (!chunk) return
            const c = scrubLog(chunk)
            fsLastOut = logAppend(fsLastOut, c)
            const lines = c.split("\n")
            let clean = ""
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i]
                if (!l) continue
                if (!isPollingLine(l)) clean += l + "\n"
            }
            if (clean) fsCleanOut = logAppend(fsCleanOut, clean)
        }

        function hhmmss(ms: number): string {
            try {
                const d = new Date(ms)
                const p = (n: number) => (n < 10 ? "0" + n : "" + n)
                return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
            } catch (_e) {
                return ""
            }
        }

        function plog(msg: string): void {
            if (!msg) return
            const clean = msg.replace(/…/g, "...").replace(/[—–]/g, "-").replace(/·/g, "|").replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "")
            if (!clean) return
            const t = hhmmss(nowMs())
            pushLog((t ? t + " " : "") + "[plugin] " + clean + "\n")
        }

        function setNote(msg: string): void {
            fsNote.set(msg)
            plog(msg)
        }

        function setTest(msg: string): void {
            fsTest.set(msg)
            plog(msg)
        }

        function setErr(msg: string): void {
            fsErr.set(msg)
            fsHint.set("")
            if (msg) plog("error: " + msg)
        }

        let dlLogAt = 0
        function fmtSize(bytes: number): string {
            if (!bytes || bytes < 0) return "0"
            if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + "MB"
            if (bytes >= 1024) return Math.round(bytes / 1024) + "KB"
            return bytes + "B"
        }
        function dlProgress(label: string, p: $downloader.DownloadProgress): void {
            const pct = Math.round(p.percentage || 0)
            fsNote.set(label + " " + pct + "%")
            const now = nowMs()
            if (now && dlLogAt && now - dlLogAt < 2500) return
            dlLogAt = now || 1
            const got = p.totalBytes || 0, tot = p.totalSize || 0, spd = p.speed || 0
            let line = label + " " + pct + "%"
            if (got || tot) line += " (" + fmtSize(got) + (tot ? " of " + fmtSize(tot) : "") + (spd ? ", " + fmtSize(spd) + "/s" : "") + ")"
            else line += spd ? " (" + fmtSize(spd) + "/s)" : " (connecting…)"
            plog(line)
        }

        function setStatus(next: string): void {
            const s = fsStatus
            const prev = s.get()
            s.set(next)
            if (next !== prev) plog("solver " + next)
            fsStartTicks = 0
            if (next === "up") {
                setNote("")
                setErr("")
                fsRestarting = false
                fsBadStarts = 0
                fsAvBlocked = false
                try { $storage.set("fs.avBlocked", false) } catch (_e) {}
                if (!fsUpSince) fsUpSince = nowMs()
                fsNotified["down"] = false
                fsNotified["crash"] = false
                if (!solverUpdatePending()) { fsAutoUpgradeTried = false; fsNotified["upd"] = false; fsNotified["upg"] = false }
            } else if (next === "starting") {
                setErr("")
                fsUpSince = 0
            } else {
                fsRestarting = false
                fsUpSince = 0
            }
        }

        function notifyOnce(key: string, msg: string): void {
            if (fsNotified[key]) return
            fsNotified[key] = true
            try { ctx.notification.send(msg) } catch (_e) {}
        }

        function maybeAutoUpdateChromium(): void {
            if (fsChromiumAutoChecked) return
            fsChromiumAutoChecked = true
            if (!chromiumDownloadedHere()) return
            const plt = chromiumCfTPlatform()
            if (!plt || !downloaderReady()) return
            void chromiumStable(plt).then((st) => {
                if (!st.version) return
                const cur = $storage.get<string>("fs.chromiumVer") || ""
                if (cur && verNewer(st.version, cur)) updateChromium()
            })
        }

        function refreshTrayBadge(): void {
            try {
                if (fsStatus.get() === "down" && !fsManualStop && fsMode.get() !== "remote") { tray.updateBadge({ number: 1, intent: "error" }); return }
                if (solverUpdatePending()) { tray.updateBadge({ number: 1, intent: "info" }); return }
                tray.updateBadge({ number: errors.get().length, intent: "warning" })
            } catch (_e) {}
        }

        function buildDiagnostics(): string {
            const out: string[] = ["aquatils diagnostics"]
            try { out.push("os=" + ($os.platform || "?") + "/" + ($os.arch || "?")) } catch (_e) { out.push("os=unavailable (strict mode?)") }
            out.push("mode=" + fsMode.get())
            out.push("endpoint=" + fsBase() + "/v1")
            out.push("status=" + fsStatus.get())
            out.push("solver: bundled=" + SOLVER_VERSION + " running=" + (fsVersion.get() || "?"))
            try { out.push("downloaded: solver=" + binaryDownloaded() + " chromium=" + (chromiumDownloadedHere() ? chromiumCachedVersion() : "none")) } catch (_e) {}
            const err = fsErr.get()
            if (err) out.push("lastError=" + err)
            const note = fsNote.get()
            if (note && note !== err) out.push("note=" + note)
            const log = currentLog()
            if (log) { out.push("--- log tail ---"); out.push(log.split("\n").slice(-30).join("\n")) }
            return out.join("\n")
        }

        // Tall-but-detached floating modal: leaves a gap above and below so it reads as
        // a floating panel on the side rather than a flush full-height drawer. Matches the
        // fixed wrapper gaps below (4.5rem top + 4.5rem bottom = 9rem).
        const PANEL_H = "calc(100dvh - 9rem)"
        // Accent gradient matched to the plugin icon (warm orange -> gold sunburst).
        const ACCENT_GRAD = "linear-gradient(135deg, rgba(242,145,47,0.9), rgba(255,200,64,0.9))"
        const ACCENT_STYLE: Record<string, string> = { background: ACCENT_GRAD, border: "none", color: "#1c1407", fontWeight: "600" }
        const ACCENT_SUBTLE: Record<string, string> = { background: "linear-gradient(135deg, rgba(242,145,47,0.20), rgba(255,200,64,0.20))", border: "1px solid rgba(255,200,64,0.35)", color: "#FFC840", fontWeight: "500" }
        const ICON_FS = "18px"
        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/aquatils/icon.png",
            withContent: true,
            width: "480px",
            minHeight: PANEL_H,
        })

        // Seanime wraps plugin tray content in a div capped at max-h-[35rem] (560px) with
        // its own scroll. tray.css is scoped to siblings/children so it can't reach that
        // ancestor — use the DOM API to lift the cap to the panel height, and detach the
        // popover from the edges so it floats.
        function styleEls(els: any[], pairs: [string, string][]): void {
            for (let i = 0; i < els.length; i++) {
                for (let j = 0; j < pairs.length; j++) {
                    try { els[i].setStyle(pairs[j][0], pairs[j][1]) } catch (_e) {}
                }
            }
        }
        // Pin the panel as a FIXED floating modal with explicit gaps. Margins on the
        // content don't work — Radix sizes/positions a wrapper element (the content's
        // parent), so we neutralise its transform and fix it in place. top/bottom are
        // exact; LEFT is the sidebar width + gap (tune this one value if needed).
        const PANEL_TOP = "4.5rem", PANEL_BOTTOM = "4.5rem", PANEL_LEFT = "6rem"
        try {
            if (ctx.dom && ctx.dom.observe) {
                ctx.dom.observe('[data-plugin-tray-popover-content="aquatils"] [class*="max-h-[35rem]"]', (els) => {
                    styleEls(els, [["max-height", PANEL_H], ["maxHeight", PANEL_H], ["padding", "0px"]])
                })
                ctx.dom.observe('[data-plugin-tray-popover-content="aquatils"]', (els) => {
                    // bg-gray-950 here is opaque — it becomes the panel's backdrop, so the
                    // blur shows solid gray instead of the app. Make it transparent so the
                    // backdrop-filter actually frosts the page behind the modal.
                    styleEls(els, [["margin", "0"], ["max-height", "none"], ["maxHeight", "none"], ["background", "transparent"], ["box-shadow", "none"], ["boxShadow", "none"]])
                    for (let i = 0; i < els.length; i++) {
                        try {
                            const p = els[i].getParent()
                            if (p && p.then) {
                                p.then((wrapper) => {
                                    if (!wrapper) return
                                    styleEls([wrapper], [
                                        ["transform", "none"], ["position", "fixed"],
                                        ["top", PANEL_TOP], ["bottom", PANEL_BOTTOM],
                                        ["left", PANEL_LEFT], ["right", "auto"], ["margin", "0"],
                                    ])
                                }).catch(() => {})
                            }
                        } catch (_e) {}
                    }
                })
            }
        } catch (_e) {}

        function sehPersist(): void {
            try {
                $storage.set("seh.errors", errors.get())
                $storage.set("seh.seen", seen.get())
                $storage.set("seh.appBase", appBase.get())
                $storage.set("seh.notify", notify.get())
            } catch (_e) {}
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
            if (notify.get()) {
                for (let i = 0; i < fresh.length; i++) {
                    ctx.toast.error(sehLabel(fresh[i]))
                    try {
                        ctx.notification.send(sehLabel(fresh[i]))
                    } catch (_e) {}
                }
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
            try {
                $storage.set("fs.mode", fsMode.get())
                $storage.set("fs.host", fsHost.get())
                $storage.set("fs.port", fsPort.get())
                $storage.set("fs.session", fsSession.get())
                $storage.set("fs.autoStart", fsAutoStart.get())
                $storage.set("fs.wantChromium", fsWantChromium.get())
                $storage.set("fs.autoUpdate", fsAutoUpdate.get())
                $storage.set("fs.browserMode", fsBrowserMode.get())
                $storage.set("fs.engine", fsEngine.get())
                $storage.set("fs.wv2warm", fsWv2Warm.get())
                $storage.set("fs.wv2refresh", fsWv2Refresh.get())
                $storage.set("fs.wv2utls", fsWv2Utls.get())
                $storage.set("fs.dns", fsDns.get())
                $storage.set("fs.dnsCustom", fsDnsCustom.get())
                $storage.set("fs.pacing", fsPacing.get())
                $storage.set("fs.verbose", fsVerbose.get())
                $storage.set("fs.customTls", fsCustomTls.get())
                $storage.set("fs.consent", fsConsent.get())
            } catch (_e) {}
        }

        async function fsApi(cmd: string, extra: { [k: string]: any }, timeoutSec?: number): Promise<any> {
            try {
                const res = await ctx.fetch(fsBase() + "/v1", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(Object.assign({ cmd: cmd }, extra || {})),
                    timeout: timeoutSec || 25,
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

        async function fsProbe(): Promise<{ up: boolean; version?: string; sessions?: string[] }> {
            try {
                const res = await ctx.fetch(fsBase() + "/v1", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ cmd: "sessions.list" }),
                    timeout: 10,
                })
                let data: any = null
                try { data = res.json<any>() } catch (_e) {}
                return {
                    up: true,
                    version: data && data.version ? String(data.version) : undefined,
                    sessions: data && Array.isArray(data.sessions) ? data.sessions : undefined,
                }
            } catch (_e) {
                return { up: false }
            }
        }

        async function fsRefresh(): Promise<void> {
            if (fsTesting && nowMs() < fsTestUntil) return
            const p = await fsProbe()
            if (p.up) {
                if (p.version) fsVersion.set(p.version)
                setStatus("up")
                fsDownStreak = 0
                if (uiMode.get() === "advanced" && view.get() === "cf" && fsMode.get() !== "remote") {
                    const mr = await fsApi("metrics", {}, 8)
                    if (mr && mr.metrics) fsMetrics.set(mr.metrics)
                }
                if (p.sessions) {
                    fsSessions.set(p.sessions)
                    if (fsSession.get() && p.sessions.indexOf(fsSession.get()) < 0) await fsEnsureSession()
                }
                if (solverUpdatePending() && fsMode.get() !== "remote" && !fsManualStop) {
                    if (fsAutoUpdate.get() && !fsAutoUpgradeTried) {
                        fsAutoUpgradeTried = true
                        notifyOnce("upg", "Aqua's Utils: auto-updating the solver to v" + SOLVER_VERSION + " — click Allow if Seanime asks.")
                        try { ctx.toast.info("Auto-updating the solver to v" + SOLVER_VERSION + " — click Allow if Seanime asks.") } catch (_e) {}
                        plog("auto-updating solver to v" + SOLVER_VERSION + " (was v" + (fsVersion.get() || "?") + ")")
                        fsStart()
                    } else if (!fsAutoUpdate.get()) {
                        if (solverAdoptedStale()) {
                            notifyOnce("orphan", "Aqua's Utils: a leftover solver from a previous install is still running — open the tray to Restart or Stop it.")
                        } else {
                            notifyOnce("upd", "Aqua's Utils: a newer solver (v" + SOLVER_VERSION + ") is ready — open the tray and tap Restart to update.")
                        }
                    }
                }
                if (fsAutoUpdate.get() && fsMode.get() !== "remote") maybeAutoUpdateChromium()
            } else {
                if (fsStatus.get() === "starting") {
                    if (fsMode.get() === "binary" && !fsDownloadId) {
                        fsStartTicks++
                        if (fsStartTicks >= 18) {
                            setStatus("down")
                            const why = cleanTail(fsLastOut) || readLogTail(fsLogPath())
                            setErr(fsLastOut || why || "The solver didn't come up in time.")
                            setNote("The solver didn't come up" + (why ? ": " + why : "") + ".")
                        }
                    }
                } else {
                    fsDownStreak++
                    if (fsDownStreak >= 2) {
                        setStatus("down")
                        fsSessions.set([])
                        if (fsDownStreak === 2 && fsAutoStart.get() && !fsManualStop && fsMode.get() !== "remote" && !fsAvBlocked && !solverQuarantined()) {
                            setNote("Solver stopped — auto-restarting…")
                            fsStart()
                        } else if (fsDownStreak === 2 && !fsManualStop && fsMode.get() !== "remote" && (fsAvBlocked || solverQuarantined())) {
                            notifyOnce("av", "Aqua's Utils: antivirus removed the solver. Add an exclusion for %LOCALAPPDATA%\\aquatils, then Start.")
                        } else if (fsDownStreak === 2 && !fsManualStop && fsMode.get() !== "remote") {
                            notifyOnce("down", "Aqua's Utils: the solver isn't running. Open the tray to start it.")
                        }
                    }
                }
            }
            if (fsStatus.get() !== "starting") fsRestarting = false
            refreshTrayBadge()
            refreshAnimeBtn()
            tray.update()
        }

        async function runTest(): Promise<void> {
            fsTesting = true
            fsTestUntil = nowMs() + 70000
            try {
                setTest("Testing…")
                tray.update()
                const ping = await fsProbe()
                if (!ping.up) {
                    setTest("Not reachable at " + fsBase() + " — it may still be starting; wait for the green Running badge.")
                    tray.update()
                    return
                }
                if (ping.version) fsVersion.set(ping.version)
                setStatus("up")
                fsDownStreak = 0
                tray.update()
                const extra: { [k: string]: any } = { url: "https://nowsecure.nl", maxTimeout: 32000 }
                if (ping.sessions) {
                    const sess = (fsSession.get() || FS_DEFAULT_SESSION).trim()
                    if (sess) {
                        if (ping.sessions.indexOf(sess) < 0) await fsApi("sessions.create", { session: sess })
                        extra.session = sess
                    }
                }
                const t0 = nowMs()
                const r = await fsApi("request.get", extra, 55)
                const dt = t0 ? Math.round((nowMs() - t0) / 1000) : 0
                if (r && r.status === "ok") {
                    setTest("Cloudflare test passed" + (fsVersion.get() ? " · v" + fsVersion.get() : "") + (dt ? " · " + dt + "s" : ""))
                } else if (r && r.message) {
                    setTest("Reachable, but couldn't clear Cloudflare: " + String(r.message))
                } else {
                    setTest("Reachable (v" + (fsVersion.get() || "?") + ") but the Cloudflare test timed out — the browser may still be warming up. Try again in a moment.")
                }
                tray.update()
            } finally {
                fsTesting = false
            }
        }

        async function runDoctor(): Promise<void> {
            const lines: string[] = []
            let cacheOk = false
            try {
                cacheOk = typeof $os !== "undefined" && !!$os.cacheDir()
            } catch (_e) {}
            lines.push((cacheOk ? "✓" : "✗") + " cache dir")
            const ping = await fsProbe()
            if (ping.up) lines.push("✓ solver responding on " + fsPort.get())
            else lines.push("• port " + fsPort.get() + " not responding")
            try {
                const pick = binaryAsset()
                if (pick) {
                    const bin = $filepath.join($os.cacheDir(), "aquatils", FS_VERSION, FS_CONTAINER, pick.bin)
                    let binOk = false
                    try {
                        binOk = !!$os.stat(bin)
                    } catch (_e) {}
                    lines.push((binOk ? "✓ binary downloaded" : "• binary not downloaded yet"))
                } else {
                    lines.push("• binary: unsupported OS/arch — use Remote mode")
                }
            } catch (_e) {
                lines.push("• binary: filesystem unavailable (strict mode?)")
            }
            setTest(lines.join("  ·  "))
            tray.update()
        }

        async function runStealthCheck(): Promise<void> {
            setTest("Running stealth check…")
            tray.update()
            const r = await fsApi("selftest", {}, 30)
            if (!r) {
                setTest("Solver not reachable — start it, then try again.")
                tray.update()
                return
            }
            const st = r.selfTest
            if (!st) {
                setTest("Stealth check failed" + (r.message ? ": " + String(r.message) : "") + ".")
                tray.update()
                return
            }
            const lines: string[] = []
            lines.push((st.ok ? "✓ Looks like Chrome" : "✗ Fingerprint mismatch"))
            const checks = Array.isArray(st.checks) ? st.checks : []
            checks.forEach((c: any) => lines.push((c.pass ? "✓ " : "✗ ") + String(c.name) + (c.pass ? "" : "  (" + String(c.got || "") + ")")))
            if (st.ja4) lines.push("JA4  " + String(st.ja4))
            if (st.akamai) lines.push("HTTP2  " + String(st.akamai))
            if (st.note) lines.push(String(st.note))
            setTest(lines.join("\n"))
            tray.update()
        }

        function binaryAsset(): { asset: string; zip: boolean; bin: string } | null {
            const p = "solver-browser_"
            if ($os.platform === "linux" && $os.arch === "amd64") return { asset: p + "linux_x64.tar.gz", zip: false, bin: "solver" }
            if ($os.platform === "linux" && $os.arch === "arm64") return { asset: p + "linux_arm64.tar.gz", zip: false, bin: "solver" }
            if ($os.platform === "darwin" && $os.arch === "amd64") return { asset: p + "darwin_x64.tar.gz", zip: false, bin: "solver" }
            if ($os.platform === "darwin" && $os.arch === "arm64") return { asset: p + "darwin_arm64.tar.gz", zip: false, bin: "solver" }
            if ($os.platform === "windows" && $os.arch === "amd64") return { asset: p + "windows_x64.zip", zip: true, bin: "solver.exe" }
            return null
        }

        function solverBinPath(): string {
            try {
                const pick = binaryAsset()
                if (!pick) return ""
                return $filepath.join($os.cacheDir(), "aquatils", FS_VERSION, FS_CONTAINER, pick.bin)
            } catch (_e) {
                return ""
            }
        }

        function solverBinExists(): boolean {
            const p = solverBinPath()
            if (!p) return false
            try { return !!$os.stat(p) } catch (_e) { return false }
        }

        function binaryDownloaded(): boolean {
            if (!solverBinExists()) return false
            try { return $storage.get<string>("fs.solverReady") === FS_VERSION } catch (_e) { return false }
        }

        function solverPrevInstalled(): boolean {
            try { const v = ($storage.get<string>("fs.solverReady") || "").trim(); return v !== "" && v !== FS_VERSION } catch (_e) { return false }
        }

        // The current version was downloaded + verified (marker set) but the binary
        // file is now gone — i.e. antivirus quarantined it, not a missing/old install.
        function solverQuarantined(): boolean {
            try { return $storage.get<string>("fs.solverReady") === FS_VERSION && !solverBinExists() } catch (_e) { return false }
        }

        function fsLogPath(): string {
            try {
                return $filepath.join($os.cacheDir(), "aquatils", FS_VERSION, "solver.log")
            } catch (_e) {
                return ""
            }
        }

        function cleanTail(text: string): string {
            const lines = text.split("\n")
            const out: string[] = []
            for (let i = lines.length - 1; i >= 0 && out.length < 3; i--) {
                const t = lines[i].replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim()
                if (t && t.indexOf("[plugin]") < 0) out.unshift(t)
            }
            return scrubLog(out.join(" | ")).slice(-220)
        }

        function readLogTail(p: string): string {
            if (!p) return ""
            try {
                return cleanTail($toString($os.readFile(p)))
            } catch (_e) {
                return ""
            }
        }

        function readLogFull(p: string): string {
            if (!p) return ""
            try {
                const raw = $toString($os.readFile(p)).replace(/\r/g, "").replace(/[^\x20-\x7E\n]+/g, " ")
                return scrubLog(raw.slice(-262144)).replace(/^\n+/, "").replace(/\n+$/, "")
            } catch (_e) {
                return ""
            }
        }

        let chromiumOverride = ""

        function chromiumCfTPlatform(): string {
            if (typeof $os === "undefined") return ""
            if ($os.platform === "windows" && $os.arch === "amd64") return "win64"
            if ($os.platform === "linux" && $os.arch === "amd64") return "linux64"
            if ($os.platform === "darwin" && $os.arch === "amd64") return "mac-x64"
            if ($os.platform === "darwin" && $os.arch === "arm64") return "mac-arm64"
            return ""
        }

        function chromiumBinRel(plt: string): string {
            if (plt === "win64") return $filepath.join("chrome-win64", "chrome.exe")
            if (plt === "linux64") return $filepath.join("chrome-linux64", "chrome")
            if (plt === "mac-x64") return $filepath.join("chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
            if (plt === "mac-arm64") return $filepath.join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
            return ""
        }

        function chromiumCachedPath(): string {
            const plt = chromiumCfTPlatform()
            if (!plt) return ""
            const rel = chromiumBinRel(plt)
            if (!rel) return ""
            try {
                const p = $filepath.join($os.cacheDir(), "aquatils", "chromium", rel)
                if ($os.stat(p)) return p
            } catch (_e) {}
            return ""
        }

        function verNewer(a: string, b: string): boolean {
            const pa = (a || "").split(".")
            const pb = (b || "").split(".")
            const n = Math.max(pa.length, pb.length)
            for (let i = 0; i < n; i++) {
                const x = parseInt(pa[i] || "0", 10) || 0
                const y = parseInt(pb[i] || "0", 10) || 0
                if (x > y) return true
                if (x < y) return false
            }
            return false
        }

        async function chromiumStable(plt: string): Promise<{ version: string; url: string }> {
            try {
                const res = await ctx.fetch("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json", { method: "GET", timeout: 20 })
                if (!res.ok) return { version: "", url: "" }
                const data = res.json<any>()
                const stable = data && data.channels && data.channels.Stable ? data.channels.Stable : null
                const version = stable && stable.version ? String(stable.version) : ""
                let url = ""
                const dls = stable && stable.downloads ? stable.downloads["chrome"] : null
                if (Array.isArray(dls)) { for (const d of dls) { if (d && d.platform === plt && d.url) { url = String(d.url); break } } }
                return { version: version, url: url }
            } catch (_e) {}
            return { version: "", url: "" }
        }

        function chromiumCachedVersion(): string {
            return chromiumDownloadedHere() ? ($storage.get<string>("fs.chromiumVer") || "?") : ""
        }

        function downloadChromium(st: { version: string; url: string }, done: (ok: boolean) => void): void {
            const dir = $filepath.join($os.cacheDir(), "aquatils", "chromium")
            try { $os.removeAll(dir) } catch (_e) {}
            try { $os.mkdirAll(dir, 493) } catch (_e) {}
            const zip = $filepath.join(dir, "chrome.zip")
            let id = ""
            try { id = dl.download(st.url, zip) } catch (_e) { setErr("Chromium download couldn't start: " + String(_e)); done(false); return }
            plog("downloading Chromium" + (st.version ? " " + st.version : "") + " (Stage B browser)")
            dlLogAt = 0
            const cancel = dl.watch(id, (p: $downloader.DownloadProgress | undefined) => {
                if (!p) return
                if (p.status === "downloading") {
                    dlProgress("Downloading Chromium", p)
                    tray.update()
                } else if (p.status === "completed") {
                    cancel()
                    plog("extracting Chromium…")
                    let unzipOk = true
                    try { $osExtra.unzip(zip, dir) } catch (_e) { unzipOk = false }
                    try { $os.removeAll(zip) } catch (_e) {}
                    const ok = unzipOk && chromiumCachedPath() !== ""
                    if (ok && st.version) {
                        try { $storage.set("fs.chromiumVer", st.version) } catch (_e) {}
                    } else {
                        try { $os.removeAll(dir) } catch (_e) {}
                        try { $storage.set("fs.chromiumVer", "") } catch (_e) {}
                        setErr("Chromium download/extract failed — Stage B (hard challenges) will be unavailable.")
                        tray.update()
                    }
                    done(ok)
                } else if (p.status === "error") {
                    cancel()
                    setErr("Chromium download failed: " + (p.error || "unknown error"))
                    done(false)
                }
            })
        }

        function ensureChromium(cb: (path: string) => void): void {
            const cached = chromiumCachedPath()
            if (cached) { cb(cached); return }
            if (!fsWantChromium.get()) { cb(""); return }
            const plt = chromiumCfTPlatform()
            if (!plt || !downloaderReady()) { cb(""); return }
            setNote("Fetching a minimal Chromium…")
            tray.update()
            void chromiumStable(plt).then((st) => {
                if (!st.url) { setErr("Couldn't find a Chromium download for this platform (" + plt + ") in the release feed; starting without Stage B."); tray.update(); cb(""); return }
                downloadChromium(st, (ok) => cb(ok ? chromiumCachedPath() : ""))
            })
        }

        function updateChromium(): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined" || !dl) { setNote("Not available in strict secure mode."); tray.update(); return }
            const plt = chromiumCfTPlatform()
            if (!plt) { setNote("Chromium isn't available on this OS/arch."); tray.update(); return }
            if (!chromiumDownloadedHere()) { setNote("No Chromium is downloaded — it's fetched on demand."); tray.update(); return }
            if (!downloaderReady()) { setNote("Chromium update isn't available here."); tray.update(); return }
            setNote("Checking for a newer Chromium…")
            tray.update()
            void chromiumStable(plt).then((st) => {
                if (!st.version || !st.url) { setNote("Couldn't reach the Chromium release feed."); tray.update(); return }
                const cur = $storage.get<string>("fs.chromiumVer") || ""
                if (cur && !verNewer(st.version, cur)) { setNote("Chromium is up to date (" + cur + ")."); tray.update(); return }
                try { $os.removeAll($filepath.join(aquatilsDir(), "chromium")) } catch (_e) {}
                try { $storage.set("fs.chromiumVer", "") } catch (_e) {}
                chromiumOverride = ""
                setNote("Updating Chromium…")
                tray.update()
                downloadChromium(st, (ok) => {
                    setNote(ok ? ("Chromium updated to " + st.version + ".") : "Chromium update failed.")
                    tray.update()
                })
            })
        }

        function pruneOldSolverVersions(): void {
            try {
                const base = aquatilsDir()
                let entries: $os.DirEntry[] = []
                try { entries = $os.readDir(base) } catch (_e) { return }
                for (const e of entries) {
                    if (e.isDir() && e.name() !== "chromium" && e.name() !== FS_VERSION) {
                        try { $os.removeAll($filepath.join(base, e.name())) } catch (_e) {}
                    }
                }
            } catch (_e) {}
        }

        function binaryLaunch(binPath: string): void {
            binaryStop(() => {
                pruneOldSolverVersions()
                const gen = fsBinaryGen
                ensureChromium((chromePath) => {
                    if (gen !== fsBinaryGen) return
                    chromiumOverride = chromePath
                    if (gen === fsBinaryGen) binarySpawn(binPath)
                })
            })
        }

        function binarySpawn(binPath: string): void {
            const gen = fsBinaryGen
            const logPath = fsLogPath()
            const port = fsPort.get() || FS_DEFAULT_PORT
            const fsDir = $filepath.join($os.cacheDir(), "aquatils", FS_VERSION, FS_CONTAINER)
            const chrDir = $filepath.join($os.cacheDir(), "aquatils", "chromium")
            const prep = "xattr -dr com.apple.quarantine '" + fsDir + "' 2>/dev/null; chmod -R 755 '" + fsDir + "'; "
                + (chromiumOverride ? "xattr -dr com.apple.quarantine '" + chrDir + "' 2>/dev/null; chmod -R 755 '" + chrDir + "'; " : "")
            const ac = $os.platform === "windows"
                ? $osExtra.asyncCmd("cmd", "/c", binPath)
                : $osExtra.asyncCmd("sh", "-c", prep + "exec '" + binPath + "'")
            const c = ac.getCommand()
            try {
                const env = c.environ()
                env.push("HOST=127.0.0.1")
                env.push("PORT=" + port)
                env.push("LOG_LEVEL=" + (fsVerbose.get() ? "debug" : "info"))
                if (logPath) env.push("LOG_FILE=" + logPath)
                if (chromiumOverride) env.push("SOLVER_CHROME=" + chromiumOverride)
                env.push("SOLVER_BROWSER_MODE=" + (fsBrowserMode.get() || "headless"))
                if (fsEngine.get() && fsEngine.get() !== "chrome") env.push("SOLVER_BROWSER_ENGINE=" + fsEngine.get())
                if (!fsWv2Warm.get()) env.push("SOLVER_WV2_WARM=0")
                if (fsWv2Refresh.get()) env.push("SOLVER_WV2_REFRESH=1")
                if (fsWv2Utls.get()) env.push("SOLVER_WV2_UTLS=1")
                const dnsVal = fsDns.get() === "custom" ? (fsDnsCustom.get() || "").trim() : fsDns.get()
                if (dnsVal && dnsVal !== "off") env.push("SOLVER_DNS=" + dnsVal)
                if (fsPacing.get()) env.push("SOLVER_PACING=1")
                if (fsCustomTls.get()) env.push("SOLVER_TLS=custom")
                env.push("SOLVER_IDLE_EXIT=600")
                c.env = env
            } catch (_e) {}
            fsBinary = c
            plog("starting solver " + SOLVER_VERSION + "…")
            try {
                ac.run((data, err, code, _s) => {
                    if (gen !== fsBinaryGen) return
                    if (err) {
                        try { pushLog($toString(err)) } catch (_e) {}
                    } else if (data) {
                        try { pushLog($toString(data)) } catch (_e) {}
                    }
                    if (code === undefined) {
                        const t = nowMs()
                        if (t - fsLastLiveUpdate >= 250) { fsLastLiveUpdate = t; tray.update() }
                        return
                    }
                    const wasUp = fsStatus.get() === "up"
                    fsBinary = null
                    setStatus("down")
                    fsStartTicks = 0
                    fsRestarting = false
                    if (wasUp && !solverBinExists()) {
                        fsAvBlocked = true
                        try { $storage.set("fs.avBlocked", true) } catch (_e) {}
                        plog("antivirus removed the solver (binary quarantined while running)")
                        setErr("Antivirus (e.g. Windows Defender) removed the solver while it was running — it flags the solver as suspicious because it automates a background browser.")
                        fsHint.set("Add a Windows Security exclusion for the aquatils folder (%LOCALAPPDATA%\\aquatils), then press Start.")
                        setNote("Removed by antivirus — add an exclusion for the aquatils folder, then Start.")
                        ctx.toast.error("Antivirus removed the solver — add an exclusion for the aquatils folder.")
                        notifyOnce("av", "Aqua's Utils: antivirus removed the solver. Add an exclusion for %LOCALAPPDATA%\\aquatils, then Start.")
                    } else if (wasUp) {
                        setNote("Solver stopped (code " + code + ").")
                        if (!fsManualStop) notifyOnce("down", "Aqua's Utils: the solver stopped (code " + code + ").")
                    } else {
                        const why = cleanTail(fsLastOut) || readLogTail(logPath)
                        const execBlocked = /cannot execute the specified program|not a valid win32 application|is not recognized as an internal|exec format error|access is denied|contains a virus|operation did not complete successfully/i.test(fsLastOut)
                        const binGone = !solverBinExists()
                        if (execBlocked || binGone) {
                            fsAvBlocked = true
                            try { $storage.set("fs.avBlocked", true) } catch (_e) {}
                            plog("antivirus blocked the solver" + (binGone ? " (binary quarantined/removed while running)" : " (execution blocked)"))
                            setErr("Antivirus (e.g. Windows Defender) " + (binGone ? "removed" : "blocked") + " the solver — it flags the solver as suspicious because it automates a background browser.")
                            fsHint.set("Add a Windows Security exclusion for the aquatils folder (%LOCALAPPDATA%\\aquatils), then press Start.")
                            setNote("Blocked by antivirus — add an exclusion for the aquatils folder, then Start.")
                            ctx.toast.error("Antivirus blocked the solver — add an exclusion for the aquatils folder.")
                            notifyOnce("av", "Aqua's Utils: antivirus blocked the solver. Add an exclusion for %LOCALAPPDATA%\\aquatils, then Start.")
                        } else {
                            plog("solver exited (code " + code + ")" + (why ? " after producing output" : "; no output captured"))
                            if (!why) {
                                fsBadStarts++
                                if (fsBadStarts >= 2) {
                                    plog("removing the solver binary after " + fsBadStarts + " no-output starts — it will re-download")
                                    try { $storage.set("fs.solverReady", "") } catch (_e) {}
                                    try { $os.removeAll($filepath.join($os.cacheDir(), "aquatils", FS_VERSION, FS_CONTAINER)) } catch (_e) {}
                                    setErr("The solver produced no output across repeated starts — re-downloading. Press Start.")
                                    setNote("Re-downloading the solver — press Start.")
                                } else {
                                    setErr("The solver exited (code " + code + ") with no output. Press Start to retry — the download is kept.")
                                    setNote("Solver exited (code " + code + ") — press Start to retry.")
                                }
                            } else {
                                setErr(why)
                                setNote("Solver exited (code " + code + "): " + why)
                            }
                            ctx.toast.error("Solver exited (code " + code + ")")
                            notifyOnce("crash", "Aqua's Utils: the solver failed to start (code " + code + "). Open the tray for details.")
                        }
                    }
                    tray.update()
                })
                setStatus("starting")
                fsStartTicks = 0
                setErr("")
                setNote("Solver started; waiting for it to come up…")
            } catch (_e) {
                fsBinary = null
                setStatus("down")
                setErr(String(_e))
                setNote("Launch failed: " + String(_e))
                ctx.toast.error("Solver launch failed")
            }
            tray.update()
        }

        function binaryStop(done?: () => void): void {
            fsBusy = false
            fsBinaryGen++
            if (dl && fsDownloadId) {
                try {
                    dl.cancel(fsDownloadId)
                } catch (_e) {}
                fsDownloadId = ""
            }
            if (fsBinary && fsBinary.process) {
                try {
                    fsBinary.process.kill()
                } catch (_e) {}
            }
            fsBinary = null
            if (typeof $os !== "undefined" && $os.platform === "windows" && typeof $osExtra !== "undefined") {
                try {
                    $osExtra.asyncCmd("cmd", "/c", "taskkill", "/F", "/T", "/IM", "solver.exe").run((_d, _e, code) => {
                        if (code === undefined) return
                        reapOurChrome(done)
                    })
                    return
                } catch (_e) {}
            }
            if (done) done()
        }

        function reapOurChrome(done?: () => void): void {
            if (typeof $os === "undefined" || $os.platform !== "windows" || typeof $osExtra === "undefined") { if (done) done(); return }
            const ps = "$ErrorActionPreference='SilentlyContinue';foreach($p in Get-CimInstance Win32_Process){if($p.Name -eq 'chrome.exe' -and $p.CommandLine -like '*aquatils\\chromium\\*'){Stop-Process -Id $p.ProcessId -Force}}"
            try {
                $osExtra.asyncCmd("cmd", "/c", "powershell", "-NoProfile", "-NonInteractive", "-Command", ps).run((_d, _e, code) => {
                    if (code === undefined) return
                    if (done) done()
                })
                return
            } catch (_e) {}
            if (done) done()
        }

        function aquatilsDir(): string {
            return $filepath.join($os.cacheDir(), "aquatils")
        }

        function dirExists(p: string): boolean {
            try { return !!$os.stat(p) } catch (_e) { return false }
        }

        // chromiumDownloadedHere: a Chromium WE fetched into the cache is present
        // (distinct from a system-installed browser, which we never remove).
        function chromiumDownloadedHere(): boolean {
            try { return chromiumCachedPath() !== "" } catch (_e) { return false }
        }

        function chromiumDirExists(): boolean {
            try { return dirExists($filepath.join(aquatilsDir(), "chromium")) } catch (_e) { return false }
        }

        // removeSolverDownloads deletes every downloaded solver version (but not
        // Chromium). Seanime's plugin-uninstall leaves these on disk, so this is
        // how the user reclaims the space.
        function removeSolverDownloads(): void {
            fsManualStop = true
            try { $storage.set("fs.manualStop", true) } catch (_e) {}
            binaryStop(() => {
                setStatus("down")
                let removed = false
                try {
                    const base = aquatilsDir()
                    let entries: $os.DirEntry[] = []
                    try { entries = $os.readDir(base) } catch (_e) {}
                    const names = entries.length
                        ? entries.filter((e) => e.isDir() && e.name() !== "chromium").map((e) => e.name())
                        : [FS_VERSION]
                    for (const name of names) {
                        try { $os.removeAll($filepath.join(base, name)); removed = true } catch (_e) {}
                    }
                } catch (_e) {}
                if (solverBinExists()) {
                    try { $storage.set("fs.solverReady", FS_VERSION) } catch (_e) {}
                    setNote("Couldn't fully remove the solver — a file may still be locked. Make sure it's stopped, then try again.")
                } else {
                    try { $storage.set("fs.solverReady", "") } catch (_e) {}
                    setNote(removed ? "Removed the downloaded solver. Press Start to fetch it again." : "No solver download was present.")
                }
                tray.update()
            })
        }

        function removeChromiumDownloads(): void {
            const present = chromiumDirExists()
            fsManualStop = true
            try { $storage.set("fs.manualStop", true) } catch (_e) {}
            binaryStop(() => {
                setStatus("down")
                try { $os.removeAll($filepath.join(aquatilsDir(), "chromium")) } catch (_e) {}
                if (chromiumDirExists()) {
                    setNote("Couldn't fully remove Chromium - a file may still be locked. Make sure the solver is stopped, then try again.")
                } else {
                    try { $storage.set("fs.chromiumVer", "") } catch (_e) {}
                    chromiumOverride = ""
                    setNote(present ? "Removed the downloaded Chromium." : "No Chromium download was present.")
                }
                tray.update()
            })
        }

        function downloaderReady(): boolean {
            try {
                return !!dl && typeof dl.download === "function"
            } catch (_e) {
                return false
            }
        }

        function binaryEnsureAndStart(): void {
            if (fsBusy) return
            if (typeof $os === "undefined" || typeof $osExtra === "undefined" || !dl) {
                setStatus("down")
                setNote("Seanime's strict secure mode blocks local file & download access — only Remote mode works here. Turn off strict secure mode in Seanime settings, or use Remote mode with a solver you run yourself.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            const pick = binaryAsset()
            if (!pick) {
                setNote("No prebuilt binary for this OS/arch — use Remote mode.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            let cacheDir = ""
            try {
                cacheDir = $os.cacheDir()
            } catch (_e) {
                setNote("No cache-dir access for the download.")
                tray.update()
                return
            }
            const dir = $filepath.join(cacheDir, "aquatils", FS_VERSION)
            const archive = $filepath.join(dir, pick.asset)
            const binPath = $filepath.join(dir, FS_CONTAINER, pick.bin)
            try {
                if ($os.stat(binPath) && $storage.get<string>("fs.solverReady") === FS_VERSION) {
                    binaryLaunch(binPath)
                    return
                }
            } catch (_e) {}
            try {
                $os.mkdirAll(dir, 493)
            } catch (_e) {}
            if (!downloaderReady()) {
                setStatus("down")
                setNote("Solver auto-download isn't available here — use Remote mode.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            fsBusy = true
            setStatus("starting")
            const launchGen = fsBinaryGen
            setNote("Downloading solver " + SOLVER_VERSION + " - if Seanime asks, click Allow to permit the download.")
            try { ctx.toast.info("Seanime will ask permission next — click Allow to download the solver.") } catch (_e) {}
            tray.update()
            const url = "https://github.com/" + SOLVER_REPO + "/releases/download/solver-v" + SOLVER_VERSION + "/" + pick.asset
            plog("downloading solver binary " + pick.asset + " from github.com/" + SOLVER_REPO)
            dlLogAt = 0
            let id = ""
            try {
                id = dl.download(url, archive)
                fsDownloadId = id
            } catch (_e) {
                fsBusy = false
                setStatus("down")
                const em = String(_e)
                setErr(em)
                let msg = "Download blocked: " + em
                if (em.indexOf("denied") >= 0) msg = "Download declined. Re-run and click Allow on the Seanime popup."
                else if (em.indexOf("unavailable") >= 0) msg = "Seanime couldn't show the permission popup (no app window connected). Open the Seanime app window, then re-run."
                else if (em.indexOf("deadline") >= 0 || em.indexOf("timeout") >= 0 || em.indexOf("context") >= 0) msg = "The permission popup timed out. Re-run and click Allow."
                else if (em.indexOf("not authorized") >= 0) msg = "Download path not authorized — please report this (plugin bug)."
                setNote(msg)
                ctx.toast.error(msg)
                tray.update()
                return
            }
            const cancel = dl.watch(id, (p: $downloader.DownloadProgress | undefined) => {
                if (!p) return
                if (p.status === "downloading") {
                    fsStartTicks = 0
                    dlProgress("Downloading solver " + SOLVER_VERSION, p)
                    tray.update()
                } else if (p.status === "completed") {
                    cancel()
                    fsDownloadId = ""
                    if (fsBinaryGen !== launchGen) {
                        fsBusy = false
                        return
                    }
                    let archiveSize = 0
                    try { const sa = $os.stat(archive); if (sa) { try { archiveSize = sa.size() } catch (_e) {} } } catch (_e) {}
                    const expected = p.totalSize || 0
                    if (expected > 0 && archiveSize > 0 && archiveSize < expected - 4096) {
                        fsBusy = false
                        setStatus("down")
                        plog("download truncated: " + fmtSize(archiveSize) + " of " + fmtSize(expected) + " — discarding")
                        try { $storage.set("fs.solverReady", "") } catch (_e) {}
                        try { $os.removeAll(dir) } catch (_e) {}
                        setErr("The solver download was incomplete (" + fmtSize(archiveSize) + " of " + fmtSize(expected) + ") — your connection to GitHub looks slow. Press Start to try again.")
                        setNote("Download incomplete — press Start to retry.")
                        tray.update()
                        return
                    }
                    setNote("Extracting solver " + SOLVER_VERSION + "…")
                    tray.update()
                    try {
                        if (pick.zip) $osExtra.unzip(archive, dir)
                        else $osExtra.unwrapAndMove(archive, dir)
                    } catch (_e) {
                        fsBusy = false
                        setStatus("down")
                        setNote("Extraction failed.")
                        tray.update()
                        return
                    }
                    try { $os.removeAll(archive) } catch (_e) {}
                    let exeSize = 0
                    let exeOk = false
                    try {
                        const stb = $os.stat(binPath)
                        if (stb) { exeOk = true; try { exeSize = stb.size() } catch (_e) { exeSize = -1 } }
                    } catch (_e) {}
                    plog("extracted solver.exe " + (exeSize >= 0 ? fmtSize(exeSize) : "size?") + " (archive " + fmtSize(archiveSize) + (expected ? " of " + fmtSize(expected) : "") + ")")
                    const okBin = exeOk && (exeSize < 0 || (exeSize >= 1024 && (archiveSize === 0 || exeSize >= archiveSize)))
                    if (!okBin) {
                        fsBusy = false
                        setStatus("down")
                        try { $storage.set("fs.solverReady", "") } catch (_e) {}
                        try { $os.removeAll(dir) } catch (_e) {}
                        setErr("The downloaded solver is incomplete" + (exeSize > 0 ? " (" + fmtSize(exeSize) + ")" : "") + " — the download is being cut short. Press Start to try again.")
                        setNote("Download incomplete — press Start to retry.")
                        tray.update()
                        return
                    }
                    try { $storage.set("fs.solverReady", FS_VERSION) } catch (_e) {}
                    fsBusy = false
                    binaryLaunch(binPath)
                } else if (p.status === "error") {
                    cancel()
                    fsDownloadId = ""
                    fsBusy = false
                    setStatus("down")
                    setNote("Download failed: " + (p.error || ""))
                    tray.update()
                }
            })
        }

        function fsStart(): void {
            fsManualStop = false
            try { $storage.set("fs.manualStop", false) } catch (_e) {}
            fsAvBlocked = false
            try { $storage.set("fs.avBlocked", false) } catch (_e) {}
            if (fsMode.get() === "remote") {
                setNote("Remote mode: start the solver yourself; this only manages sessions at " + fsBase() + ".")
                tray.update()
                void fsRefresh()
            } else {
                binaryEnsureAndStart()
            }
        }

        function fsStop(): void {
            fsManualStop = true
            try { $storage.set("fs.manualStop", true) } catch (_e) {}
            if (fsMode.get() === "remote") {
                setNote("Remote mode: stop the solver on its host.")
                tray.update()
            } else {
                fsBusy = false
                binaryStop()
                setStatus("down")
                fsStartTicks = 0
                setNote("Solver stopped.")
                tray.update()
            }
        }

        function solverDetail(): string {
            if (fsMode.get() === "remote") return "Remote solver"
            return "Unblocks protected stream sources"
        }

        function solverUpdatePending(): boolean {
            if (fsMode.get() === "remote") return false
            if (fsStatus.get() !== "up") return false
            const rv = (fsVersion.get() || "").trim()
            if (!rv) return false
            return verNewer(SOLVER_VERSION, rv)
        }

        function solverAdoptedStale(): boolean {
            return fsStatus.get() === "up" && fsMode.get() !== "remote" && !binaryDownloaded() && solverUpdatePending()
        }

        function simpleSetup(): void {
            void fsRefresh().then(() => {
                if (fsStatus.get() === "up") return
                fsStart()
            })
        }

        ctx.registerEventHandler("view-errors", () => view.set("errors"))
        ctx.registerEventHandler("view-cf", () => view.set("cf"))

        ctx.registerEventHandler("seh-clear", () => {
            errors.set([])
            sehPersist()
            tray.update()
            ctx.toast.info("Cleared recorded errors")
        })
        ctx.registerEventHandler("view-settings", () => view.set("settings"))
        ctx.registerEventHandler("seh-notify-toggle", () => {
            notify.set(!notify.get())
            sehPersist()
            tray.update()
        })
        ctx.registerEventHandler("seh-copy-all", () => {
            const list = errors.get()
            if (!list.length) return
            try {
                ctx.dom.clipboard.write(list.map((e) => sehLabel(e)).join("\n"))
                ctx.toast.success("Errors copied to clipboard")
            } catch (_e) {
                ctx.toast.error("Couldn't copy to clipboard")
            }
        })
        ctx.registerEventHandler("seh-save", () => {
            const raw = (appRef.current || "").trim() || SEH_DEFAULT_APP
            if (!/^https?:\/\/.+/i.test(raw)) { ctx.toast.error("Server URL must start with http:// or https://"); return }
            appBase.set(raw)
            sehAuthWarned = false
            sehPersist()
            ctx.toast.success("Saved Seanime URL")
            void sehPoll()
        })

        ctx.registerEventHandler("fs-start", () => fsStart())
        ctx.registerEventHandler("fs-stop", () => fsStop())
        ctx.registerEventHandler("fs-restart", () => {
            plog("restart requested")
            fsBusy = false
            fsRestarting = true
            setNote("Restarting…")
            tray.update()
            fsStart()
        })
        ctx.registerEventHandler("fs-test", () => {
            void runTest()
        })
        ctx.registerEventHandler("fs-logs-copy", () => {
            let t = currentLog()
            if (!t && fsMode.get() !== "remote") {
                const f = readLogFull(fsLogPath())
                t = fsLogFilter.get() ? filterLog(f) : f
            }
            if (!t) return
            try {
                ctx.dom.clipboard.write(t)
                ctx.toast.success("Logs copied")
            } catch (_e) {
                ctx.toast.error("Couldn't copy")
            }
        })
        ctx.registerEventHandler("fs-logs-clear", () => {
            fsLastOut = ""
            fsCleanOut = ""
            fsPollSkip = false
            try { $os.truncate(fsLogPath(), 0) } catch (_e) {}
            tray.update()
        })
        ctx.registerEventHandler("fs-logs-filter", () => {
            fsLogFilter.set(!fsLogFilter.get())
            tray.update()
        })
        ctx.registerEventHandler("fs-doctor", () => {
            void runDoctor()
        })
        ctx.registerEventHandler("fs-stealth", () => {
            void runStealthCheck()
        })
        for (let gi = 0; gi < 30; gi++) {
            ;(function (idx) {
                ctx.registerEventHandler("seh-copy-" + idx, () => {
                    if (idx >= sehGroups.length) return
                    const g = sehGroups[idx]
                    try {
                        ctx.dom.clipboard.write(g.label + (g.count > 1 ? " (×" + g.count + ")" : ""))
                        ctx.toast.success("Copied")
                    } catch (_e) {
                        ctx.toast.error("Couldn't copy")
                    }
                })
            })(gi)
        }
        ctx.registerEventHandler("fs-mode-remote", () => {
            fsMode.set("remote")
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-mode-binary", () => {
            fsMode.set("binary")
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-autoupdate-toggle", () => {
            fsAutoUpdate.set(!fsAutoUpdate.get())
            fsPersist()
            tray.update()
        })
        function applySolverEnvChange(note: string): void {
            tray.update()
            if (fsMode.get() !== "remote" && (fsStatus.get() === "up" || fsStatus.get() === "starting")) {
                ctx.toast.info(note + " — restarting the solver to apply.")
                fsStart()
            } else {
                ctx.toast.info(note)
            }
        }
        ctx.registerEventHandler("fs-browsermode-toggle", () => {
            fsBrowserMode.set(fsBrowserMode.get() === "offscreen" ? "headless" : "offscreen")
            fsPersist()
            applySolverEnvChange("Browser tier: " + fsBrowserMode.get())
        })
        ;["chrome", "edge", "webview2"].forEach((e) => {
            ctx.registerEventHandler("fs-engine-set-" + e, () => {
                fsEngine.set(e)
                fsPersist()
                const label = e === "webview2" ? "WebView2" : (e === "edge" ? "Edge" : "Chrome")
                applySolverEnvChange("Browser engine: " + label)
            })
        })
        ctx.registerEventHandler("fs-help-engine", () => ctx.toast.info("Stage B browser engine. Chrome (default) and Edge drive your installed browser. WebView2 is experimental: it runs a hidden, off-screen Edge WebView2 window with no taskbar button, reusing the Edge WebView2 Runtime present on virtually all Windows 11 machines. Switch to Chrome or Edge if a solve fails on WebView2."))
        ctx.registerEventHandler("fs-wv2warm-toggle", () => {
            fsWv2Warm.set(!fsWv2Warm.get())
            fsPersist()
            applySolverEnvChange(fsWv2Warm.get() ? "Warm-origin fast path on" : "Warm-origin fast path off")
        })
        ctx.registerEventHandler("fs-help-wv2warm", () => ctx.toast.info("Reuse an already-cleared site instead of re-checking every request - much faster, on by default."))
        ctx.registerEventHandler("fs-wv2refresh-toggle", () => {
            fsWv2Refresh.set(!fsWv2Refresh.get())
            fsPersist()
            applySolverEnvChange(fsWv2Refresh.get() ? "Proactive clearance refresh on" : "Proactive clearance refresh off")
        })
        ctx.registerEventHandler("fs-help-wv2refresh", () => ctx.toast.info("While watching, refresh the clearance before it expires so you never hit a mid-binge stall. Off by default; makes a periodic background request only while you're actively watching."))
        ctx.registerEventHandler("fs-wv2utls-toggle", () => {
            fsWv2Utls.set(!fsWv2Utls.get())
            fsPersist()
            applySolverEnvChange(fsWv2Utls.get() ? "uTLS fast path on" : "uTLS fast path off")
        })
        ctx.registerEventHandler("fs-help-wv2utls", () => ctx.toast.info("Experimental: after the first clear, serve requests through the fast uTLS path using the browser cleared cookie - lighter (lets the hidden browser idle). Watch the logs to confirm; off by default."))
        ;["off", "auto", "cloudflare", "google", "quad9", "custom"].forEach((d) => {
            ctx.registerEventHandler("fs-dns-set-" + d, () => {
                fsDns.set(d)
                fsPersist()
                applySolverEnvChange("Encrypted DNS: " + d)
            })
        })
        ctx.registerEventHandler("fs-dns-custom-save", () => {
            fsDnsCustom.set((fsDnsCustomRef.current || "").trim())
            fsPersist()
            applySolverEnvChange("Custom DoH saved")
        })
        ctx.registerEventHandler("fs-pacing-toggle", () => {
            fsPacing.set(!fsPacing.get())
            fsPersist()
            applySolverEnvChange(fsPacing.get() ? "Rate-limit pacing on" : "Rate-limit pacing off")
        })
        ctx.registerEventHandler("fs-help-pacing", () => ctx.toast.info("Serializes same-site requests and backs off on HTTP 429 to dodge Cloudflare rate-limit bursts. A bit slower, but more reliable when a source rate-limits."))
        ctx.registerEventHandler("fs-verbose-toggle", () => {
            fsVerbose.set(!fsVerbose.get())
            fsPersist()
            applySolverEnvChange(fsVerbose.get() ? "Verbose logging on" : "Verbose logging off")
        })
        ctx.registerEventHandler("fs-help-verbose", () => ctx.toast.info("Off by default - the log shows one line per request. Turn on to add detailed per-solve diagnostics (stage, timings, warm hits, cookie checks) for troubleshooting; restart the solver to apply."))
        ctx.registerEventHandler("fs-customtls-toggle", () => {
            fsCustomTls.set(!fsCustomTls.get())
            fsPersist()
            applySolverEnvChange(fsCustomTls.get() ? "Custom TLS fingerprint on" : "Custom TLS fingerprint off")
        })
        ctx.registerEventHandler("fs-help-customtls", () => ctx.toast.info("Off by default. Uses our own Chrome TLS/HTTP2 fingerprint instead of the bundled library's, so we can keep it current independently. Identical to the library today; run the Stealth check after enabling to confirm. Restart the solver to apply."))
        ctx.registerEventHandler("fs-autostart-toggle", () => {
            fsAutoStart.set(!fsAutoStart.get())
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("ui-mode-toggle", () => {
            uiMode.set(uiMode.get() === "simple" ? "advanced" : "simple")
            $storage.set("ui.mode", uiMode.get())
            tray.update()
        })
        ctx.registerEventHandler("fs-simple-start", () => {
            fsManualStop = false
            setStatus("starting")
            setNote("Starting solver…")
            tray.update()
            fsStart()
        })
        ctx.registerEventHandler("fs-consent-toggle", () => {
            fsConsent.set(!fsConsent.get())
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-chromium-toggle", () => {
            fsWantChromium.set(!fsWantChromium.get())
            fsPersist()
            tray.update()
        })
        ctx.registerEventHandler("fs-remove-solver", () => removeSolverDownloads())
        ctx.registerEventHandler("fs-remove-chromium", () => removeChromiumDownloads())
        ctx.registerEventHandler("fs-update-chromium", () => updateChromium())
        ctx.registerEventHandler("fs-enable-chromium", () => {
            fsWantChromium.set(true)
            fsPersist()
            ctx.toast.info("Chromium enabled — restarting the solver to fetch it.")
            fsStart()
        })
        ctx.registerEventHandler("fs-restart-update", () => {
            setNote("Restarting to apply the updated solver…")
            tray.update()
            fsStart()
        })
        ctx.registerEventHandler("fs-copy-diag", () => {
            try {
                ctx.dom.clipboard.write(buildDiagnostics())
                ctx.toast.success("Diagnostics copied — paste them when reporting an issue.")
            } catch (_e) {
                ctx.toast.error("Couldn't copy to clipboard")
            }
        })
        ctx.registerEventHandler("fs-copy-cache-path", () => {
            try {
                const p = aquatilsDir()
                if (!p) return
                ctx.dom.clipboard.write(p)
                ctx.toast.success("Folder path copied — add it as a Windows Security exclusion, then Start.")
            } catch (_e) {
                ctx.toast.error("Couldn't copy the path")
            }
        })
        ctx.registerEventHandler("fs-save", () => {
            const host = (fsHostRef.current || "").trim() || FS_DEFAULT_HOST
            const port = (fsPortRef.current || "").trim() || FS_DEFAULT_PORT
            if (/[:/]/.test(host)) { ctx.toast.error("Host must be a bare hostname or IP (no http:// and no port)"); return }
            const pn = Number(port)
            if (!/^\d{1,5}$/.test(port) || pn < 1 || pn > 65535) { ctx.toast.error("Port must be a number between 1 and 65535"); return }
            fsHost.set(host)
            fsPort.set(port)
            fsSession.set((fsSessionRef.current || "").trim() || FS_DEFAULT_SESSION)
            fsPersist()
            ctx.toast.success("Saved solver settings")
            void fsRefresh()
        })

        function dim(t: string): any {
            return tray.text(t, { style: { color: "rgba(255,255,255,0.5)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" } })
        }
        function heading(t: string): any {
            return tray.text(t, { style: { fontSize: "11px", fontWeight: "600", letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: "2px" } })
        }
        function divider(): any {
            return tray.div({ items: [], style: { borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: "4px", marginBottom: "4px" } })
        }
        function toggleRow(on: boolean, click: string, label: string, helpClick?: string): any {
            const items: any[] = [
                tray.button({ label: on ? "✓" : "✕", onClick: click, intent: "gray-subtle", size: "sm", style: on ? { ...ACCENT_SUBTLE, fontSize: ICON_FS } : { fontSize: ICON_FS } }),
                tray.text(label, { style: { fontSize: "13px", color: "rgba(255,255,255,0.85)", overflowWrap: "anywhere", wordBreak: "break-word" } }),
            ]
            if (helpClick) {
                items.push(tray.button({ label: "?", onClick: helpClick, intent: "gray-subtle", size: "sm", style: { color: "#FFC840", fontWeight: "700", marginLeft: "2px" } }))
            }
            return tray.flex({
                items: items,
                gap: 2,
                style: { alignItems: "center" },
            })
        }
        function filterLog(text: string): string {
            if (!fsLogFilter.get()) return text
            const lines = text.split("\n")
            const out: string[] = []
            let skipping = false
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i]
                const isPoll = l.indexOf("sessions.list") >= 0 || l.indexOf("sessions.create") >= 0
                if (l.indexOf("Incoming request") >= 0) {
                    skipping = isPoll
                    if (!skipping) out.push(l)
                    continue
                }
                if (isPoll) {
                    skipping = true
                    continue
                }
                if (skipping) {
                    skipping = false
                    if (l.indexOf("Response in") >= 0 || l.indexOf("200 OK") >= 0 || l.indexOf("POST http") >= 0) continue
                }
                out.push(l)
            }
            return out.join("\n")
        }
        function currentLog(): string {
            const src = fsLogFilter.get() ? fsCleanOut : fsLastOut
            const cleaned = (src || "").replace(/\r/g, "").replace(/[^\x20-\x7E\n]+/g, " ")
            return cleaned.slice(-6000).replace(/^\n+/, "").replace(/\n+$/, "")
        }
        function statusBadge(): any {
            const st = fsStatus.get()
            const s = { borderRadius: "2px" }
            const g = (glyph: string, color: string) => tray.text(glyph, { style: { fontSize: ICON_FS, color: color, lineHeight: "1" } })
            if (st === "up") return tray.flex({ items: [g("▶", "#5fd38a"), tray.badge({ text: "Running", intent: "success", size: "md", style: s })], gap: 2, style: { alignItems: "center" } })
            if (st === "starting") return tray.flex({ items: [g("◐", "#f2c14e"), tray.badge({ text: "Starting", intent: "warning", size: "md", style: s })], gap: 2, style: { alignItems: "center" } })
            if (st === "down") return tray.flex({ items: [g("⏻", "rgba(255,255,255,0.55)"), tray.badge({ text: "Off", intent: "gray", size: "md", style: s })], gap: 2, style: { alignItems: "center" } })
            return tray.flex({ items: [g("◌", "rgba(255,255,255,0.6)"), tray.badge({ text: "Checking", intent: "gray", size: "md", style: s })], gap: 2, style: { alignItems: "center" } })
        }
        function uptimeStr(): string {
            const t = nowMs()
            if (!fsUpSince || !t) return ""
            const sec = Math.floor((t - fsUpSince) / 1000)
            if (sec < 60) return sec + "s"
            const min = Math.floor(sec / 60)
            if (min < 60) return min + "m"
            return Math.floor(min / 60) + "h " + (min % 60) + "m"
        }

        function errorGroups(): { key: string; label: string; count: number; t: number }[] {
            const t = nowMs()
            const list = errors.get()
            const map: { [k: string]: { key: string; label: string; count: number; t: number } } = {}
            const order: string[] = []
            for (let i = 0; i < list.length; i++) {
                const e = list[i]
                if (t && e.t && t - e.t > SEH_TTL) continue
                const key = e.ext + "|" + e.scope + "|" + e.msg
                if (!map[key]) {
                    map[key] = { key: key, label: sehLabel(e), count: 0, t: e.t }
                    order.push(key)
                }
                map[key].count++
                if (e.t > map[key].t) map[key].t = e.t
            }
            const groups = order.map((k) => map[k])
            groups.sort((a, b) => b.t - a.t)
            return groups.slice(0, 30)
        }

        function errorRows(): any[] {
            const rows: any[] = []
            sehGroups = errorGroups()
            if (sehGroups.length === 0) {
                rows.push(dim("No extension errors reported."))
                return rows
            }
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Copy all", onClick: "seh-copy-all", intent: "gray-subtle", size: "sm" }),
                    tray.button({ label: "Clear", onClick: "seh-clear", intent: "alert-subtle", size: "sm", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            const lineStyle = { fontSize: "11px", fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.8)", flexGrow: "1", minWidth: "0" }
            const items = sehGroups.map((g, i) => tray.flex({
                items: [
                    tray.text(g.label + (g.count > 1 ? "  ×" + g.count : ""), { style: lineStyle }),
                    tray.button({ label: "⧉", onClick: "seh-copy-" + i, intent: "gray-subtle", size: "sm", style: { marginLeft: "6px", fontSize: ICON_FS } }),
                ],
                gap: 1,
            }))
            rows.push(tray.div({
                items: items,
                style: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", padding: "8px", flexGrow: "1", minHeight: "160px", overflowY: "auto" },
            }))
            return rows
        }

        function settingsRows(): any[] {
            const rows: any[] = []
            rows.push(toggleRow(fsAutoStart.get(), "fs-autostart-toggle", "Auto-Start Server on Launch"))
            rows.push(divider())
            rows.push(toggleRow(fsAutoUpdate.get(), "fs-autoupdate-toggle", "Auto-update solver & Chromium"))
            rows.push(divider())
            rows.push(tray.button({
                label: "Browser tier: " + (fsBrowserMode.get() === "offscreen" ? "Off-screen (max stealth)" : "Invisible (headless)"),
                onClick: "fs-browsermode-toggle",
                intent: "gray-subtle",
                size: "sm",
                style: ACCENT_SUBTLE,
            }))
            rows.push(divider())
            rows.push(dim("Encrypted DNS (DoH) — bypasses ISP DNS blocks. Auto enables it only when a block is detected; Custom takes a DoH URL."))
            const dnsOpts: [string, string][] = [["off", "Off"], ["auto", "Auto"], ["cloudflare", "Cloudflare"], ["google", "Google"], ["quad9", "Quad9"], ["custom", "Custom"]]
            rows.push(tray.flex({
                items: dnsOpts.map((o) => tray.button({ label: o[1], onClick: "fs-dns-set-" + o[0], intent: "gray-subtle", size: "sm", style: fsDns.get() === o[0] ? ACCENT_SUBTLE : {} })),
                gap: 2,
                style: { flexWrap: "wrap" },
            }))
            if (fsDns.get() === "custom") {
                rows.push(tray.flex({
                    items: [
                        tray.input({ fieldRef: fsDnsCustomRef, placeholder: "https://your-resolver/dns-query" }),
                        tray.button({ label: "Save", onClick: "fs-dns-custom-save", intent: "primary", size: "sm", style: ACCENT_STYLE }),
                    ],
                    gap: 2,
                }))
            }
            rows.push(divider())
            rows.push(toggleRow(notify.get(), "seh-notify-toggle", "Error notifications"))
            rows.push(divider())
            rows.push(toggleRow(fsPacing.get(), "fs-pacing-toggle", "Adaptive rate-limit pacing", "fs-help-pacing"))
            rows.push(toggleRow(fsVerbose.get(), "fs-verbose-toggle", "Verbose solver logs", "fs-help-verbose"))
            rows.push(toggleRow(fsCustomTls.get(), "fs-customtls-toggle", "Custom TLS fingerprint", "fs-help-customtls"))
            rows.push(divider())
            rows.push(dim("Seanime server URL"))
            rows.push(tray.input({ fieldRef: appRef, placeholder: SEH_DEFAULT_APP }))
            rows.push(tray.button({ label: "Save", onClick: "seh-save", intent: "primary", size: "sm", style: ACCENT_STYLE }))
            return rows
        }

        function cfStatusRows(): any[] {
            const rows: any[] = []
            const st = fsStatus.get()
            let detail = solverDetail()
            if (st === "up") {
                detail = fsBase() + (fsVersion.get() ? " · v" + fsVersion.get() : "") + (uptimeStr() ? " · up " + uptimeStr() : "")
            }
            rows.push(tray.flex({
                items: [statusBadge(), tray.text(detail, { style: { color: "rgba(255,255,255,0.6)", fontSize: "13px", overflowWrap: "anywhere", wordBreak: "break-word" } })],
                gap: 2,
                style: { alignItems: "center" },
            }))
            const note = fsNote.get()
            if (note && !fsErr.get() && fsStatus.get() !== "up") {
                rows.push(tray.text(note, { style: { fontSize: "12px", color: "rgba(255,255,255,0.6)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5" } }))
            }
            if (solverAdoptedStale()) {
                rows.push(tray.alert({
                    intent: "warning",
                    title: "Leftover solver still running",
                    description: "A solver from a previous install (v" + fsVersion.get() + ") is still running. Restart to install the bundled v" + SOLVER_VERSION + ", or Stop it to start fresh.",
                }))
                rows.push(tray.flex({
                    items: [
                        tray.button({ label: "Restart to update", onClick: "fs-restart-update", intent: "primary", size: "sm", style: ACCENT_STYLE }),
                        tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm", disabled: fsRestarting }),
                    ],
                    gap: 2,
                }))
            } else if (solverUpdatePending()) {
                rows.push(tray.alert({
                    intent: "warning",
                    title: "Solver update ready",
                    description: "A newer solver (v" + SOLVER_VERSION + ") is bundled; you're running v" + fsVersion.get() + ".",
                }))
                rows.push(tray.button({ label: "Restart to update", onClick: "fs-restart-update", intent: "primary", size: "sm", style: ACCENT_STYLE }))
            }
            if (st === "up" && fsMode.get() !== "remote" && !chromiumDownloadedHere()) {
                rows.push(dim("Stage B note: no fetched Chromium present. uTLS clears most gates; if an interactive Turnstile fails and you have no system Chrome/Edge, enable 'fetch a minimal Chromium' in Advanced."))
            }
            if (fsErr.get()) {
                rows.push(tray.div({
                    items: [tray.text(fsErr.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.85)" } })],
                    style: { background: "rgba(255,90,90,0.08)", border: "1px solid rgba(255,90,90,0.25)", borderRadius: "6px", padding: "8px", maxHeight: "160px", overflowY: "auto" },
                }))
                if (fsHint.get()) {
                    rows.push(tray.div({
                        items: [tray.text(fsHint.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.85)" } })],
                        style: { background: "rgba(90,150,255,0.08)", border: "1px solid rgba(90,150,255,0.3)", borderRadius: "6px", padding: "8px" },
                    }))
                }
                const acts: any[] = []
                if (fsAvBlocked || solverQuarantined()) {
                    acts.push(tray.button({ label: "Copy folder to exclude", onClick: "fs-copy-cache-path", intent: "gray-subtle", size: "sm", style: ACCENT_SUBTLE }))
                }
                acts.push(tray.button({ label: "Retry", onClick: "fs-start", intent: "gray-subtle", size: "sm", style: ACCENT_SUBTLE }))
                if (fsMode.get() !== "remote" && !chromiumDownloadedHere() && !fsWantChromium.get()) {
                    acts.push(tray.button({ label: "Enable Chromium", onClick: "fs-enable-chromium", intent: "gray-subtle", size: "sm" }))
                }
                acts.push(tray.button({ label: "⧉", onClick: "fs-copy-diag", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto", fontSize: ICON_FS } }))
                rows.push(tray.flex({ items: acts, gap: 2 }))
            }
            return rows
        }

        function logsSection(): any[] {
            const rows: any[] = []
            rows.push(divider())
            rows.push(heading("Logs"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "⧉", onClick: "fs-logs-copy", intent: "gray-subtle", size: "sm", style: { fontSize: ICON_FS } }),
                    tray.button({ label: "Hide polling", onClick: "fs-logs-filter", intent: "gray-subtle", size: "sm", style: fsLogFilter.get() ? ACCENT_SUBTLE : {} }),
                    tray.button({ label: "Clear", onClick: "fs-logs-clear", intent: "alert-subtle", size: "sm", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            const log = currentLog()
            const lineStyle = { fontSize: "11px", fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.75)" }
            let logItems: any[]
            if (log) {
                const lines = log.split("\n").slice(-80)
                logItems = lines.map((l) => tray.text(l.length ? l : " ", { style: lineStyle }))
            } else {
                const active = fsStatus.get() === "up" || fsStatus.get() === "starting"
                const emptyMsg = fsMode.get() === "remote"
                    ? "Logs aren't available in Remote mode (the server runs elsewhere)."
                    : active
                        ? "No recent log lines — new output will appear here."
                        : "No output captured yet — start the solver."
                logItems = [tray.text(emptyMsg, { style: { fontSize: "11px", color: "rgba(255,255,255,0.5)" } })]
            }
            rows.push(tray.div({
                items: logItems,
                style: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", padding: "8px", flexGrow: "1", minHeight: "160px", maxHeight: "300px", overflowY: "auto" },
            }))
            return rows
        }

        function appendLogs(rows: any[]): void {
            if (fsMode.get() === "remote") return
            const ls = logsSection()
            for (let i = 0; i < ls.length; i++) rows.push(ls[i])
        }

        function cfRows(): any[] {
            const rows: any[] = cfStatusRows()
            const st = fsStatus.get()
            if (uiMode.get() !== "advanced") {
                const needsDownload = st !== "up" && st !== "starting" && !binaryDownloaded()
                if (needsDownload && (fsAvBlocked || solverQuarantined())) {
                    if (!fsErr.get()) {
                        rows.push(dim("Your antivirus removed the solver after it started — Windows Defender flags it as suspicious because it automates a background browser. Add a Windows Security exclusion for the folder below, then Start (it re-downloads into the excluded folder)."))
                        rows.push(tray.flex({
                            items: [
                                tray.button({ label: "Copy folder to exclude", onClick: "fs-copy-cache-path", intent: "gray-subtle", size: "sm", style: ACCENT_SUBTLE }),
                                tray.button({ label: "Start", onClick: "fs-simple-start", intent: "success", size: "sm", style: ACCENT_STYLE }),
                                tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                            ],
                            gap: 2,
                        }))
                    } else {
                        rows.push(tray.flex({
                            items: [
                                tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                            ],
                            gap: 2,
                        }))
                    }
                } else if (needsDownload && fsConsent.get()) {
                    const prev = solverPrevInstalled()
                    rows.push(dim(prev
                        ? "A newer solver (v" + SOLVER_VERSION + ") is ready to install — it replaces the previous version (old files are removed automatically)."
                        : "The solver isn't installed. Download v" + SOLVER_VERSION + " to get blocked sources loading again."))
                    rows.push(tray.flex({
                        items: [
                            tray.button({ label: prev ? "Update & start" : "Download & start", onClick: "fs-simple-start", intent: "success", size: "sm", style: ACCENT_STYLE }),
                            tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                        ],
                        gap: 2,
                    }))
                } else if (needsDownload) {
                    rows.push(dim("aquatils-solver runs locally to get blocked sources (Cloudflare / DDoS-Guard) loading. It's downloaded from GitHub and only contacts the sites you stream."))
                    rows.push(dim("Hard JS challenges (interactive Turnstile) need a Chromium browser. If you have Chrome or Edge, leave the box below off. If you don't, tick it to also fetch a minimal Chromium (~80 MB) into the plugin's cache."))
                    rows.push(toggleRow(fsWantChromium.get(), "fs-chromium-toggle", "I have no Chrome/Edge — fetch a minimal Chromium"))
                    rows.push(toggleRow(fsConsent.get(), "fs-consent-toggle", "I understand — tap to confirm"))
                    rows.push(tray.flex({
                        items: [
                            tray.button({ label: "Download & start", onClick: "fs-simple-start", intent: "success", size: "sm", style: ACCENT_STYLE, disabled: !fsConsent.get() }),
                            tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                        ],
                        gap: 2,
                    }))
                } else {
                    const items: any[] = []
                    if (st === "up" || st === "starting") {
                        items.push(tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm", disabled: fsRestarting }))
                        items.push(tray.button({ label: fsRestarting ? "Restarting…" : "Restart", onClick: "fs-restart", intent: "warning-subtle", size: "sm", disabled: fsRestarting }))
                        if (st === "up") items.push(tray.button({ label: "Test", onClick: "fs-test", intent: "gray-subtle", size: "sm" }))
                    } else {
                        items.push(tray.button({ label: "Start", onClick: "fs-simple-start", intent: "success", size: "sm", style: ACCENT_STYLE }))
                    }
                    items.push(tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }))
                    rows.push(tray.flex({ items: items, gap: 2 }))
                }
                appendLogs(rows)
                return rows
            }
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "←", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { fontSize: ICON_FS } }),
                    tray.text("Back to Simple", { style: { fontSize: "13px", color: "rgba(255,255,255,0.7)" } }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))
            const m = fsMode.get()

            rows.push(divider())
            rows.push(heading("Launch mode"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Bundled Solver", onClick: "fs-mode-binary", intent: m !== "remote" ? "primary" : "gray-subtle", size: "sm", style: m !== "remote" ? ACCENT_STYLE : {} }),
                    tray.text("Default", { style: { color: "#6aa1ff", fontSize: "12px", marginLeft: "2px" } }),
                    tray.button({ label: "Remote", onClick: "fs-mode-remote", intent: m === "remote" ? "primary" : "gray-subtle", size: "sm", style: m === "remote" ? ACCENT_STYLE : {} }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))
            rows.push(divider())
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Start", onClick: "fs-start", intent: "success", size: "sm", style: ACCENT_STYLE }),
                    tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm", disabled: fsRestarting }),
                    tray.button({ label: fsRestarting ? "Restarting…" : "Restart", onClick: "fs-restart", intent: "warning-subtle", size: "sm", disabled: fsRestarting }),
                ],
                gap: 2,
            }))
            rows.push(divider())
            rows.push(heading("Configuration"))
            if (m === "remote") {
                rows.push(dim("Host / Port"))
                rows.push(tray.flex({ items: [tray.input({ fieldRef: fsHostRef, placeholder: FS_DEFAULT_HOST }), tray.input({ fieldRef: fsPortRef, placeholder: FS_DEFAULT_PORT })], gap: 2 }))
            } else {
                rows.push(dim("Port (binds 127.0.0.1)"))
                rows.push(tray.input({ fieldRef: fsPortRef, placeholder: FS_DEFAULT_PORT }))
            }
            rows.push(dim("Session name"))
            rows.push(tray.input({ fieldRef: fsSessionRef, placeholder: FS_DEFAULT_SESSION }))
            rows.push(tray.button({ label: "Save", onClick: "fs-save", intent: "primary", size: "sm", style: ACCENT_STYLE }))

            rows.push(divider())
            rows.push(heading("Diagnostics"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Test", onClick: "fs-test", intent: "gray-subtle", size: "sm" }),
                    tray.button({ label: "Doctor", onClick: "fs-doctor", intent: "gray-subtle", size: "sm" }),
                    tray.button({ label: "Stealth", onClick: "fs-stealth", intent: "gray-subtle", size: "sm" }),
                    tray.button({ label: "⧉", onClick: "fs-copy-diag", intent: "gray-subtle", size: "sm", style: { fontSize: ICON_FS } }),
                ],
                gap: 2,
            }))
            if (fsTest.get()) {
                rows.push(tray.div({
                    items: [tray.text(fsTest.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.75)" } })],
                    style: { background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", padding: "8px" },
                }))
            }

            const mx = fsMetrics.get()
            if (mx && (mx.total || 0) > 0) {
                rows.push(divider())
                rows.push(heading("Metrics"))
                const sec = (ms: number) => (Math.round((ms || 0) / 100) / 10) + "s"
                rows.push(dim((mx.cleared || 0) + " / " + (mx.total || 0) + " cleared (" + (mx.clearedPct || 0) + "%)  ·  last " + sec(mx.lastMs) + "  ·  avg " + sec(mx.avgMs) + "  ·  max " + sec(mx.maxMs)))
                if (mx.lastClearAgoSec != null) {
                    const a = mx.lastClearAgoSec
                    const ago = a < 90 ? a + "s" : a < 5400 ? Math.round(a / 60) + "m" : Math.round(a / 3600) + "h"
                    rows.push(dim("Last cleared " + ago + " ago"))
                }
                const reasons = mx.reasons || {}
                const rk = Object.keys(reasons)
                if (rk.length) rows.push(dim("Recent failures — " + rk.map((k) => k + ": " + reasons[k]).join("  ·  ")))
            }

            rows.push(divider())
            rows.push(heading("Downloads"))
            const solverHere = binaryDownloaded()
            const chrHere = chromiumDownloadedHere()
            const chrDir = chromiumDirExists()
            rows.push(tray.flex({
                items: [
                    tray.button({ label: solverHere ? "Remove solver" : "Solver: none", onClick: "fs-remove-solver", intent: solverHere ? "alert-subtle" : "gray-subtle", size: "sm", disabled: !solverHere }),
                    tray.button({ label: chrDir ? "Remove Chromium" : "Chromium: none", onClick: "fs-remove-chromium", intent: chrDir ? "alert-subtle" : "gray-subtle", size: "sm", disabled: !chrDir }),
                ],
                gap: 2,
            }))
            if (chrHere) {
                rows.push(tray.flex({
                    items: [
                        tray.text("Chromium " + chromiumCachedVersion(), { style: { fontSize: "12px", color: "rgba(255,255,255,0.55)" } }),
                        tray.button({ label: "Update Chromium", onClick: "fs-update-chromium", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                    ],
                    gap: 2,
                }))
            }

            appendLogs(rows)

            if (m !== "remote" && typeof $os !== "undefined" && $os.platform === "windows") {
                rows.push(divider())
                rows.push(heading("Experimental"))
                rows.push(tray.flex({
                    items: [
                        dim("Browser engine"),
                        tray.button({ label: "?", onClick: "fs-help-engine", intent: "gray-subtle", size: "sm", style: { color: "#FFC840", fontWeight: "700", marginLeft: "2px" } }),
                    ],
                    gap: 2,
                    style: { alignItems: "center" },
                }))
                const engineOpts: [string, string][] = [["webview2", "WebView2"], ["chrome", "Chrome"], ["edge", "Edge"]]
                rows.push(tray.flex({
                    items: engineOpts.map((o) => tray.button({ label: o[1], onClick: "fs-engine-set-" + o[0], intent: "gray-subtle", size: "sm", style: fsEngine.get() === o[0] ? ACCENT_SUBTLE : {} })),
                    gap: 2,
                    style: { flexWrap: "wrap" },
                }))
                if (fsEngine.get() === "webview2") {
                    rows.push(toggleRow(fsWv2Warm.get(), "fs-wv2warm-toggle", "Warm-origin fast path", "fs-help-wv2warm"))
                    rows.push(toggleRow(fsWv2Refresh.get(), "fs-wv2refresh-toggle", "Proactive clearance refresh", "fs-help-wv2refresh"))
                    rows.push(toggleRow(fsWv2Utls.get(), "fs-wv2utls-toggle", "uTLS fast path", "fs-help-wv2utls"))
                }
            }
            return rows
        }

        tray.render(() => {
            const rows: any[] = []
            const errCount = errors.get().length
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Solver", onClick: "view-cf", intent: view.get() === "cf" ? "primary" : "gray-subtle", size: "sm", style: view.get() === "cf" ? ACCENT_STYLE : {} }),
                    tray.button({ label: errCount ? "Errors (" + errCount + ")" : "Errors", onClick: "view-errors", intent: view.get() === "errors" ? "primary" : "gray-subtle", size: "sm", style: view.get() === "errors" ? ACCENT_STYLE : {} }),
                    tray.button({ label: "⚙", onClick: "view-settings", intent: view.get() === "settings" ? "primary" : "gray-subtle", size: "sm", style: view.get() === "settings" ? { ...ACCENT_STYLE, marginLeft: "auto", fontSize: ICON_FS } : { marginLeft: "auto", fontSize: ICON_FS } }),
                ],
                gap: 2,
            }))
            rows.push(divider())
            const section = view.get() === "cf" ? cfRows() : view.get() === "settings" ? settingsRows() : errorRows()
            for (let i = 0; i < section.length; i++) rows.push(section[i])
            return tray.stack({
                items: rows,
                gap: 3,
                style: {
                    display: "flex",
                    flexDirection: "column",
                    minHeight: PANEL_H,
                    padding: "18px 16px",
                    background: "linear-gradient(180deg, rgba(18,19,24,0.40), rgba(10,11,15,0.52))",
                    backdropFilter: "blur(30px) saturate(115%)",
                    WebkitBackdropFilter: "blur(30px) saturate(115%)",
                    borderRadius: "16px",
                    boxShadow: "0 24px 60px -12px rgba(0,0,0,0.7)",
                },
            })
        })

        let animeBtn: any = null
        function refreshAnimeBtn(): void {
            if (!animeBtn) return
            try {
                const st = fsStatus.get()
                if (st === "up") { animeBtn.setLabel("Solver ▶ on"); animeBtn.setIntent("success-subtle"); animeBtn.setTooltipText("Aqua's Utils solver running at " + fsBase()) }
                else if (st === "starting") { animeBtn.setLabel("Solver ◐ starting"); animeBtn.setIntent("warning-subtle"); animeBtn.setTooltipText("Solver is starting…") }
                else { animeBtn.setLabel("Solver ⏻ off"); animeBtn.setIntent("alert-subtle"); animeBtn.setTooltipText(fsMode.get() === "remote" ? "Remote solver not reachable — start it on its host" : "Tap to start the Aqua's Utils solver") }
            } catch (_e) {}
        }
        try {
            animeBtn = ctx.action.newAnimePageButton({ label: "Solver", intent: "gray-subtle", tooltipText: "Aqua's Utils solver" })
            animeBtn.onClick(() => {
                if (fsStatus.get() === "up") { ctx.toast.success("Solver running (v" + (fsVersion.get() || "?") + ") at " + fsBase()); return }
                if (fsMode.get() === "remote") { ctx.toast.info("Remote mode: start the solver on its host."); return }
                ctx.toast.info("Starting the Aqua's Utils solver…")
                fsStart()
            })
            animeBtn.mount()
            refreshAnimeBtn()
        } catch (_e) {}

        if (typeof $os !== "undefined") pruneOldSolverVersions()

        if (fsMode.get() !== "remote") {
            try {
                const hist = readLogFull(fsLogPath())
                if (hist) {
                    fsLastOut = hist.slice(-10000) + "\n"
                    fsCleanOut = filterLog(hist).slice(-10000) + "\n"
                }
            } catch (_e) {}
        }
        plog("aquatils loaded (managing solver " + SOLVER_VERSION + ")")

        ctx.jobs.poll("aquatils-seh-poll", sehPoll, SEH_POLL_MS, { immediate: true })
        ctx.jobs.poll("aquatils-fs-poll", fsRefresh, FS_POLL_MS, { immediate: true })

        if (fsAutoStart.get()) {
            if (uiMode.get() !== "advanced") {
                simpleSetup()
            } else if (fsMode.get() !== "remote") {
                void fsRefresh().then(() => {
                    if (fsStatus.get() !== "up") fsStart()
                })
            }
        } else {
            void fsRefresh()
        }
    })
}
