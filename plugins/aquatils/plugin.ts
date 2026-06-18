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
        const SOLVER_VERSION = "0.1.20"
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
        const fsDns = ctx.state<string>(sget<string>("fs.dns", "off"))
        const fsStatus = ctx.state<string>("unknown")
        const fsSessions = ctx.state<string[]>([])
        const fsNote = ctx.state<string>("")
        const fsHostRef = ctx.fieldRef<string>(fsHost.get())
        const fsPortRef = ctx.fieldRef<string>(fsPort.get())
        const fsSessionRef = ctx.fieldRef<string>(fsSession.get())
        let fsBusy = false
        let fsBinary: $os.Cmd | null = null
        let fsStartTicks = 0
        let fsBinaryGen = 0
        let fsDownloadId = ""
        let fsLastOut = ""
        let fsRestarting = false
        let fsUpSince = 0
        let fsDownStreak = 0
        let fsTesting = false
        let fsManualStop = sget<boolean>("fs.manualStop", false)
        let fsAutoTested = false
        let fsAutoUpgradeTried = false
        let fsChromiumAutoChecked = false
        const fsNotified: { [k: string]: boolean } = {}
        const dl = (ctx as any).downloader
        const fsErr = ctx.state<string>("")
        const fsVersion = ctx.state<string>("")
        const fsTest = ctx.state<string>("")
        const fsLogView = ctx.state<boolean>(true)
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

        function logAppend(prev: string, chunk: string): string {
            if (!chunk) return prev
            const piece = chunk.charAt(chunk.length - 1) === "\n" ? chunk : chunk + "\n"
            return (prev + piece).slice(-6000)
        }

        function setStatus(next: string): void {
            const s = fsStatus
            s.set(next)
            fsStartTicks = 0
            if (next === "up") {
                fsNote.set("")
                fsErr.set("")
                fsRestarting = false
                if (!fsUpSince) fsUpSince = nowMs()
                fsNotified["down"] = false
                fsNotified["crash"] = false
                if (!fsAutoTested && fsMode.get() !== "remote") { fsAutoTested = true; void runTest() }
            } else if (next === "starting") {
                fsErr.set("")
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

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/aquatils/icon.png",
            withContent: true,
            width: "480px",
        })

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
                $storage.set("fs.dns", fsDns.get())
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
            if (fsTesting) return
            const p = await fsProbe()
            if (p.up) {
                if (p.version) fsVersion.set(p.version)
                setStatus("up")
                fsDownStreak = 0
                if (p.sessions) {
                    fsSessions.set(p.sessions)
                    if (fsSession.get() && p.sessions.indexOf(fsSession.get()) < 0) await fsEnsureSession()
                }
                if (solverUpdatePending() && fsMode.get() !== "remote" && !fsManualStop) {
                    if (fsAutoUpdate.get() && !fsAutoUpgradeTried) {
                        fsAutoUpgradeTried = true
                        notifyOnce("upg", "Aqua's Utils: auto-updating the solver to v" + SOLVER_VERSION + " — click Allow if Seanime asks.")
                        try { ctx.toast.info("Auto-updating the solver to v" + SOLVER_VERSION + " — click Allow if Seanime asks.") } catch (_e) {}
                        fsStart()
                    } else if (!fsAutoUpdate.get()) {
                        notifyOnce("upd", "Aqua's Utils: a newer solver (v" + SOLVER_VERSION + ") is ready — open the tray and tap Restart to update.")
                    }
                }
                if (fsAutoUpdate.get() && fsMode.get() !== "remote") maybeAutoUpdateChromium()
            } else {
                if (fsStatus.get() === "starting") {
                    if (fsMode.get() === "binary") {
                        fsStartTicks++
                        if (fsStartTicks >= 18) {
                            setStatus("down")
                            const why = cleanTail(fsLastOut) || readLogTail(fsLogPath())
                            fsErr.set(fsLastOut || why || "The solver didn't come up in time.")
                            fsNote.set("The solver didn't come up" + (why ? ": " + why : "") + ".")
                        }
                    }
                } else {
                    fsDownStreak++
                    if (fsDownStreak >= 2) {
                        setStatus("down")
                        fsSessions.set([])
                        if (fsDownStreak === 2 && fsAutoStart.get() && !fsManualStop && fsMode.get() !== "remote") {
                            fsNote.set("Solver stopped — auto-restarting…")
                            fsStart()
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
            fsTest.set("Testing…")
            tray.update()
            const ping = await fsProbe()
            if (!ping.up) {
                fsTesting = false
                fsTest.set("Not reachable at " + fsBase() + " — it may still be starting; wait for the green Running badge.")
                tray.update()
                return
            }
            if (ping.version) fsVersion.set(ping.version)
            setStatus("up")
            fsDownStreak = 0
            tray.update()
            const extra: { [k: string]: any } = { url: "https://www.google.com", maxTimeout: 45000 }
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
            fsTesting = false
            if (r && r.status === "ok") {
                fsTest.set("Test OK" + (fsVersion.get() ? " · v" + fsVersion.get() : "") + (dt ? " · " + dt + "s" : ""))
            } else if (r && r.message) {
                fsTest.set("Reachable, but the solve failed: " + String(r.message))
            } else {
                fsTest.set("Reachable (v" + (fsVersion.get() || "?") + ") but the test timed out — the browser may still be warming up. Try again in a moment.")
            }
            tray.update()
        }

        function refreshLogs(): void {
            tray.update()
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
            fsTest.set(lines.join("  ·  "))
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
                if (t) out.unshift(t)
            }
            return out.join(" | ").slice(-220)
        }

        function readLogTail(p: string): string {
            if (!p) return ""
            try {
                return cleanTail($toString($os.readFile(p)))
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
            try { id = dl.download(st.url, zip) } catch (_e) { done(false); return }
            const cancel = dl.watch(id, (p: $downloader.DownloadProgress | undefined) => {
                if (!p) return
                if (p.status === "downloading") {
                    fsNote.set("Downloading Chromium… " + Math.round(p.percentage) + "%")
                    tray.update()
                } else if (p.status === "completed") {
                    cancel()
                    let unzipOk = true
                    try { $osExtra.unzip(zip, dir) } catch (_e) { unzipOk = false }
                    try { $os.removeAll(zip) } catch (_e) {}
                    const ok = unzipOk && chromiumCachedPath() !== ""
                    if (ok && st.version) {
                        try { $storage.set("fs.chromiumVer", st.version) } catch (_e) {}
                    } else {
                        try { $os.removeAll(dir) } catch (_e) {}
                        try { $storage.set("fs.chromiumVer", "") } catch (_e) {}
                        fsErr.set("Chromium download/extract failed — Stage B (hard challenges) will be unavailable.")
                        tray.update()
                    }
                    done(ok)
                } else if (p.status === "error") {
                    cancel()
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
            fsNote.set("Fetching a minimal Chromium…")
            tray.update()
            void chromiumStable(plt).then((st) => {
                if (!st.url) { fsErr.set("Couldn't find a Chromium download for this platform (" + plt + ") in the release feed; starting without Stage B."); tray.update(); cb(""); return }
                downloadChromium(st, (ok) => cb(ok ? chromiumCachedPath() : ""))
            })
        }

        function updateChromium(): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined" || !dl) { fsNote.set("Not available in strict secure mode."); tray.update(); return }
            const plt = chromiumCfTPlatform()
            if (!plt) { fsNote.set("Chromium isn't available on this OS/arch."); tray.update(); return }
            if (!chromiumDownloadedHere()) { fsNote.set("No Chromium is downloaded — it's fetched on demand."); tray.update(); return }
            if (!downloaderReady()) { fsNote.set("Chromium update isn't available here."); tray.update(); return }
            fsNote.set("Checking for a newer Chromium…")
            tray.update()
            void chromiumStable(plt).then((st) => {
                if (!st.version || !st.url) { fsNote.set("Couldn't reach the Chromium release feed."); tray.update(); return }
                const cur = $storage.get<string>("fs.chromiumVer") || ""
                if (cur && !verNewer(st.version, cur)) { fsNote.set("Chromium is up to date (" + cur + ")."); tray.update(); return }
                try { $os.removeAll($filepath.join(aquatilsDir(), "chromium")) } catch (_e) {}
                try { $storage.set("fs.chromiumVer", "") } catch (_e) {}
                chromiumOverride = ""
                fsNote.set("Updating Chromium…")
                tray.update()
                downloadChromium(st, (ok) => {
                    fsNote.set(ok ? ("Chromium updated to " + st.version + ".") : "Chromium update failed.")
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
                env.push("LOG_LEVEL=info")
                if (logPath) env.push("LOG_FILE=" + logPath)
                if (chromiumOverride) env.push("SOLVER_CHROME=" + chromiumOverride)
                env.push("SOLVER_BROWSER_MODE=" + (fsBrowserMode.get() || "headless"))
                if (fsDns.get() && fsDns.get() !== "off") env.push("SOLVER_DNS=" + fsDns.get())
                c.env = env
            } catch (_e) {}
            fsBinary = c
            fsLastOut = ""
            try {
                ac.run((data, err, code, _s) => {
                    if (gen !== fsBinaryGen) return
                    if (err) {
                        try { fsLastOut = logAppend(fsLastOut, $toString(err)) } catch (_e) {}
                    } else if (data) {
                        try { fsLastOut = logAppend(fsLastOut, $toString(data)) } catch (_e) {}
                    }
                    if (code === undefined) {
                        if (fsLogView.get()) tray.update()
                        return
                    }
                    const wasUp = fsStatus.get() === "up"
                    fsBinary = null
                    setStatus("down")
                    fsStartTicks = 0
                    fsRestarting = false
                    if (wasUp) {
                        fsNote.set("Solver stopped (code " + code + ").")
                        if (!fsManualStop) notifyOnce("down", "Aqua's Utils: the solver stopped (code " + code + ").")
                    } else {
                        const why = cleanTail(fsLastOut) || readLogTail(logPath)
                        const blocked = !why ? " No output was captured — it died before logging (corrupt download, antivirus, or a missing system library)." : ""
                        if (!why) {
                            try { $storage.set("fs.solverReady", "") } catch (_e) {}
                            try { $os.removeAll($filepath.join($os.cacheDir(), "aquatils", FS_VERSION, FS_CONTAINER)) } catch (_e) {}
                        }
                        fsErr.set(fsLastOut || why || ("Solver exited (code " + code + ")"))
                        fsNote.set("Solver exited (code " + code + ")" + (why ? ": " + why : "") + "." + blocked)
                        ctx.toast.error("Solver exited (code " + code + ")")
                        notifyOnce("crash", "Aqua's Utils: the solver failed to start (code " + code + "). Open the tray for details.")
                    }
                    tray.update()
                })
                setStatus("starting")
                fsStartTicks = 0
                fsErr.set("")
                fsNote.set("Solver started; waiting for it to come up…")
            } catch (_e) {
                fsBinary = null
                setStatus("down")
                fsErr.set(String(_e))
                fsNote.set("Launch failed: " + String(_e))
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
                        if (done) done()
                    })
                    return
                } catch (_e) {}
            }
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
                try { $storage.set("fs.solverReady", "") } catch (_e) {}
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
                    fsNote.set("Couldn't fully remove the solver — a file may still be locked. Make sure it's stopped, then try again.")
                } else {
                    fsNote.set(removed ? "Removed the downloaded solver. Press Start to fetch it again." : "No solver download was present.")
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
                try { $storage.set("fs.chromiumVer", "") } catch (_e) {}
                chromiumOverride = ""
                fsNote.set(present ? "Removed the downloaded Chromium." : "No Chromium download was present.")
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
                fsNote.set("Seanime's strict secure mode blocks local file & download access — only Remote mode works here. Turn off strict secure mode in Seanime settings, or use Remote mode with a solver you run yourself.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            const pick = binaryAsset()
            if (!pick) {
                fsNote.set("No prebuilt binary for this OS/arch — use Remote mode.")
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
                fsNote.set("Solver auto-download isn't available here — use Remote mode.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
            fsBusy = true
            setStatus("starting")
            const launchGen = fsBinaryGen
            fsNote.set("Downloading solver " + SOLVER_VERSION + " — if Seanime asks, click Allow to permit the download.")
            try { ctx.toast.info("Seanime will ask permission next — click Allow to download the solver.") } catch (_e) {}
            tray.update()
            const url = "https://github.com/" + SOLVER_REPO + "/releases/download/solver-v" + SOLVER_VERSION + "/" + pick.asset
            let id = ""
            try {
                id = dl.download(url, archive)
                fsDownloadId = id
            } catch (_e) {
                fsBusy = false
                setStatus("down")
                const em = String(_e)
                fsErr.set(em)
                let msg = "Download blocked: " + em
                if (em.indexOf("denied") >= 0) msg = "Download declined. Re-run and click Allow on the Seanime popup."
                else if (em.indexOf("unavailable") >= 0) msg = "Seanime couldn't show the permission popup (no app window connected). Open the Seanime app window, then re-run."
                else if (em.indexOf("deadline") >= 0 || em.indexOf("timeout") >= 0 || em.indexOf("context") >= 0) msg = "The permission popup timed out. Re-run and click Allow."
                else if (em.indexOf("not authorized") >= 0) msg = "Download path not authorized — please report this (plugin bug)."
                fsNote.set(msg)
                ctx.toast.error(msg)
                tray.update()
                return
            }
            const cancel = dl.watch(id, (p: $downloader.DownloadProgress | undefined) => {
                if (!p) return
                if (p.status === "downloading") {
                    fsStartTicks = 0
                    fsNote.set("Downloading… " + Math.round(p.percentage) + "%")
                    tray.update()
                } else if (p.status === "completed") {
                    cancel()
                    fsDownloadId = ""
                    if (fsBinaryGen !== launchGen) {
                        fsBusy = false
                        return
                    }
                    fsNote.set("Extracting…")
                    tray.update()
                    try {
                        if (pick.zip) $osExtra.unzip(archive, dir)
                        else $osExtra.unwrapAndMove(archive, dir)
                    } catch (_e) {
                        fsBusy = false
                        setStatus("down")
                        fsNote.set("Extraction failed.")
                        tray.update()
                        return
                    }
                    try { $os.removeAll(archive) } catch (_e) {}
                    let okBin = false
                    try { const stb = $os.stat(binPath); if (stb) { try { okBin = stb.size() >= 1024 } catch (_e) { okBin = true } } } catch (_e) { okBin = false }
                    if (!okBin) {
                        fsBusy = false
                        setStatus("down")
                        try { $storage.set("fs.solverReady", "") } catch (_e) {}
                        try { $os.removeAll(dir) } catch (_e) {}
                        fsNote.set("The downloaded solver looks incomplete — press Start to try again.")
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
                    fsNote.set("Download failed: " + (p.error || ""))
                    tray.update()
                }
            })
        }

        function fsStart(): void {
            fsManualStop = false
            try { $storage.set("fs.manualStop", false) } catch (_e) {}
            if (fsMode.get() === "remote") {
                fsNote.set("Remote mode: start the solver yourself; this only manages sessions at " + fsBase() + ".")
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
                fsNote.set("Remote mode: stop the solver on its host.")
                tray.update()
            } else {
                fsBusy = false
                binaryStop()
                setStatus("down")
                fsStartTicks = 0
                fsNote.set("Solver stopped.")
                tray.update()
            }
        }

        function solverDetail(): string {
            if (fsMode.get() === "remote") return "Remote solver"
            return "solver · Cloudflare + DDoS-Guard (+ Turnstile via Chrome)"
        }

        function solverUpdatePending(): boolean {
            if (fsMode.get() === "remote") return false
            if (fsStatus.get() !== "up") return false
            const rv = (fsVersion.get() || "").trim()
            if (!rv) return false
            return verNewer(SOLVER_VERSION, rv)
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
            appBase.set((appRef.current || "").trim() || SEH_DEFAULT_APP)
            sehAuthWarned = false
            sehPersist()
            ctx.toast.success("Saved Seanime URL")
            void sehPoll()
        })

        ctx.registerEventHandler("fs-start", () => fsStart())
        ctx.registerEventHandler("fs-stop", () => fsStop())
        ctx.registerEventHandler("fs-restart", () => {
            fsBusy = false
            fsRestarting = true
            tray.update()
            fsStop()
            fsBusy = false
            fsStart()
        })
        ctx.registerEventHandler("fs-refresh", () => {
            void fsRefresh()
        })
        ctx.registerEventHandler("fs-test", () => {
            void runTest()
        })
        ctx.registerEventHandler("fs-viewlog", () => {
            fsLogView.set(!fsLogView.get())
            tray.update()
        })
        ctx.registerEventHandler("fs-logs-refresh", () => refreshLogs())
        ctx.registerEventHandler("fs-logs-copy", () => {
            const t = currentLog()
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
            tray.update()
        })
        ctx.registerEventHandler("fs-logs-filter", () => {
            fsLogFilter.set(!fsLogFilter.get())
            tray.update()
        })
        ctx.registerEventHandler("fs-doctor", () => {
            void runDoctor()
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
        ctx.registerEventHandler("fs-create-session", () => {
            void fsEnsureSession().then(() => fsRefresh())
        })
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
        ctx.registerEventHandler("fs-dns-toggle", () => {
            const order = ["off", "cloudflare", "google", "quad9"]
            const i = order.indexOf(fsDns.get())
            fsDns.set(order[(i + 1) % order.length])
            fsPersist()
            applySolverEnvChange("Encrypted DNS: " + fsDns.get())
        })
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
        ctx.registerEventHandler("fs-simple-setup", () => simpleSetup())
        ctx.registerEventHandler("fs-simple-start", () => {
            fsManualStop = false
            setStatus("starting")
            fsNote.set("Starting solver…")
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
            fsNote.set("Restarting to apply the updated solver…")
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
        ctx.registerEventHandler("fs-copy", () => {
            const text = fsErr.get() || fsNote.get()
            if (!text) return
            try {
                ctx.dom.clipboard.write(text)
                ctx.toast.success("Error copied to clipboard")
            } catch (_e) {
                ctx.toast.error("Couldn't copy to clipboard")
            }
        })
        ctx.registerEventHandler("fs-save", () => {
            fsHost.set((fsHostRef.current || "").trim() || FS_DEFAULT_HOST)
            fsPort.set((fsPortRef.current || "").trim() || FS_DEFAULT_PORT)
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
            const cleaned = (fsLastOut || "").replace(/\r/g, "").replace(/[^\x20-\x7E\n]+/g, " ")
            return filterLog(cleaned).slice(-6000).replace(/^\n+/, "").replace(/\n+$/, "")
        }
        function statusBadge(): any {
            const st = fsStatus.get()
            if (st === "up") return tray.badge({ text: "● Running", intent: "success", size: "md" })
            if (st === "starting") return tray.badge({ text: "◐ Starting", intent: "warning", size: "md" })
            if (st === "down") return tray.badge({ text: "○ Off", intent: "gray", size: "md" })
            return tray.badge({ text: "◌ Checking", intent: "gray", size: "md" })
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
                    tray.button({ label: "Copy all", onClick: "seh-copy-all", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Clear", onClick: "seh-clear", intent: "alert-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            const lineStyle = { fontSize: "11px", fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.8)" }
            const items = sehGroups.map((g) => tray.text(g.label + (g.count > 1 ? "  ×" + g.count : ""), { style: lineStyle }))
            rows.push(tray.div({
                items: items,
                style: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", padding: "8px", maxHeight: "280px", overflowY: "auto" },
            }))
            return rows
        }

        function settingsRows(): any[] {
            const rows: any[] = []
            rows.push(tray.button({
                label: fsAutoStart.get() ? "✓ Auto-Start Server on Launch" : "Auto-Start Server on Launch: off",
                onClick: "fs-autostart-toggle",
                intent: fsAutoStart.get() ? "success-subtle" : "gray-subtle",
                size: "sm",
            }))
            rows.push(dim("Start the solver automatically when Seanime launches."))
            rows.push(divider())
            rows.push(tray.button({
                label: fsAutoUpdate.get() ? "✓ Auto-update solver & Chromium" : "Auto-update solver & Chromium: off",
                onClick: "fs-autoupdate-toggle",
                intent: fsAutoUpdate.get() ? "success-subtle" : "gray-subtle",
                size: "sm",
            }))
            rows.push(dim("When on, the solver (and a downloaded Chromium) update themselves once a newer version is bundled. When off, you'll get a notice to update manually."))
            rows.push(divider())
            rows.push(tray.button({
                label: "Browser tier: " + (fsBrowserMode.get() === "offscreen" ? "Off-screen (max stealth)" : "Invisible (headless)"),
                onClick: "fs-browsermode-toggle",
                intent: "primary-subtle",
                size: "sm",
            }))
            rows.push(dim("How the solver drives a browser for hard JS gates (Cloudflare/Turnstile). Neither shows a normal window. Invisible: --headless=new on the real GPU. Off-screen: a real window placed off your screen — stronger against bot-detection, may briefly flash on launch."))
            rows.push(divider())
            const dnsLabel = fsDns.get() === "cloudflare" ? "Cloudflare" : fsDns.get() === "google" ? "Google" : fsDns.get() === "quad9" ? "Quad9" : "Off (use system DNS)"
            rows.push(tray.button({
                label: "Encrypted DNS: " + dnsLabel,
                onClick: "fs-dns-toggle",
                intent: fsDns.get() !== "off" ? "success-subtle" : "gray-subtle",
                size: "sm",
            }))
            rows.push(dim("If your ISP blocks a site by tampering with DNS (you'd see a non-site placeholder/notice page), turn this on: the solver resolves names over an encrypted channel (DNS-over-TLS) so the block is bypassed. Off uses your system's DNS."))
            rows.push(divider())
            rows.push(tray.button({
                label: notify.get() ? "✓ Error notifications: on" : "Error notifications: off",
                onClick: "seh-notify-toggle",
                intent: notify.get() ? "success-subtle" : "gray-subtle",
                size: "sm",
            }))
            rows.push(dim("Toasts when an extension reports an error. Off by default."))
            rows.push(divider())
            rows.push(dim("Seanime server URL (used to read logs for the Errors tab)"))
            rows.push(tray.input({ fieldRef: appRef, placeholder: SEH_DEFAULT_APP }))
            rows.push(tray.button({ label: "Save", onClick: "seh-save", intent: "primary", size: "sm" }))
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
            }))
            if (solverUpdatePending()) {
                rows.push(tray.alert({
                    intent: "warning",
                    title: "Solver update ready",
                    description: "A newer solver (v" + SOLVER_VERSION + ") is bundled; you're running v" + fsVersion.get() + ".",
                }))
                rows.push(tray.button({ label: "Restart to update", onClick: "fs-restart-update", intent: "primary", size: "sm" }))
            }
            if (st === "up" && fsMode.get() !== "remote" && !chromiumDownloadedHere()) {
                rows.push(dim("Stage B note: no fetched Chromium present. uTLS clears most gates; if an interactive Turnstile fails and you have no system Chrome/Edge, enable 'fetch a minimal Chromium' in Advanced."))
            }
            if (fsErr.get()) {
                rows.push(tray.div({
                    items: [tray.text(fsNote.get() || fsErr.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.85)" } })],
                    style: { background: "rgba(255,90,90,0.08)", border: "1px solid rgba(255,90,90,0.25)", borderRadius: "6px", padding: "8px", maxHeight: "160px", overflowY: "auto" },
                }))
                const acts: any[] = [tray.button({ label: "Retry", onClick: "fs-start", intent: "primary-subtle", size: "xs" })]
                if (fsMode.get() !== "remote" && !chromiumDownloadedHere() && !fsWantChromium.get()) {
                    acts.push(tray.button({ label: "Enable Chromium", onClick: "fs-enable-chromium", intent: "gray-subtle", size: "xs" }))
                }
                acts.push(tray.button({ label: "Copy diagnostics", onClick: "fs-copy-diag", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }))
                rows.push(tray.flex({ items: acts, gap: 2 }))
            } else if (fsNote.get()) {
                rows.push(dim(fsNote.get()))
            }
            if (fsTest.get()) rows.push(dim(fsTest.get()))
            return rows
        }

        function logsSection(): any[] {
            const rows: any[] = []
            rows.push(divider())
            rows.push(heading("Logs"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Copy logs", onClick: "fs-logs-copy", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: fsLogFilter.get() ? "Polling: hidden" : "Polling: shown", onClick: "fs-logs-filter", intent: fsLogFilter.get() ? "primary-subtle" : "gray-subtle", size: "xs" }),
                    tray.button({ label: "Clear", onClick: "fs-logs-clear", intent: "alert-subtle", size: "xs", style: { marginLeft: "auto" } }),
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
                logItems = [tray.text(fsMode.get() === "remote" ? "Logs aren't available in Remote mode (the server runs elsewhere)." : "No output captured yet — start the solver.", { style: { fontSize: "11px", color: "rgba(255,255,255,0.5)" } })]
            }
            rows.push(tray.div({
                items: logItems,
                style: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", padding: "8px", maxHeight: "220px", overflowY: "auto" },
            }))
            return rows
        }

        function cfRows(): any[] {
            const rows: any[] = cfStatusRows()
            const st = fsStatus.get()
            if (uiMode.get() !== "advanced") {
                const needsDownload = st !== "up" && st !== "starting" && !binaryDownloaded()
                if (needsDownload && fsConsent.get()) {
                    rows.push(dim("A newer solver (v" + SOLVER_VERSION + ") is ready to install — it replaces the previous version (old files are removed automatically)."))
                    rows.push(tray.flex({
                        items: [
                            tray.button({ label: "Update & start", onClick: "fs-simple-start", intent: "success", size: "sm" }),
                            tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                        ],
                        gap: 2,
                    }))
                    return rows
                }
                if (needsDownload) {
                    rows.push(dim("aquatils-solver runs locally to get blocked sources (Cloudflare / DDoS-Guard) loading. It's downloaded from GitHub and only contacts the sites you stream."))
                    rows.push(dim("Hard JS challenges (interactive Turnstile) need a Chromium browser. If you have Chrome or Edge, leave the box below off. If you don't, tick it to also fetch a minimal Chromium (~80 MB) into the plugin's cache."))
                    rows.push(tray.button({
                        label: (fsWantChromium.get() ? "☑" : "☐") + " I have no Chrome/Edge — fetch a minimal Chromium",
                        onClick: "fs-chromium-toggle",
                        intent: fsWantChromium.get() ? "primary-subtle" : "gray-subtle",
                        size: "sm",
                    }))
                    rows.push(tray.button({
                        label: (fsConsent.get() ? "☑" : "☐") + " I understand — tap to confirm",
                        onClick: "fs-consent-toggle",
                        intent: fsConsent.get() ? "success-subtle" : "gray-subtle",
                        size: "sm",
                    }))
                    rows.push(tray.flex({
                        items: [
                            tray.button({ label: "Download & start", onClick: "fs-simple-start", intent: "success", size: "sm", disabled: !fsConsent.get() }),
                            tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                        ],
                        gap: 2,
                    }))
                    return rows
                }
                const items: any[] = []
                if (st === "up" || st === "starting") {
                    items.push(tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm", disabled: fsRestarting }))
                    items.push(tray.button({ label: fsRestarting ? "Restarting…" : "Restart", onClick: "fs-restart", intent: "warning-subtle", size: "sm", disabled: fsRestarting }))
                    if (st === "up") items.push(tray.button({ label: "Test", onClick: "fs-test", intent: "gray-subtle", size: "sm" }))
                } else {
                    items.push(tray.button({ label: "Start", onClick: "fs-simple-start", intent: "success", size: "sm" }))
                }
                items.push(tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }))
                rows.push(tray.flex({ items: items, gap: 2 }))
                if (fsMode.get() !== "remote") { const ls = logsSection(); for (let i = 0; i < ls.length; i++) rows.push(ls[i]) }
                return rows
            }
            rows.push(tray.button({ label: "← Back to Simple", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "xs" }))
            const m = fsMode.get()

            rows.push(divider())
            rows.push(heading("Launch mode"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Binary", onClick: "fs-mode-binary", intent: m !== "remote" ? "primary" : "gray-subtle", size: "sm" }),
                    tray.button({ label: "Remote", onClick: "fs-mode-remote", intent: m === "remote" ? "primary" : "gray-subtle", size: "sm" }),
                ],
                gap: 2,
            }))
            rows.push(dim(m === "remote" ? "Point at a solver you run yourself — any FlareSolverr-/v1 endpoint (e.g. a container you manage)." : "Downloads & runs the self-contained solver (uTLS first; auto-escalates to a real browser only for hard JS gates like Turnstile)."))

            rows.push(divider())
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Start", onClick: "fs-start", intent: "success", size: "sm" }),
                    tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm", disabled: fsRestarting }),
                    tray.button({ label: fsRestarting ? "Restarting…" : "Restart", onClick: "fs-restart", intent: "warning-subtle", size: "sm", disabled: fsRestarting }),
                ],
                gap: 2,
            }))
            if (m !== "remote") {
                rows.push(dim(chromiumDownloadedHere()
                    ? "Stage B (hard JS / interactive Turnstile): a minimal Chromium is in the cache and is used automatically when uTLS can't clear a gate."
                    : "Stage B (hard JS / interactive Turnstile) needs a Chromium. The solver will try a system Chrome/Edge if one is installed, but that can't be verified here — if hard challenges fail, tick 'fetch a minimal Chromium' below."))
            }

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
            rows.push(tray.button({ label: "Save", onClick: "fs-save", intent: "primary", size: "sm" }))

            rows.push(divider())
            rows.push(heading("Diagnostics"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Test", onClick: "fs-test", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Doctor", onClick: "fs-doctor", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Copy diagnostics", onClick: "fs-copy-diag", intent: "gray-subtle", size: "xs" }),
                ],
                gap: 2,
            }))

            rows.push(divider())
            rows.push(heading("Downloads"))
            rows.push(dim("Uninstalling the plugin doesn't delete these — remove them here first if you want the disk space back."))
            const solverHere = binaryDownloaded()
            const chrHere = chromiumDownloadedHere()
            const chrDir = chromiumDirExists()
            rows.push(tray.flex({
                items: [
                    tray.button({ label: solverHere ? "Remove solver" : "Solver: none", onClick: "fs-remove-solver", intent: solverHere ? "alert-subtle" : "gray-subtle", size: "xs", disabled: !solverHere }),
                    tray.button({ label: chrDir ? "Remove Chromium" : "Chromium: none", onClick: "fs-remove-chromium", intent: chrDir ? "alert-subtle" : "gray-subtle", size: "xs", disabled: !chrDir }),
                ],
                gap: 2,
            }))
            if (chrHere) {
                rows.push(tray.flex({
                    items: [
                        tray.text("Chromium " + chromiumCachedVersion(), { style: { fontSize: "12px", color: "rgba(255,255,255,0.55)" } }),
                        tray.button({ label: "Update Chromium", onClick: "fs-update-chromium", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                    ],
                    gap: 2,
                }))
            }

            return rows
        }

        tray.render(() => {
            const rows: any[] = []
            const errCount = errors.get().length
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Solver", onClick: "view-cf", intent: view.get() === "cf" ? "primary" : "gray-subtle", size: "sm" }),
                    tray.button({ label: errCount ? "Errors (" + errCount + ")" : "Errors", onClick: "view-errors", intent: view.get() === "errors" ? "primary" : "gray-subtle", size: "sm" }),
                    tray.button({ label: "⚙", onClick: "view-settings", intent: view.get() === "settings" ? "primary" : "gray-subtle", size: "sm", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            rows.push(divider())
            const section = view.get() === "cf" ? cfRows() : view.get() === "settings" ? settingsRows() : errorRows()
            for (let i = 0; i < section.length; i++) rows.push(section[i])
            return tray.stack({ items: rows, gap: 3 })
        })

        let animeBtn: any = null
        function refreshAnimeBtn(): void {
            if (!animeBtn) return
            try {
                const st = fsStatus.get()
                if (st === "up") { animeBtn.setLabel("Solver ● on"); animeBtn.setIntent("success-subtle"); animeBtn.setTooltipText("Aqua's Utils solver running at " + fsBase()) }
                else if (st === "starting") { animeBtn.setLabel("Solver ◐ starting"); animeBtn.setIntent("warning-subtle"); animeBtn.setTooltipText("Solver is starting…") }
                else { animeBtn.setLabel("Solver ○ off"); animeBtn.setIntent("alert-subtle"); animeBtn.setTooltipText(fsMode.get() === "remote" ? "Remote solver not reachable — start it on its host" : "Tap to start the Aqua's Utils solver") }
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
