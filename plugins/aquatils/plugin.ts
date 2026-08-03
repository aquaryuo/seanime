type SehError = { id: string; t: number; ext: string; scope: string; msg: string }

declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

function init() {
    $ui.register((ctx) => {
        // ── aqualog v1 ───────────────────────────────────────────────────────────────
        // Shared logging core. Plugins have no module system, so this block is copied
        // verbatim into each plugin instead of imported — keep the copies identical.
        // Every line in a plugin's log buffer has the same shape:
        //
        //     HH:MM:SS.mmm LVL [scope] message
        //
        // which is what lets the tray colour lines by severity, and what keeps a copied
        // log readable when it mixes plugin events with a child process's own output.
        type AqLevel = "ERR" | "WRN" | "OK" | "INF" | "DBG"

        const AQ_SEH_MARKER = "SEHERRv1"
        const AQ_LINE_RE = /^\d{2}:\d{2}:\d{2}\.\d{3} (ERR|WRN|OK|INF|DBG)\s/
        const AQ_GO_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\s+(INFO|ERROR|WARNING|WARN|DIAG|DEBUG)\s+/
        const AQ_SCOPE_RE = /^\[([A-Za-z0-9_/-]{2,24})\]\s*/

        const AQ_COLOR: { [k: string]: string } = {
            ERR: "rgba(255,138,138,0.95)",
            WRN: "rgba(255,199,120,0.95)",
            OK: "rgba(146,222,170,0.95)",
            INF: "rgba(255,255,255,0.78)",
            DBG: "rgba(255,255,255,0.45)",
        }

        function aqStamp(ms?: number): string {
            try {
                const d = ms === undefined || ms <= 0 ? new Date() : new Date(ms)
                const p2 = (n: number): string => (n < 10 ? "0" : "") + n
                const p3 = (n: number): string => (n < 100 ? (n < 10 ? "00" : "0") : "") + n
                return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds())
            } catch (_e) {
                return "00:00:00.000"
            }
        }

        // aqText flattens a message to one printable line. The tray renders logs in a
        // monospace box where an embedded newline breaks the one-line-per-event
        // alignment, and a few glyphs render inconsistently across platforms.
        function aqText(msg: string): string {
            if (msg === undefined || msg === null) return ""
            return String(msg)
                .replace(/…/g, "...")
                .replace(/[—–]/g, "-")
                .replace(/[\r\n\t]+/g, " ")
                .replace(/ {2,}/g, " ")
                .replace(/^ +/, "")
                .replace(/\s+$/, "")
        }

        function aqLine(lvl: AqLevel, scope: string, msg: string, ms?: number): string {
            const body = aqText(msg)
            if (!body) return ""
            return aqStamp(ms) + " " + (lvl + "  ").slice(0, 3) + " [" + (scope || "plugin") + "] " + body
        }

        function aqLevelOf(line: string): AqLevel {
            const m = AQ_LINE_RE.exec(line)
            if (m) return m[1] as AqLevel
            return aqGuessLevel(line)
        }

        // aqGuessLevel only runs on text that carries no level of its own. It stays
        // deliberately narrow: over-eager matching paints ordinary lines red.
        function aqGuessLevel(text: string): AqLevel {
            if (/\b(error|fatal|panic|failed|failure|refused|denied)\b/i.test(text)) return "ERR"
            if (/\b(warn|warning|deprecated)\b/i.test(text)) return "WRN"
            return "INF"
        }

        function aqMapLevel(tag: string): AqLevel {
            switch (tag.toUpperCase()) {
                case "ERROR":
                    return "ERR"
                case "WARNING":
                case "WARN":
                    return "WRN"
                case "DIAG":
                case "DEBUG":
                    return "DBG"
                default:
                    return "INF"
            }
        }

        // aqNormalize rewrites a foreign log line — a Go logger's "date LEVEL msg", a
        // bare "[subsystem] msg" tag, or raw stderr — into the canonical shape, so one
        // buffer holds one format. Lines that are already canonical pass through
        // untouched, which is what lets a plugin's own events and a child process's
        // output share a single funnel.
        function aqNormalize(line: string, defScope: string): string {
            const raw = aqText(line)
            if (!raw) return ""
            if (AQ_LINE_RE.test(raw)) return raw
            let rest = raw
            let ms = 0
            let lvl: AqLevel | undefined = undefined
            let scope = defScope
            const g = AQ_GO_RE.exec(rest)
            if (g) {
                try {
                    ms = new Date(parseInt(g[1], 10), parseInt(g[2], 10) - 1, parseInt(g[3], 10),
                        parseInt(g[4], 10), parseInt(g[5], 10), parseInt(g[6], 10)).getTime()
                } catch (_e) {
                    ms = 0
                }
                lvl = aqMapLevel(g[7])
                rest = rest.slice(g[0].length)
            }
            const s = AQ_SCOPE_RE.exec(rest)
            if (s) {
                const sub = s[1]
                scope = defScope ? defScope + "/" + sub : sub
                rest = rest.slice(s[0].length)
            }
            return aqLine(lvl === undefined ? aqGuessLevel(rest) : lvl, scope, rest, ms)
        }

        function aqStyle(lvl: AqLevel): { [k: string]: string } {
            return {
                fontSize: "11px",
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                lineHeight: "1.5",
                color: AQ_COLOR[lvl] || AQ_COLOR.INF,
            }
        }

        // aqReport mirrors a genuine error into Seanime's own log. console.error is the
        // only console level the host records above Debug, and the SEHERRv1 marker is
        // what Aqua's Utils scrapes back out of /api/v1/logs/latest — so this is the one
        // path that makes a plugin error visible outside its own tray. $debug is not an
        // option: the host binds it to a no-op unless the plugin is in development mode.
        function aqReport(ext: string, scope: string, msg: string): void {
            try {
                const body = aqText(msg)
                if (!body) return
                console.error(AQ_SEH_MARKER + " " + JSON.stringify({ t: Date.now(), ext: ext, scope: scope, msg: body }))
            } catch (_e) {}
        }
        // ── end aqualog v1 ───────────────────────────────────────────────────────────

        const SEH_MARKER = AQ_SEH_MARKER
        const EXT_ID = "aq-aquatils-beta"
        const SEH_MAX_KEEP = 100
        const SEH_MAX_SEEN = 500
        const SEH_POLL_MS = 6000
        const SEH_TTL = 21600000
        const SEH_DEFAULT_APP = "http://127.0.0.1:43211"
        const FS_CONTAINER = "solver"
        const SOLVER_REPO = "aquaryuo/seanime"
        const SOLVER_VERSION = "0.1.82"
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
        let sehRetryAfter = 0
        let sehMaxT = sget<number>("seh.maxT", 0)

        const _storedMode = sget<string>("fs.mode", "")
        const fsMode = ctx.state<string>((!_storedMode || _storedMode === "native" || _storedMode === "docker") ? "binary" : _storedMode)
        const fsHost = ctx.state<string>(sget<string>("fs.host", FS_DEFAULT_HOST))
        const fsPort = ctx.state<string>(sget<string>("fs.port", FS_DEFAULT_PORT))
        const fsSession = ctx.state<string>(sget<string>("fs.session", FS_DEFAULT_SESSION))
        const fsAutoStart = ctx.state<boolean>(sget<boolean>("fs.autoStart", false))
        const fsWantChromium = ctx.state<boolean>(sget<boolean>("fs.wantChromium", typeof $os !== "undefined" && $os.platform !== "windows"))
        const fsAutoUpdate = ctx.state<boolean>(sget<boolean>("fs.autoUpdate", false))
        const fsBrowserMode = ctx.state<string>(sget<string>("fs.browserMode", "offscreen"))
        const fsEngine = ctx.state<string>(((): string => { const e = sget<string>("fs.engine", "webview2"); return e === "edge" ? "chrome" : e })())
        const fsWv2Warm = ctx.state<boolean>(sget<boolean>("fs.wv2warm", true))
        const fsWv2Refresh = ctx.state<boolean>(sget<boolean>("fs.wv2refresh", false))
        const fsWv2Utls = ctx.state<boolean>(sget<boolean>("fs.wv2utls", false))
        const fsDns = ctx.state<string>(sget<string>("fs.dns", "cloudflare"))
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
        const fsDnsRef = ctx.fieldRef<string>(fsDns.get())
        let fsBusy = false
        let fsBinary: $os.Cmd | null = null
        let fsStartTicks = 0
        let fsBinaryGen = 0
        let fsBadStarts = 0
        let fsBindRetries = 0
        let fsAvBlocked = sget<boolean>("fs.avBlocked", false)
        let fsDownloadId = ""
        let fsLastOut = ""
        let fsCleanOut = ""
        let fsPollSkip = false
        let fsRestarting = false
        let fsUpSince = 0
        let fsDownStreak = 0
        let fsAutoRestarts = 0
        let fsLastAutoRestart = 0
        let fsChromiumBusy = false
        let fsLeftoverKillAt = 0
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
        const fsDepsCmd = ctx.state<string>("")
        const fsDepsPkgs = ctx.state<string[]>([])
        // What the solver says about its own ability to clear a hard challenge on
        // this machine. Without it a box that cannot do the job looks healthy and
        // only fails later, silently, per episode.
        const fsCanHard = ctx.state<string>("")   // "" unknown | "yes" | "no"
        const fsHardWhy = ctx.state<string>("")
        let fsCapAt = 0
        const fsDepsInstalling = ctx.state<boolean>(false)
        const fsDepsInstallMsg = ctx.state<string>("")
        let fsDepsChecked = false
        let fsDepsAutoTried = false
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

        const LIB_PKG: { [k: string]: string } = {
            "libnspr4": "libnspr4",
            "libnss3": "libnss3", "libnssutil3": "libnss3", "libsmime3": "libnss3", "libssl3": "libnss3", "libplc4": "libnspr4", "libplds4": "libnspr4",
            "libatk-1.0": "libatk1.0-0", "libatk-bridge-2.0": "libatk-bridge2.0-0",
            "libcups": "libcups2", "libcupsimage": "libcups2",
            "libdrm": "libdrm2", "libgbm": "libgbm1",
            "libasound": "libasound2", "libxkbcommon": "libxkbcommon0",
            "libXcomposite": "libxcomposite1", "libXdamage": "libxdamage1", "libXfixes": "libxfixes3", "libXrandr": "libxrandr2",
            "libgtk-3": "libgtk-3-0", "libgdk-3": "libgtk-3-0",
            "libpango-1.0": "libpango-1.0-0", "libpangocairo-1.0": "libpango-1.0-0", "libcairo": "libcairo2", "libcairo-gobject": "libcairo2",
            "libatspi": "libatspi2.0-0",
            "libXrender": "libxrender1", "libXext": "libxext6", "libXtst": "libxtst6", "libXi": "libxi6", "libXcursor": "libxcursor1",
            "libXss": "libxss1", "libXScrnSaver": "libxss1",
            "libdbus-1": "libdbus-1-3", "libexpat": "libexpat1", "libfontconfig": "libfontconfig1",
            "libglib-2.0": "libglib2.0-0", "libgio-2.0": "libglib2.0-0", "libgobject-2.0": "libglib2.0-0", "libgmodule-2.0": "libglib2.0-0",
            "libX11": "libx11-6", "libX11-xcb": "libx11-xcb1", "libxcb": "libxcb1", "libxshmfence": "libxshmfence1",
            "libwayland-client": "libwayland-client0", "libwayland-server": "libwayland-server0", "libwayland-egl": "libwayland-egl1",
        }

        const CHROME_DEPS = "ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6 libvulkan1 xvfb"

        function chromeDepsCmd(): string {
            return "sudo apt-get update && sudo apt-get install -y " + CHROME_DEPS
        }

        function libToPkg(soname: string): string {
            const base = soname.split(".so")[0]
            return LIB_PKG[base] || soname
        }

        function mergeDepPkgs(pkgs: string[]): void {
            if (!pkgs.length) return
            const seen: { [k: string]: boolean } = {}
            const out: string[] = []
            const all = (fsDepsPkgs.get() || []).concat(pkgs)
            for (let i = 0; i < all.length; i++) {
                const p = all[i]
                if (p && !seen[p]) { seen[p] = true; out.push(p) }
            }
            out.sort()
            fsDepsPkgs.set(out)
            fsDepsCmd.set(chromeDepsCmd())
        }

        function checkChromiumDeps(force?: boolean): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined" || $os.platform !== "linux") return
            if (fsDepsChecked && !force) return
            let chrome = ""
            try { chrome = chromiumCachedPath() } catch (_e) {}
            // Run once the browser is in play (cached or opted into), so a gap shows
            // up before use, not after; Stage-A-only users are never nagged.
            if (!chrome && !fsWantChromium.get()) return
            fsDepsChecked = true
            // Two signals: a shared library Chromium links against is missing (ldd),
            // and the Xvfb executable is absent (ldd can't see it — it's a binary, not
            // a library). On apt systems list the exact missing packages; else surface
            // the tool name.
            const script = "c=" + shq(chrome) + "; miss=; "
                + "for t in Xvfb; do command -v \"$t\" >/dev/null 2>&1 || miss=\"$miss $t\"; done; "
                + "lib=0; [ -n \"$c\" ] && ldd \"$c\" 2>/dev/null | grep -q 'not found' && lib=1; "
                + "if [ \"$lib\" = 1 ] || [ -n \"$miss\" ]; then echo BROKEN; "
                + "if command -v dpkg-query >/dev/null 2>&1; then "
                + "for p in " + CHROME_DEPS + "; do dpkg-query -W -f='${Status}' \"$p\" 2>/dev/null | grep -q 'install ok installed' || echo \"$p\"; done; "
                + "else for t in $miss; do [ \"$t\" = Xvfb ] && echo xvfb || echo \"$t\"; done; fi; "
                + "else echo OK; fi"
            try {
                $osExtra.asyncCmd("sh", "-c", script).run((data, _e, code) => {
                    if (code === undefined) return
                    const out = data ? $toString(data) : ""
                    if (out.indexOf("BROKEN") < 0) {
                        if (out.indexOf("OK") >= 0) { fsDepsPkgs.set([]); fsDepsCmd.set("") }
                        return
                    }
                    const lines = out.split("\n")
                    const pkgs: string[] = []
                    const seen: { [k: string]: boolean } = {}
                    for (let i = 0; i < lines.length; i++) {
                        const t = lines[i].replace(/\s+/g, "")
                        if (/^[a-z0-9][a-z0-9+.-]*$/.test(t) && !seen[t]) { seen[t] = true; pkgs.push(t) }
                    }
                    if (!pkgs.length) {
                        plog("browser solver: Chromium is missing a system library (no dpkg here to name it)")
                        notifyOnce("chromedeps", "Aqua's Utils: the browser solver's Chromium is missing a system library, so hard challenges can't be solved until it's installed.")
                        return
                    }
                    pkgs.sort()
                    fsDepsPkgs.set(pkgs)
                    fsDepsCmd.set(chromeDepsCmd())
                    tray.update()
                    if (chrome) maybeAutoInstallDeps(); else promptDeps()
                })
            } catch (_e) {}
        }

        function installChromiumDeps(): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined" || $os.platform !== "linux") return
            if (fsDepsInstalling.get()) return
            if (!(fsDepsPkgs.get() || []).length) return
            fsDepsInstalling.set(true)
            fsDepsInstallMsg.set("Installing the Chromium dependency set in one step... this can take a minute.")
            plog("installing the Chromium dependency set")
            tray.update()
            const root = "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y " + CHROME_DEPS
            const nonRoot = "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y " + CHROME_DEPS
            const cmd = "if [ \"$(id -u)\" = 0 ]; then " + root + "; else " + nonRoot + "; fi"
            let tail = ""
            try {
                $osExtra.asyncCmd("sh", "-c", cmd + " 2>&1").run((data, _e, code) => {
                    if (data) { try { tail = (tail + $toString(data)).slice(-1200) } catch (_e) {} }
                    if (code === undefined) return
                    fsDepsInstalling.set(false)
                    if (code === 0) {
                        plog("Chromium system packages installed - restarting the solver")
                        fsDepsPkgs.set([])
                        fsDepsCmd.set("")
                        fsDepsInstallMsg.set("")
                        fsDepsChecked = false
                        fsNotified["chromedeps"] = false
                        try { ctx.toast.success("System packages installed - restarting the solver.") } catch (_e) {}
                        fsStart()
                    } else {
                        const why = cleanTail(tail)
                        fsDepsInstallMsg.set("Automatic install failed (exit " + code + ")" + (why ? ": " + why : "") + ". You likely need root or passwordless sudo - use Copy command to run it yourself.")
                        plog("Chromium deps install failed (exit " + code + ")")
                        try { ctx.toast.error("Automatic install failed - see the tray for the command to run yourself.") } catch (_e) {}
                        promptDeps()
                    }
                    tray.update()
                })
            } catch (e) {
                fsDepsInstalling.set(false)
                fsDepsInstallMsg.set("Couldn't launch the installer: " + String(e))
                tray.update()
            }
        }

        // Install missing packages ourselves when we can act without interaction (root
        // or passwordless sudo), once; otherwise fall back to the tray prompt.
        function maybeAutoInstallDeps(): void {
            if (typeof $osExtra === "undefined") return
            const pkgs = fsDepsPkgs.get() || []
            if (!pkgs.length || fsDepsInstalling.get()) return
            if (fsDepsAutoTried) { promptDeps(); return }
            try {
                $osExtra.asyncCmd("sh", "-c", "if command -v apt-get >/dev/null 2>&1 && { [ \"$(id -u)\" = 0 ] || sudo -n true 2>/dev/null; }; then echo YES; else echo NO; fi").run((data, _e, code) => {
                    if (code === undefined) return
                    const canInstall = !!data && $toString(data).indexOf("YES") >= 0
                    if (canInstall) {
                        fsDepsAutoTried = true
                        plog("installing missing system package(s) automatically: " + pkgs.join(", "))
                        try { ctx.toast.info("Installing system packages the browser solver needs (" + pkgs.join(", ") + ")…") } catch (_e) {}
                        installChromiumDeps()
                    } else {
                        promptDeps()
                    }
                })
            } catch (_e) {
                promptDeps()
            }
        }

        function promptDeps(): void {
            const pkgs = fsDepsPkgs.get() || []
            if (!pkgs.length) return
            const needsClick = pkgs.indexOf("xvfb") >= 0
            plog("browser solver: missing " + pkgs.length + " system package(s)" + (needsClick ? " incl. xvfb (interactive challenges will fail without it)" : "") + " - see the tray")
            notifyOnce("chromedeps", needsClick
                ? "Aqua's Utils: the browser solver needs xvfb to clear interactive Cloudflare challenges on this box, and couldn't install it for you (needs root or passwordless sudo). Open the tray to install it in one click."
                : "Aqua's Utils: the browser solver's Chromium needs system packages that aren't installed. Open the tray to install them in one click.")
            tray.update()
        }

        function scanChromeDeps(chunk: string): void {
            if (typeof $os === "undefined" || $os.platform !== "linux") return
            if ((fsDepsPkgs.get() || []).length) return
            const m = /error while loading shared libraries:\s*([^\s:]+)/i.exec(chunk)
            if (!m) return
            mergeDepPkgs([libToPkg(m[1])])
            checkChromiumDeps(true)
            promptDeps()
        }

        function pushLog(chunk: string): void {
            if (!chunk) return
            scanChromeDeps(chunk)
            const lines = scrubLog(chunk).split("\n")
            let all = ""
            let clean = ""
            for (let i = 0; i < lines.length; i++) {
                // The solver emits its own "date LEVEL [subsystem] msg"; plog
                // already produces canonical lines, which pass through untouched.
                const l = aqNormalize(lines[i], "solver")
                if (!l) continue
                all += l + "\n"
                if (!isPollingLine(l)) clean += l + "\n"
            }
            if (all) fsLastOut = logAppend(fsLastOut, all)
            if (clean) fsCleanOut = logAppend(fsCleanOut, clean)
        }

        function plog(msg: string, lvl?: AqLevel): void {
            const line = aqLine(lvl === undefined ? "INF" : lvl, "plugin", msg, nowMs())
            if (line) pushLog(line + "\n")
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
            if (!msg) return
            plog(msg, "ERR")
            aqReport(EXT_ID, "solver", msg)
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
                fsBindRetries = 0
                markInstalled()
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
                tray.updateBadge({ number: errorGroups().length, intent: "warning" })
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

        const PANEL_FULL = "calc(100dvh - 9rem)"
        const PANEL_SIMPLE = "min(510px, calc(100dvh - 9rem))"
        const ACCENT_GRAD = "linear-gradient(135deg, rgba(242,145,47,0.9), rgba(255,200,64,0.9))"
        const ACCENT_STYLE: Record<string, string> = { background: ACCENT_GRAD, border: "none", color: "#1c1407", fontWeight: "600" }
        const ACCENT_SUBTLE: Record<string, string> = { background: "rgba(255,200,64,0.16)", border: "none", color: "#FFD27A", fontWeight: "500" }
        const ICON_FS = "18px"
        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/aquatils/icon.png",
            withContent: true,
            width: "480px",
            minHeight: PANEL_SIMPLE,
        })

        function styleEls(els: any[], pairs: [string, string][]): void {
            for (let i = 0; i < els.length; i++) {
                for (let j = 0; j < pairs.length; j++) {
                    try { els[i].setStyle(pairs[j][0], pairs[j][1]) } catch (_e) {}
                }
            }
        }
        const PANEL_TOP = "4.5rem", PANEL_BOTTOM = "4.5rem", PANEL_LEFT = "6rem"
        try {
            if (ctx.dom && ctx.dom.observe) {
                ctx.dom.observe('[data-plugin-tray-popover-content="aq-aquatils-beta"] [class*="max-h-[35rem]"]', (els) => {
                    styleEls(els, [["max-height", PANEL_FULL], ["maxHeight", PANEL_FULL], ["padding", "0px"]])
                })
                ctx.dom.observe('[data-plugin-tray-popover-content="aq-aquatils-beta"]', (els) => {
                    styleEls(els, [["margin", "0"], ["max-height", "none"], ["maxHeight", "none"], ["background", "transparent"], ["box-shadow", "none"], ["boxShadow", "none"], ["border", "none"], ["border-width", "0"], ["borderWidth", "0"], ["outline", "none"]])
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
                                        ["display", "flex"], ["flex-direction", "column"], ["flexDirection", "column"],
                                        ["justify-content", "safe center"], ["justifyContent", "safe center"],
                                        ["border", "none"], ["border-width", "0"], ["borderWidth", "0"], ["outline", "none"],
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
                $storage.set("seh.maxT", sehMaxT)
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
            let hi = sehMaxT
            for (let i = 0; i < found.length; i++) {
                const e = found[i]
                if (e.t && e.t < sehMaxT) continue
                if (seenSet[e.id]) continue
                seenSet[e.id] = true
                fresh.push(e)
                if (e.t > hi) hi = e.t
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
            sehMaxT = hi
            sehPersist()
            tray.update()
        }

        async function sehPoll(): Promise<void> {
            // A password-protected Seanime returns 401/403 on the log API; back off
            // instead of retrying every few seconds. Auto-retries later; a URL save
            // retries immediately.
            if (nowMs() < sehRetryAfter) return
            try {
                const url = (appBase.get() || SEH_DEFAULT_APP).replace(/\/+$/, "") + "/api/v1/logs/latest"
                const res = await ctx.fetch(url, { method: "GET", timeout: 20 })
                if (!res.ok) {
                    if (res.status === 401 || res.status === 403) {
                        sehRetryAfter = nowMs() + 10 * 60 * 1000
                        if (!sehAuthWarned) {
                            sehAuthWarned = true
                            ctx.toast.warning("Aqua's Utils can't read Seanime's error log (HTTP " + res.status + ") — a server password blocks it. Only the extension-error list is affected; the solver itself works. Clear the password or ignore this.")
                        }
                    }
                    return
                }
                sehAuthWarned = false
                sehRetryAfter = 0
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
                // Something answering on the port is not the same as our solver
                // answering: a wrong host, a stale process, or another service
                // all reply, and reporting those as running shows a green badge
                // while nothing works.
                const ours = !!data && (data.version !== undefined || Array.isArray(data.sessions))
                if (!res.ok || !ours) return { up: false }
                return {
                    up: true,
                    version: data.version ? String(data.version) : undefined,
                    sessions: Array.isArray(data.sessions) ? data.sessions : undefined,
                }
            } catch (_e) {
                return { up: false }
            }
        }

        // Re-asks periodically so installing a missing package clears the warning
        // without a restart.
        async function refreshCapability(): Promise<void> {
            if (fsMode.get() === "remote") return
            const stale = fsCanHard.get() === "" ? 20000 : 300000
            if (nowMs() - fsCapAt < stale) return
            fsCapAt = nowMs()
            const r = await fsApi("capability", {}, 20)
            const c = r && r.capability
            if (!c) return
            const before = fsCanHard.get()
            fsCanHard.set(c.canStageB ? "yes" : "no")
            fsHardWhy.set(c.canStageB ? "" : String(c.reason || ""))
            if (before !== fsCanHard.get()) tray.update()
        }

        async function fsRefresh(): Promise<void> {
            if (fsTesting && nowMs() < fsTestUntil) return
            if (!fsDepsChecked) checkChromiumDeps()
            const p = await fsProbe()
            if (p.up) {
                void refreshCapability()
                if (fsManualStop && fsMode.get() !== "remote") {
                    const solverReply = p.version !== undefined || p.sessions !== undefined
                    setStatus("down")
                    if (solverReply) {
                        setNote("Stopped. Clearing a leftover solver that was still listening...")
                        if (nowMs() - fsLeftoverKillAt >= 15000) {
                            fsLeftoverKillAt = nowMs()
                            plog("solver still listening after stop - killing the leftover")
                            reapLeftoverListener()
                        }
                    }
                    refreshTrayBadge()
                    refreshAnimeBtn()
                    tray.update()
                    return
                }
                if (p.version) fsVersion.set(p.version)
                setStatus("up")
                fsDownStreak = 0
                if (fsUpSince && nowMs() - fsUpSince >= 30000) fsAutoRestarts = 0
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
            } else if (fsChromiumBusy) {
                setNote("Fetching a minimal Chromium…")
            } else {
                if (fsStatus.get() === "starting") {
                    if (fsMode.get() === "binary" && !fsDownloadId) {
                        fsStartTicks++
                        if (fsStartTicks >= 18) {
                            setStatus("down")
                            const why = cleanTail(fsLastOut) || readLogTail(fsLogPath())
                            setErr(why || "The solver didn't come up in time.")
                            setNote("The solver didn't come up" + (why ? ": " + why : "") + ".")
                        }
                    }
                } else {
                    fsDownStreak++
                    if (fsDownStreak >= 2) {
                        setStatus("down")
                        fsSessions.set([])
                        if (fsAutoStart.get() && !fsManualStop && fsMode.get() !== "remote" && !fsAvBlocked && !solverQuarantined()) {
                            const backoff = Math.min(fsAutoRestarts, 4) * 5000
                            if (fsAutoRestarts >= 5) {
                                setNote("Solver keeps stopping - auto-restart paused. Open the tray and press Start.")
                                notifyOnce("restart-cap", "Aqua's Utils: the solver keeps stopping - auto-restart paused. Open the tray to start it.")
                            } else if (nowMs() - fsLastAutoRestart >= backoff) {
                                fsAutoRestarts++
                                fsLastAutoRestart = nowMs()
                                setNote("Solver stopped - auto-restarting... (" + fsAutoRestarts + ")")
                                fsStart()
                            } else if (fsDownStreak === 2) {
                                setNote("Solver stopped - waiting before the next auto-restart...")
                            }
                        } else if (fsDownStreak === 2 && !fsManualStop && fsMode.get() !== "remote" && (fsAvBlocked || solverQuarantined())) {
                            notifyOnce("av", "Aqua's Utils: antivirus removed the solver. Add an exclusion for %LOCALAPPDATA%\\aquatils-beta, then Start.")
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
                    const bin = $filepath.join($os.cacheDir(), "aquatils-beta", FS_VERSION, FS_CONTAINER, pick.bin)
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
            if ($os.platform === "linux" && $os.arch === "amd64") return { asset: p + "linux_x64.zip", zip: true, bin: "solver" }
            if ($os.platform === "linux" && $os.arch === "arm64") return { asset: p + "linux_arm64.zip", zip: true, bin: "solver" }
            if ($os.platform === "darwin" && $os.arch === "amd64") return { asset: p + "darwin_x64.zip", zip: true, bin: "solver" }
            if ($os.platform === "darwin" && $os.arch === "arm64") return { asset: p + "darwin_arm64.zip", zip: true, bin: "solver" }
            if ($os.platform === "windows" && $os.arch === "amd64") return { asset: p + "windows_x64.zip", zip: true, bin: "solver.exe" }
            return null
        }

        function solverBinPath(): string {
            try {
                const pick = binaryAsset()
                if (!pick) return ""
                return $filepath.join($os.cacheDir(), "aquatils-beta", FS_VERSION, FS_CONTAINER, pick.bin)
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

        function priorInstall(): boolean {
            try { return $storage.get<boolean>("fs.everInstalled") === true } catch (_e) { return false }
        }

        function markInstalled(): void {
            try { $storage.set("fs.everInstalled", true) } catch (_e) {}
        }

        function fsResetRestartCap(): void {
            fsAutoRestarts = 0
            fsLastAutoRestart = 0
            fsBindRetries = 0
        }

        function solverQuarantined(): boolean {
            try { return $storage.get<string>("fs.solverReady") === FS_VERSION && !solverBinExists() } catch (_e) { return false }
        }

        function fsLogPath(): string {
            try {
                return $filepath.join($os.cacheDir(), "aquatils-beta", FS_VERSION, "solver.log")
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
                const p = $filepath.join($os.cacheDir(), "aquatils-beta", "chromium", rel)
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
            const dir = $filepath.join($os.cacheDir(), "aquatils-beta", "chromium")
            try { $os.removeAll(dir) } catch (_e) {}
            try { $os.mkdirAll(dir, 493) } catch (_e) {}
            const zip = $filepath.join(dir, "chrome.zip")
            let id = ""
            try { id = dl.download(st.url, zip, { timeout: 900.5 }) } catch (_e) { setErr("Chromium download couldn't start: " + String(_e)); done(false); return }
            plog("downloading Chromium" + (st.version ? " " + st.version : "") + " (browser solver)")
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
                        setErr("Chromium download/extract failed — the browser solver (hard challenges) will be unavailable.")
                        tray.update()
                    }
                    done(ok)
                } else if (p.status === "error") {
                    cancel()
                    setErr("Chromium download failed: " + (p.error || "unknown error"))
                    done(false)
                } else if (p.status === "cancelled") {
                    cancel()
                    setErr("Chromium download timed out — the browser solver (hard challenges) will be unavailable. Press Start to try again.")
                    done(false)
                }
            })
        }

        // Some platforms have no build to fetch — ARM Linux most of all — and there
        // the tier simply did not exist, while the message told the user to enable
        // a download that could never appear. Look for a browser the machine
        // already has and hand its path to the solver explicitly; the solver still
        // launches only what it is given, and always in its own profile directory,
        // never the user's.
        let systemChromeAt = ""
        let systemChromeDone = false
        function findSystemChrome(cb: (path: string) => void): void {
            if (systemChromeDone) { cb(systemChromeAt); return }
            if (typeof $osExtra === "undefined" || typeof $os === "undefined" || $os.platform === "windows") { cb(""); return }
            const names = "chromium chromium-browser google-chrome google-chrome-stable brave-browser microsoft-edge"
            try {
                $osExtra.asyncCmd("sh", "-c", "for c in " + names + "; do p=$(command -v \"$c\" 2>/dev/null); if [ -n \"$p\" ]; then echo \"$p\"; exit 0; fi; done").run((data, _e, code) => {
                    if (code === undefined) return
                    systemChromeDone = true
                    const out = data ? $toString(data).trim().split("\n")[0].trim() : ""
                    systemChromeAt = out && out.indexOf("/") === 0 ? out : ""
                    if (systemChromeAt) plog("using the browser already installed at " + systemChromeAt)
                    cb(systemChromeAt)
                })
            } catch (_e) { systemChromeDone = true; cb("") }
        }

        function ensureChromium(cb: (path: string) => void): void {
            const cached = chromiumCachedPath()
            if (cached) { cb(cached); return }
            if (!fsWantChromium.get()) { findSystemChrome(cb); return }
            const plt = chromiumCfTPlatform()
            if (!plt) {
                findSystemChrome((sys) => {
                    if (sys) { cb(sys); return }
                    setErr("No browser is available for this OS/architecture, so hard challenges can't be solved. Install one (on Debian/Ubuntu: sudo apt install chromium) and restart the solver — the fast path keeps working meanwhile.")
                    tray.update()
                    cb("")
                })
                return
            }
            if (!downloaderReady()) { cb(""); return }
            setNote("Fetching a minimal Chromium…")
            tray.update()
            fsChromiumBusy = true
            void chromiumStable(plt).then((st) => {
                if (!st.url) { fsChromiumBusy = false; setErr("Couldn't find a Chromium download for this platform (" + plt + ") in the release feed; starting without the browser solver."); tray.update(); cb(""); return }
                downloadChromium(st, (ok) => { fsChromiumBusy = false; if (ok) checkChromiumDeps(true); cb(ok ? chromiumCachedPath() : "") })
            }).catch((e) => {
                fsChromiumBusy = false
                setErr("Couldn't reach the Chromium release feed (" + String(e) + ") - starting without the browser solver.")
                tray.update()
                cb("")
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
                const wasRunning = fsMode.get() !== "remote" && (fsStatus.get() === "up" || fsStatus.get() === "starting")
                const apply = (): void => {
                    fsChromiumBusy = true
                    chromiumOverride = ""
                    setNote("Updating Chromium…")
                    tray.update()
                    downloadChromium(st, (ok) => {
                        fsChromiumBusy = false
                        setNote(ok ? ("Chromium updated to " + st.version + ".") : "Chromium update failed.")
                        tray.update()
                        if (wasRunning) fsStart()
                    })
                }
                if (wasRunning) binaryStop(apply)
                else apply()
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
            setStatus("starting")
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
            const fsDir = $filepath.join($os.cacheDir(), "aquatils-beta", FS_VERSION, FS_CONTAINER)
            const chrDir = $filepath.join($os.cacheDir(), "aquatils-beta", "chromium")
            const prep = "xattr -dr com.apple.quarantine " + shq(fsDir) + " 2>/dev/null; chmod -R 755 " + shq(fsDir) + "; "
                + (chromiumOverride ? "xattr -dr com.apple.quarantine " + shq(chrDir) + " 2>/dev/null; chmod -R 755 " + shq(chrDir) + "; " : "")
            const ac = $os.platform === "windows"
                ? $osExtra.asyncCmd("cmd", "/c", winCmdArg(binPath))
                : $osExtra.asyncCmd("sh", "-c", prep + "exec " + shq(binPath))
            const c = ac.getCommand()
            try {
                const env = c.environ()
                env.push("HOST=127.0.0.1")
                env.push("PORT=" + port)
                env.push("LOG_LEVEL=" + (fsVerbose.get() ? "debug" : "info"))
                if (logPath) env.push("LOG_FILE=" + logPath)
                if (chromiumOverride) env.push("SOLVER_CHROME=" + chromiumOverride)
                env.push("SOLVER_BROWSER_MODE=" + (fsBrowserMode.get() === "headed" ? "headed" : fsBrowserMode.get() === "headless" ? "headless" : $os.platform === "windows" ? "offscreen" : "auto"))
                if (fsBrowserMode.get() === "headless") env.push("SOLVER_HEADLESS=1")
                // On Linux ask for a display of our own. Sharing the machine's
                // screen means the browser cannot take over the pointer, which is
                // what completing an interactive check needs — and it keeps us
                // from moving the operator's real cursor.
                else if ($os.platform === "linux") env.push("SOLVER_XVFB=1")
                if ($os.platform === "windows" && fsEngine.get() && fsEngine.get() !== "chrome") env.push("SOLVER_BROWSER_ENGINE=" + fsEngine.get())
                if (!fsWv2Warm.get()) env.push("SOLVER_WV2_WARM=0")
                if (fsWv2Refresh.get()) env.push("SOLVER_WV2_REFRESH=1")
                if (fsWv2Utls.get()) env.push("SOLVER_WV2_UTLS=1")
                const dnsVal = fsDns.get() === "custom" ? (fsDnsCustom.get() || "").trim() : fsDns.get()
                if (dnsVal && dnsVal !== "off") env.push("SOLVER_DNS=" + dnsVal)
                if (fsPacing.get()) env.push("SOLVER_PACING=1")
                if (fsCustomTls.get()) env.push("SOLVER_TLS=custom")
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
                    if (wasUp && !solverBinExists() && $os.platform === "windows") {
                        fsAvBlocked = true
                        try { $storage.set("fs.avBlocked", true) } catch (_e) {}
                        plog("antivirus removed the solver (binary quarantined while running)")
                        setErr("Antivirus (e.g. Windows Defender) removed the solver while it was running — it flags the solver as suspicious because it automates a background browser.")
                        fsHint.set("Add a Windows Security exclusion for the aquatils-beta folder (%LOCALAPPDATA%\\aquatils-beta), then press Start.")
                        setNote("Removed by antivirus — add an exclusion for the aquatils folder, then Start.")
                        ctx.toast.error("Antivirus removed the solver — add an exclusion for the aquatils folder.")
                        notifyOnce("av", "Aqua's Utils: antivirus removed the solver. Add an exclusion for %LOCALAPPDATA%\\aquatils-beta, then Start.")
                    } else if (wasUp) {
                        setNote("Solver stopped (code " + code + ").")
                        if (!fsManualStop) notifyOnce("down", "Aqua's Utils: the solver stopped (code " + code + ").")
                    } else {
                        const why = cleanTail(fsLastOut) || readLogTail(logPath)
                        const bindRace = /address already in use|bind:\s|EADDRINUSE/i.test(fsLastOut)
                        const execBlocked = /cannot execute the specified program|not a valid win32 application|is not recognized as an internal|exec format error|access is denied|contains a virus|operation did not complete successfully/i.test(fsLastOut)
                        const binGone = !solverBinExists()
                        if (bindRace) {
                            plog("solver couldn't bind port " + port + " yet (a previous instance is still releasing it) - it will retry")
                            setErr("The previous solver is still shutting down (port " + port + " busy) - retrying shortly.")
                            setNote("Port " + port + " busy - retrying shortly.")
                            if (!fsAutoStart.get() && !fsManualStop && fsMode.get() !== "remote" && fsBindRetries < 3) {
                                fsBindRetries++
                                ctx.setTimeout(() => { if (!fsManualStop && fsMode.get() !== "remote" && fsStatus.get() !== "up" && fsStatus.get() !== "starting") fsStart() }, 3000)
                            }
                        } else if ((execBlocked || binGone) && $os.platform === "windows") {
                            fsAvBlocked = true
                            try { $storage.set("fs.avBlocked", true) } catch (_e) {}
                            plog("antivirus blocked the solver" + (binGone ? " (binary quarantined/removed while running)" : " (execution blocked)"))
                            setErr("Antivirus (e.g. Windows Defender) " + (binGone ? "removed" : "blocked") + " the solver — it flags the solver as suspicious because it automates a background browser.")
                            fsHint.set("Add a Windows Security exclusion for the aquatils-beta folder (%LOCALAPPDATA%\\aquatils-beta), then press Start.")
                            setNote("Blocked by antivirus — add an exclusion for the aquatils folder, then Start.")
                            ctx.toast.error("Antivirus blocked the solver — add an exclusion for the aquatils folder.")
                            notifyOnce("av", "Aqua's Utils: antivirus blocked the solver. Add an exclusion for %LOCALAPPDATA%\\aquatils-beta, then Start.")
                        } else {
                            plog("solver exited (code " + code + ")" + (why ? " after producing output" : "; no output captured"))
                            if (!why) {
                                fsBadStarts++
                                if (fsBadStarts >= 2) {
                                    plog("removing the solver binary after " + fsBadStarts + " no-output starts — it will re-download")
                                    try { $storage.set("fs.solverReady", "") } catch (_e) {}
                                    try { $os.removeAll($filepath.join($os.cacheDir(), "aquatils-beta", FS_VERSION, FS_CONTAINER)) } catch (_e) {}
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

        function waitPortFree(port: string, done?: () => void): void {
            let fired = false
            const fire = (): void => { if (!fired) { fired = true; if (done) done() } }
            if (typeof $osExtra === "undefined") { fire(); return }
            const wait = "P=" + shq(port) + "; for i in $(seq 1 32); do "
                + "if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -qE \"[:.]${P}([^0-9]|$)\" || exit 0; "
                + "elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:\"${P}\" -sTCP:LISTEN -nP 2>/dev/null | grep -q . || exit 0; "
                + "else sleep 1; exit 0; fi; sleep 0.25; done"
            try {
                $osExtra.asyncCmd("sh", "-c", wait).run((_d, _e, code) => {
                    if (code === undefined) return
                    fire()
                })
            } catch (_e) {
                fire()
            }
        }

        function binaryStop(done?: () => void): void {
            fsBusy = false
            fsChromiumBusy = false
            fsBinaryGen++
            const stopGen = fsBinaryGen
            const guardedDone = (): void => { if (stopGen === fsBinaryGen && done) done() }
            if (dl && fsDownloadId) {
                try {
                    dl.cancel(fsDownloadId)
                } catch (_e) {}
                fsDownloadId = ""
            }
            const proc = fsBinary && fsBinary.process ? fsBinary.process : null
            if (proc) {
                try {
                    proc.kill()
                } catch (_e) {}
            }
            fsBinary = null
            if (typeof $os !== "undefined" && $os.platform === "windows" && typeof $osExtra !== "undefined") {
                try {
                    $osExtra.asyncCmd("cmd", "/c", "taskkill", "/F", "/T", "/IM", "solver.exe").run((_d, _e, code) => {
                        if (code === undefined) return
                        reapOurChrome(guardedDone)
                    })
                    return
                } catch (_e) {}
            }
            if (typeof $osExtra !== "undefined" && typeof $os !== "undefined" && $os.platform !== "windows") {
                reapOrphanSolvers(() => reapOurChrome(() => waitPortFree(fsPort.get() || FS_DEFAULT_PORT, guardedDone)))
                return
            }
            guardedDone()
        }

        function reapOrphanSolvers(done?: () => void): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined" || $os.platform === "windows") { if (done) done(); return }
            const raw = fsPort.get() || FS_DEFAULT_PORT
            const port = /^[0-9]{1,5}$/.test(raw) ? raw : ""
            const host = (fsHost.get() || FS_DEFAULT_HOST).trim()
            const localHost = host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1"
            let cmd = "pkill -9 -f '[a]quatils-beta/.*/solver/solver' 2>/dev/null; "
            if (port && localHost) {
                cmd += "if command -v fuser >/dev/null 2>&1; then fuser -k " + port + "/tcp 2>/dev/null; "
                    + "elif command -v lsof >/dev/null 2>&1; then lsof -tiTCP:" + port + " -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null; "
                    + "elif command -v ss >/dev/null 2>&1; then P=$(ss -H -ltnp 2>/dev/null | grep -E '[:.]" + port + " ' | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2); [ -n \"$P\" ] && kill -9 \"$P\" 2>/dev/null; fi; "
            }
            cmd += "exit 0"
            try {
                $osExtra.asyncCmd("sh", "-c", cmd).run((_d, _e, code) => {
                    if (code === undefined) return
                    if (done) done()
                })
                return
            } catch (_e) {}
            if (done) done()
        }

        function reapOurChrome(done?: () => void): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined") { if (done) done(); return }
            try {
                if ($os.platform === "windows") {
                    const ps = "$ErrorActionPreference='SilentlyContinue';foreach($p in Get-CimInstance Win32_Process){if($p.Name -eq 'chrome.exe' -and $p.CommandLine -like '*aquatils-beta\\chromium\\*'){Stop-Process -Id $p.ProcessId -Force}}"
                    $osExtra.asyncCmd("cmd", "/c", "powershell", "-NoProfile", "-NonInteractive", "-Command", ps).run((_d, _e, code) => {
                        if (code === undefined) return
                        if (done) done()
                    })
                } else {
                    $osExtra.asyncCmd("sh", "-c", "pkill -f '[a]quatils-beta/chromium' 2>/dev/null; exit 0").run((_d, _e, code) => {
                        if (code === undefined) return
                        if (done) done()
                    })
                }
                return
            } catch (_e) {}
            if (done) done()
        }

        function reapLeftoverListener(): void {
            if (typeof $os === "undefined" || typeof $osExtra === "undefined") return
            if ($os.platform === "windows") {
                try { $osExtra.asyncCmd("cmd", "/c", "taskkill", "/F", "/T", "/IM", "solver.exe").run((_d, _e, _c) => {}) } catch (_e) {}
                return
            }
            reapOrphanSolvers()
        }

        function aquatilsDir(): string {
            return $filepath.join($os.cacheDir(), "aquatils-beta")
        }

        function shq(s: string): string {
            return "'" + String(s).replace(/'/g, "'\\''") + "'"
        }

        function winCmdArg(s: string): string {
            if (/[ \t]/.test(s)) return s
            return s.replace(/[&^()<>|]/g, "^$&")
        }

        function dirExists(p: string): boolean {
            try { return !!$os.stat(p) } catch (_e) { return false }
        }

        function chromiumDownloadedHere(): boolean {
            try { return chromiumCachedPath() !== "" } catch (_e) { return false }
        }

        function chromiumDirExists(): boolean {
            try { return dirExists($filepath.join(aquatilsDir(), "chromium")) } catch (_e) { return false }
        }

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
            if (dl && fsDownloadId) {
                try { dl.cancel(fsDownloadId) } catch (_e) {}
                fsDownloadId = ""
                fsBinaryGen++
            }
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
            const dir = $filepath.join(cacheDir, "aquatils-beta", FS_VERSION)
            const archive = $filepath.join(dir, pick.asset)
            const binPath = $filepath.join(dir, FS_CONTAINER, pick.bin)
            try {
                if ($os.stat(binPath) && $storage.get<string>("fs.solverReady") === FS_VERSION) {
                    binaryLaunch(binPath)
                    return
                }
            } catch (_e) {}
            if (!fsConsent.get() && !priorInstall()) {
                setStatus("down")
                setNote("Tick the consent box in Aqua's Utils before the solver is downloaded and run.")
                ctx.toast.warning(fsNote.get())
                tray.update()
                return
            }
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
                id = dl.download(url, archive, { timeout: 900.5 })
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
                    let extractOk = true
                    let extractErr = ""
                    try {
                        if (pick.zip) $osExtra.unzip(archive, dir)
                        else $osExtra.unwrapAndMove(archive, dir)
                    } catch (e) {
                        extractOk = false
                        extractErr = String(e)
                        plog("extract via " + (pick.zip ? "unzip" : "unwrapAndMove") + " failed: " + extractErr)
                    }
                    if (!extractOk && !pick.zip && $os.platform !== "windows") {
                        try {
                            $os.cmd("sh", "-c", "tar -xzf " + shq(archive) + " -C " + shq(dir)).combinedOutput()
                            if (solverBinExists()) { extractOk = true; plog("recovered via system tar") }
                            else plog("system tar ran but the binary is still missing")
                        } catch (e2) {
                            plog("system tar fallback failed: " + String(e2))
                        }
                    }
                    if (!extractOk) {
                        fsBusy = false
                        setStatus("down")
                        try { $os.removeAll(dir) } catch (_e) {}
                        try { $storage.set("fs.solverReady", "") } catch (_e) {}
                        setErr("Couldn't extract the solver: " + extractErr + ". Press Start to retry; if it keeps failing, copy the diagnostics (Advanced) and report it.")
                        setNote("Extraction failed - see logs.")
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
                    plog("extracted " + pick.bin + " " + (exeSize >= 0 ? fmtSize(exeSize) : "size?") + " (archive " + fmtSize(archiveSize) + (expected ? " of " + fmtSize(expected) : "") + ")")
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
                    markInstalled()
                    fsBusy = false
                    binaryLaunch(binPath)
                } else if (p.status === "error") {
                    cancel()
                    fsDownloadId = ""
                    fsBusy = false
                    setStatus("down")
                    setNote("Download failed: " + (p.error || ""))
                    tray.update()
                } else if (p.status === "cancelled") {
                    cancel()
                    fsDownloadId = ""
                    fsBusy = false
                    setStatus("down")
                    setNote("The solver download timed out — press Start to retry.")
                    tray.update()
                }
            })
        }

        function fsStart(): void {
            fsManualStop = false
            fsDepsCmd.set("")
            fsDepsPkgs.set([])
            fsDepsChecked = false
            fsNotified["chromedeps"] = false
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
            fsResetRestartCap()
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
            sehRetryAfter = 0
            sehPersist()
            ctx.toast.success("Saved Seanime URL")
            void sehPoll()
        })

        ctx.registerEventHandler("fs-start", () => { fsResetRestartCap(); fsStart() })
        ctx.registerEventHandler("fs-stop", () => fsStop())
        ctx.registerEventHandler("fs-restart", () => {
            plog("restart requested")
            fsResetRestartCap()
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
        ;["chrome", "webview2"].forEach((e) => {
            ctx.registerEventHandler("fs-engine-set-" + e, () => {
                fsEngine.set(e)
                if (e === "chrome" && !fsWantChromium.get()) fsWantChromium.set(true)
                fsPersist()
                const label = e === "webview2" ? "WebView2" : "Chromium"
                applySolverEnvChange("Browser engine: " + label)
            })
        })
        ctx.registerEventHandler("fs-help-engine", () => ctx.toast.info("Browser solver engine. WebView2 (default) runs a hidden, off-screen window reusing the Edge WebView2 Runtime present on virtually all Windows 11 machines — no taskbar button, no install. Chromium drives a private copy this plugin downloads into its own cache over CDP; it never touches your installed Chrome or Edge. Switch to Chromium if a solve fails on WebView2."))
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
        fsDnsRef.onValueChange((v) => {
            const val = v || "off"
            if (val === fsDns.get()) return
            fsDns.set(val)
            fsPersist()
            applySolverEnvChange("Encrypted DNS: " + val)
            tray.update()
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
            fsResetRestartCap()
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
        ctx.registerEventHandler("fs-install-deps", () => installChromiumDeps())
        ctx.registerEventHandler("fs-copy-deps", () => {
            const cmd = fsDepsCmd.get()
            if (!cmd) return
            try {
                ctx.dom.clipboard.write(cmd)
                ctx.toast.success("Install command copied — run it, then restart the solver.")
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
            return tray.div({ items: [], style: { marginTop: "5px", marginBottom: "5px" } })
        }
        function toggleRow(on: boolean, click: string, label: string, helpClick?: string): any {
            const items: any[] = [
                tray.button({ label: on ? "✓" : "✕", onClick: click, intent: "gray-subtle", size: "sm", style: on ? { ...ACCENT_SUBTLE, fontSize: ICON_FS, width: "40px", padding: "0" } : { fontSize: ICON_FS, width: "40px", padding: "0" } }),
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
            const g = (glyph: string, color: string) => tray.text(glyph, { style: { fontSize: "24px", color: color, lineHeight: "1" } })
            const pill = (word: string, bg: string, fg: string) => tray.div({
                items: [tray.text(word, { style: { fontSize: "12px", fontWeight: "600", color: fg, lineHeight: "1", whiteSpace: "nowrap" } })],
                style: { background: bg, borderRadius: "6px", padding: "3px 9px", display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", flexShrink: "0", width: "fit-content" },
            })
            if (st === "up") return tray.flex({ items: [g("▶", "#5fd38a"), pill("Running", "rgba(95,211,138,0.18)", "#7ee0a6")], gap: 2, style: { alignItems: "center" } })
            if (st === "starting") return tray.flex({ items: [g("◐", "#f2c14e"), pill("Starting", "rgba(242,193,78,0.18)", "#f2cf6e")], gap: 2, style: { alignItems: "center" } })
            if (st === "down") return tray.flex({ items: [g("⏻", "rgba(255,255,255,0.55)"), pill("Off", "rgba(255,255,255,0.10)", "rgba(255,255,255,0.7)")], gap: 2, style: { alignItems: "center" } })
            return tray.flex({ items: [g("◌", "rgba(255,255,255,0.6)"), pill("Checking", "rgba(255,255,255,0.10)", "rgba(255,255,255,0.7)")], gap: 2, style: { alignItems: "center" } })
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
                    tray.button({ label: "⎘", onClick: "seh-copy-" + i, intent: "gray-subtle", size: "sm", style: { marginLeft: "6px", fontSize: ICON_FS } }),
                ],
                gap: 1,
            }))
            rows.push(tray.div({
                items: items,
                style: { background: "rgba(0,0,0,0.28)", borderRadius: "10px", padding: "10px 12px", flexGrow: "1", minHeight: "160px", overflowY: "auto" },
            }))
            return rows
        }

        function settingsRows(): any[] {
            const rows: any[] = []
            rows.push(heading("Startup"))
            rows.push(toggleRow(fsAutoStart.get(), "fs-autostart-toggle", "Auto-Start Server on Launch"))
            rows.push(toggleRow(fsAutoUpdate.get(), "fs-autoupdate-toggle", "Auto-update solver & Chromium"))
            rows.push(divider())
            rows.push(heading("Solver"))
            rows.push(dim("Browser solver — a real browser (WebView2, or a downloaded Chromium) that clears the hard challenges (Cloudflare JS, Turnstile) uTLS can't. Runs in a hidden off-screen window. On headless Linux servers it needs the Chromium system libraries plus xvfb (installed on first run, needs root); if hard-challenge solving fails, enable Verbose logs to see the browser error."))
            rows.push(toggleRow(fsCustomTls.get(), "fs-customtls-toggle", "Custom TLS fingerprint", "fs-help-customtls"))
            rows.push(toggleRow(fsPacing.get(), "fs-pacing-toggle", "Adaptive rate-limit pacing", "fs-help-pacing"))
            rows.push(divider())
            rows.push(heading("Network"))
            rows.push(dim("Encrypted DNS (DoH) — bypasses ISP DNS blocks. Auto enables it only when a block is detected; Custom takes a DoH URL."))
            const dnsOpts: [string, string][] = [["off", "Off"], ["auto", "Auto"], ["cloudflare", "Cloudflare"], ["google", "Google"], ["quad9", "Quad9"], ["custom", "Custom"]]
            rows.push(tray.select({
                label: "Encrypted DNS",
                fieldRef: fsDnsRef,
                options: dnsOpts.map((o) => ({ label: o[1], value: o[0] })),
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
            rows.push(heading("Diagnostics"))
            rows.push(toggleRow(fsVerbose.get(), "fs-verbose-toggle", "Verbose solver logs", "fs-help-verbose"))
            rows.push(toggleRow(notify.get(), "seh-notify-toggle", "Error notifications"))
            rows.push(divider())
            rows.push(heading("Connection"))
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
            if (fsCanHard.get() === "no" && !(fsDepsPkgs.get() || []).length) {
                rows.push(tray.alert({
                    intent: "warning",
                    title: "Hard challenges can't be solved on this machine",
                    description: (fsHardWhy.get() || "The browser can't complete an interactive check here.") + " Sites behind a light check still work.",
                }))
            }
            if ((fsDepsPkgs.get() || []).length) {
                const pkgs = fsDepsPkgs.get() || []
                const items: any[] = [
                    tray.text("Chromium is missing system packages, so hard Cloudflare challenges can't clear (uTLS still works). Install adds them all and restarts the solver.", { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.85)" } }),
                    tray.text("Missing: " + pkgs.join(", "), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", marginTop: "6px", color: "rgba(255,255,255,0.7)" } }),
                ]
                if (fsDepsInstallMsg.get()) {
                    items.push(tray.text(fsDepsInstallMsg.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", marginTop: "6px", color: "rgba(255,255,255,0.85)" } }))
                }
                rows.push(tray.div({
                    items: items,
                    style: { background: "rgba(90,150,255,0.09)", borderLeft: "2px solid rgba(90,150,255,0.6)", borderRadius: "8px", padding: "10px 12px" },
                }))
                rows.push(tray.flex({
                    items: [
                        tray.button({ label: fsDepsInstalling.get() ? "Installing…" : "Install all dependencies", onClick: "fs-install-deps", intent: "success", size: "sm", style: ACCENT_STYLE, disabled: fsDepsInstalling.get() }),
                        tray.button({ label: "Copy command", onClick: "fs-copy-deps", intent: "gray-subtle", size: "sm", style: ACCENT_SUBTLE }),
                    ],
                    gap: 2,
                }))
            }
            if (fsErr.get()) {
                rows.push(tray.div({
                    items: [tray.text(fsErr.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.85)" } })],
                    style: { background: "rgba(255,90,90,0.09)", borderLeft: "2px solid rgba(255,90,90,0.6)", borderRadius: "8px", padding: "10px 12px", maxHeight: "160px", overflowY: "auto" },
                }))
                if (fsHint.get()) {
                    rows.push(tray.div({
                        items: [tray.text(fsHint.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.85)" } })],
                        style: { background: "rgba(90,150,255,0.09)", borderLeft: "2px solid rgba(90,150,255,0.6)", borderRadius: "8px", padding: "10px 12px" },
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
                acts.push(tray.button({ label: "⎘", onClick: "fs-copy-diag", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto", fontSize: ICON_FS } }))
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
                    tray.button({ label: "⎘", onClick: "fs-logs-copy", intent: "gray-subtle", size: "sm", style: { fontSize: ICON_FS } }),
                    tray.button({ label: "Hide polling", onClick: "fs-logs-filter", intent: "gray-subtle", size: "sm", style: fsLogFilter.get() ? ACCENT_SUBTLE : {} }),
                    tray.button({ label: "Clear", onClick: "fs-logs-clear", intent: "alert-subtle", size: "sm", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            const log = currentLog()
            let logItems: any[]
            if (log) {
                const lines = log.split("\n").slice(-80)
                logItems = lines.map((l) => tray.text(l.length ? l : " ", { style: aqStyle(aqLevelOf(l)) }))
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
                style: { background: "rgba(0,0,0,0.28)", borderRadius: "10px", padding: "10px 12px", height: "220px", overflowY: "auto" },
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
                    rows.push(dim("Hard JS challenges (interactive Turnstile) need a real browser. On Windows the default WebView2 engine needs nothing extra. The Chromium engine instead drives a private copy this plugin downloads (~80 MB) into its own cache — it never uses your installed Chrome or Edge. Tick below to fetch it."))
                    rows.push(toggleRow(fsWantChromium.get(), "fs-chromium-toggle", "Fetch a minimal Chromium for the browser solver"))
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
                    if (!solverAdoptedStale()) {
                        if (st === "up" || st === "starting") {
                            items.push(tray.button({ label: "Stop", onClick: "fs-stop", intent: "alert", size: "sm", disabled: fsRestarting }))
                            items.push(tray.button({ label: fsRestarting ? "Restarting…" : "Restart", onClick: "fs-restart", intent: "warning-subtle", size: "sm", disabled: fsRestarting }))
                            if (st === "up") items.push(tray.button({ label: "Test", onClick: "fs-test", intent: "gray-subtle", size: "sm" }))
                        } else {
                            items.push(tray.button({ label: "Start", onClick: "fs-simple-start", intent: "success", size: "sm", style: ACCENT_STYLE }))
                        }
                    }
                    items.push(tray.button({ label: "Advanced", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { marginLeft: "auto" } }))
                    rows.push(tray.flex({ items: items, gap: 2 }))
                }
                appendLogs(rows)
                return rows
            }
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "⟵", onClick: "ui-mode-toggle", intent: "gray-subtle", size: "sm", style: { fontSize: "26px", lineHeight: "1" } }),
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
                    tray.text("Default", { style: { color: "rgba(255,255,255,0.5)", fontSize: "12px", marginLeft: "2px" } }),
                    tray.button({ label: "Remote", onClick: "fs-mode-remote", intent: m === "remote" ? "primary" : "gray-subtle", size: "sm", style: m === "remote" ? ACCENT_STYLE : {} }),
                ],
                gap: 2,
                style: { alignItems: "center" },
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
                    tray.button({ label: "⎘", onClick: "fs-copy-diag", intent: "gray-subtle", size: "sm", style: { fontSize: ICON_FS } }),
                ],
                gap: 2,
            }))
            if (fsTest.get()) {
                rows.push(tray.div({
                    items: [tray.text(fsTest.get(), { style: { fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: "1.5", color: "rgba(255,255,255,0.75)" } })],
                    style: { background: "rgba(0,0,0,0.28)", borderRadius: "10px", padding: "10px 12px" },
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
                const engineOpts: [string, string][] = [["webview2", "WebView2"], ["chrome", "Chromium"]]
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
            const errCount = errorGroups().length
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
            const panelMin = ((view.get() === "cf" && uiMode.get() !== "advanced") || view.get() === "errors") ? PANEL_SIMPLE : PANEL_FULL
            return tray.stack({
                items: rows,
                gap: 3,
                style: {
                    display: "flex",
                    flexDirection: "column",
                    minHeight: panelMin,
                    padding: "18px 16px",
                    background: "linear-gradient(180deg, rgba(18,19,24,0.40), rgba(10,11,15,0.52))",
                    backdropFilter: "blur(30px) saturate(115%)",
                    WebkitBackdropFilter: "blur(30px) saturate(115%)",
                    border: "none",
                    outline: "none",
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
