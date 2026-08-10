declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

function init() {
    $ui.register((ctx) => {
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

        function aqReport(ext: string, scope: string, msg: string): void {
            try {
                const body = aqText(msg)
                if (!body) return
                console.error(AQ_SEH_MARKER + " " + JSON.stringify({ t: Date.now(), ext: ext, scope: scope, msg: body }))
            } catch (_e) {}
        }

        const VC = ctx.videoCore
        const hasVC = !!(VC && typeof VC.addEventListener === "function")

        const EXT_ID = "aq-aquaprefs"
        const CFG_KEY = "cfg"
        const IDX_KEY = "pref:__index"
        const LOG_KEY = "log"
        const LOG_CAP = 30
        const CLICK_SUPPRESS = 2500
        const GRACE = 450
        const PICK_PENDING_MAX = 4000
        const POLL_ATTEMPTS = 8
        const POLL_INTERVAL = 350
        const MAX_CORRECTIONS = 8
        const ENFORCE_WINDOW = 8000
        const REARM_DEDUP = 1500
        const OPT_SEL = "[data-vc-element='setting-select-option']"
        const LABEL_SEL = "[data-vc-element='setting-select-option-label']"
        const TITLE_SEL = "[data-vc-element='menu-title']"

        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return (v === undefined || v === null) ? d : v } catch (_e) { return d }
        }
        function sset(k: string, v: any): void { try { $storage.set(k, v) } catch (_e) {} }
        function nowMs(): number { try { return Date.now() } catch (_e) { return 0 } }

        let logs: string[] = sget<string[]>(LOG_KEY, [])
        if (!Array.isArray(logs)) logs = []
        // Call sites mark severity with a leading glyph; deriving the level
        // from it keeps them unchanged while still colouring the tray.
        function glyphLevel(msg: string): AqLevel {
            const c = msg.charAt(0)
            if (c === "⚠") return "WRN"
            if (c === "✓") return "OK"
            if (c === "·") return "DBG"
            return "INF"
        }
        function log(msg: string, lvl?: AqLevel): void {
            const line = aqLine(lvl === undefined ? glyphLevel(msg) : lvl, "prefs", msg)
            if (!line) return
            logs.push(line)
            if (logs.length > LOG_CAP) logs = logs.slice(logs.length - LOG_CAP)
            sset(LOG_KEY, logs)
            try { tray.update() } catch (_e) {}
        }
        function logErr(msg: string): void {
            log(msg, "ERR")
            aqReport(EXT_ID, "enforce", msg)
        }
        function shortPid(pid: string): string {
            const s = String(pid || "")
            return s.length > 14 ? "…" + s.slice(-12) : s
        }

        const cfg = sget<any>(CFG_KEY, {})
        const persistSubs = ctx.state<boolean>(cfg.subs !== false)
        const logsOpen = ctx.state<boolean>(false)

        function saveCfg(): void {
            sset(CFG_KEY, { subs: persistSubs.get() })
        }

        const ACCENT_SUBTLE: Record<string, string> = { background: "rgba(255,200,64,0.16)", border: "none", color: "#FFD27A", fontWeight: "500" }
        const ICON_FS = "18px"

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/main/plugins/aquaprefs/icon.png",
            withContent: true,
            width: "420px",
        })

        function styleEls(els: any[], pairs: [string, string][]): void {
            for (let i = 0; i < els.length; i++) {
                for (let j = 0; j < pairs.length; j++) {
                    try { els[i].setStyle(pairs[j][0], pairs[j][1]) } catch (_e) {}
                }
            }
        }
        try {
            if (ctx.dom && ctx.dom.observe) {
                ctx.dom.observe('[data-plugin-tray-popover-content="aq-aquaprefs"] [class*="max-h-[35rem]"]', (els) => {
                    styleEls(els, [["padding", "0px"]])
                })
                ctx.dom.observe('[data-plugin-tray-popover-content="aq-aquaprefs"]', (els) => {
                    styleEls(els, [["background", "transparent"], ["box-shadow", "none"], ["boxShadow", "none"], ["padding", "0px"]])
                })
            }
        } catch (_e) {}

        let gen = 0
        let armedPid = ""
        let lastArmAt = 0
        let lastMenu = ""
        let loadAt = 0
        const boundOpts: any = {}
        const pendingClick: any = { sub: 0, cap: 0 }
        const pickPending: any = { sub: false, cap: false }
        const enforceCount: any = { sub: 0, cap: 0 }
        const lastDesired: any = { sub: -999, cap: -999 }
        const enforceOpen: any = { sub: false, cap: false }
        const curTrack: any = { sub: -999, cap: -999 }
        const enforceTok: any = { sub: 0, cap: 0 }

        function pinfo(): any { try { return VC.getCurrentPlaybackInfo() || null } catch (_e) { return null } }
        function curMediaId(): number {
            try { const m = VC.getCurrentMedia(); if (m && typeof m.id === "number") return m.id } catch (_e) {}
            const pi = pinfo()
            if (pi) {
                if (pi.media && typeof pi.media.id === "number") return pi.media.id
                if (pi.onlinestreamParams && typeof pi.onlinestreamParams.mediaId === "number") return pi.onlinestreamParams.mediaId
            }
            return 0
        }
        function curEpisode(): number {
            const pi = pinfo()
            if (pi) {
                if (pi.episode && typeof pi.episode.episodeNumber === "number") return pi.episode.episodeNumber
                if (pi.onlinestreamParams && typeof pi.onlinestreamParams.episodeNumber === "number") return pi.onlinestreamParams.episodeNumber
            }
            return 0
        }

        function writeKey(): string { return "pref:global" }
        function readCascade(): any {
            const g = sget<any>("pref:global", null)
            if (!g) return null
            return (g.sub || g.cap) ? g : null
        }
        function ctxStr(): string { return "media=" + curMediaId() + " · ep=" + curEpisode() }

        function indexAdd(k: string): void {
            const idx = sget<string[]>(IDX_KEY, [])
            if (idx.indexOf(k) < 0) { idx.push(k); sset(IDX_KEY, idx) }
        }
        function recordTo(k: string, patch: any): void {
            if (!k) return
            const cur = sget<any>(k, {})
            sset(k, Object.assign({}, cur, patch, { updatedAt: nowMs() }))
            indexAdd(k)
        }
        function trackList(): any[] | undefined {
            const pi = pinfo()
            if (!pi) return undefined
            const out: any[] = []
            const subs = pi.subtitleTracks
            if (Array.isArray(subs)) {
                let file = 1000
                for (let i = 0; i < subs.length; i++) {
                    const t = subs[i] || {}
                    const libass = t.useLibassRenderer === true
                    out.push({ kind: libass ? "sub" : "cap", number: libass ? file++ : i, label: String(t.label || ""), language: String(t.language || "") })
                }
            }
            const mkv = pi.mkvMetadata
            if (mkv && Array.isArray(mkv.subtitleTracks)) {
                for (let i = 0; i < mkv.subtitleTracks.length; i++) {
                    const t = mkv.subtitleTracks[i] || {}
                    out.push({ kind: "sub", number: t.number, label: String(t.name || ""), language: String(t.language || t.languageIETF || "") })
                }
            }
            return out
        }
        function domainList(kind: string): any[] | undefined {
            const l = trackList()
            if (l === undefined) return undefined
            return l.filter((t) => t.kind === kind)
        }
        function findTrack(list: any[], want: any): any {
            const lang = String(want.language || "").toLowerCase()
            const label = String(want.label || "").toLowerCase()
            if (label) {
                for (let i = 0; i < list.length; i++) if (lang && String(list[i].label || "").toLowerCase() === label && String(list[i].language || "").toLowerCase() === lang) return list[i]
                for (let i = 0; i < list.length; i++) if (String(list[i].label || "").toLowerCase() === label) return list[i]
            }
            for (let i = 0; i < list.length; i++) if (lang && String(list[i].language || "").toLowerCase() === lang) return list[i]
            return null
        }
        function matchByLabel(list: any[], label: string): any {
            const L = label.toLowerCase(); const U = label.toUpperCase()
            for (let i = 0; i < list.length; i++) if (String(list[i].label || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toUpperCase() === U) return list[i]
            return null
        }

        function savedFor(kind: string): any {
            const rec = readCascade()
            if (!rec) return null
            return kind === "sub" ? (rec.sub || null) : (rec.cap || null)
        }

        function setKind(kind: string, n: number, myGen: number): void {
            if (myGen !== gen) return
            if (n === lastDesired[kind]) {
                enforceCount[kind]++
                if (enforceCount[kind] > MAX_CORRECTIONS) {
                    if (enforceOpen[kind]) { enforceOpen[kind] = false; logErr(kind + " enforcement paused - player keeps overriding (" + n + ")") }
                    return
                }
            } else { lastDesired[kind] = n; enforceCount[kind] = 1 }
            try {
                if (kind === "sub") VC.setSubtitleTrack(n)
                else VC.setMediaCaptionTrack(n)
                log("→ " + (kind === "sub" ? "setSubtitleTrack" : "setMediaCaptionTrack") + "(" + n + ")")
            } catch (_e) {}
        }

        function enforceKind(kind: string, myGen: number): string {
            if (myGen !== gen) return "stale"
            if (!persistSubs.get()) return "off"
            if (!enforceOpen[kind]) return "closed"
            if (pickPending[kind] || nowMs() - pendingClick[kind] <= CLICK_SUPPRESS) return "user"
            const sv = savedFor(kind)
            if (!sv) return "none"
            const list = domainList(kind)
            if (list === undefined) return "unsupported"
            if (!list.length) return "no-tracks"
            if (sv.off) {
                if (curTrack[kind] === -1) { enforceOpen[kind] = false; return "ok" }
                setKind(kind, -1, myGen)
                if (kind === "cap") enforceOpen[kind] = false
                return "applied"
            }
            const m = findTrack(list, sv)
            if (!m) return "no-match"
            if (curTrack[kind] === m.number) { enforceOpen[kind] = false; return "ok" }
            setKind(kind, m.number, myGen)
            if (kind === "cap") enforceOpen[kind] = false
            return "applied"
        }

        function scheduleEnforce(kind: string): void {
            if (!enforceOpen[kind]) return
            enforceTok[kind]++
            const tok = enforceTok[kind]
            const myGen = gen
            ctx.setTimeout(() => {
                if (myGen !== gen || enforceTok[kind] !== tok) return
                if (nowMs() - loadAt > ENFORCE_WINDOW) { enforceOpen[kind] = false; return }
                enforceKind(kind, myGen)
            }, GRACE)
        }

        function pollLoad(myGen: number, attempt: number): void {
            if (myGen !== gen) return
            const sub = enforceKind("sub", myGen)
            const cap = enforceKind("cap", myGen)
            const wait = (s: string) => s === "unsupported" || s === "no-tracks"
            if ((wait(sub) || wait(cap)) && attempt < POLL_ATTEMPTS) {
                ctx.setTimeout(() => pollLoad(myGen, attempt + 1), POLL_INTERVAL)
            }
        }

        function arm(pid: string, fromLoad: boolean): void {
            if (!pid) return
            if (fromLoad) { if (pid === armedPid && nowMs() - lastArmAt < REARM_DEDUP) return }
            else { if (pid === armedPid) return }
            const reload = (pid === armedPid)
            armedPid = pid
            lastArmAt = nowMs()
            loadAt = nowMs()
            gen++
            const ks = ["sub", "cap"]
            for (let i = 0; i < ks.length; i++) { const k = ks[i]; enforceCount[k] = 0; lastDesired[k] = -999; enforceOpen[k] = true; pickPending[k] = false; pendingClick[k] = 0; curTrack[k] = -999 }
            for (const id in boundOpts) delete boundOpts[id]
            log("▶ LOAD" + (reload ? " (reload)" : "") + " pid=" + shortPid(pid) + " · " + ctxStr())
            pollLoad(gen, 0)
        }

        function owningMenuTitle(el: any): Promise<string> {
            function up(cur: any, depth: number): Promise<string> {
                if (depth <= 0) return Promise.resolve("")
                return cur.getParent().then((p: any) => {
                    if (!p) return ""
                    return p.queryOne(TITLE_SEL).then((title: any) => {
                        if (title) return title.getText().then((t: string) => String(t || "").trim())
                        return up(p, depth - 1)
                    }).catch(() => up(p, depth - 1))
                }).catch(() => "")
            }
            return up(el, 8)
        }

        function recordByLabel(el: any, done: () => void): void {
            owningMenuTitle(el).then((menu: string) => {
                if (menu && !/subtitle/i.test(menu)) { log("· click ignored (" + menu + ")"); done(); return }
                el.query(LABEL_SEL).then((spans: any[]) => {
                    const sp = (spans && spans.length) ? spans[0] : el
                    return sp.getText()
                }).then((txt: string) => {
                    const label = String(txt || "").trim()
                    if (!label) { log("· click: could not read label"); done(); return }
                    log("· you picked '" + label + "' (" + (menu || lastMenu || "?") + ")")
                    if (/^off$/i.test(label)) { const key = writeKey(); recordTo(key, { sub: { off: true }, cap: { off: true } }); enforceOpen.sub = false; enforceOpen.cap = false; log("✓ saved off @ " + key); done(); return }
                    const m = matchByLabel(trackList() || [], label)
                    if (m) {
                        const key = writeKey()
                        if (m.kind === "cap") recordTo(key, { cap: { off: false, language: m.language, label: m.label }, sub: null })
                        else recordTo(key, { sub: { off: false, language: m.language, label: m.label }, cap: null })
                        enforceOpen.sub = false; enforceOpen.cap = false
                        log("✓ saved " + m.kind + "=" + (m.label || m.language) + " @ " + key); done(); return
                    }
                    log("· '" + label + "' matched no track — not saved"); done()
                }).catch(() => { log("· click: could not read label"); done() })
            }).catch(() => { log("· click: could not read label"); done() })
        }

        function onOptionClick(el: any): void {
            const kinds = ["sub", "cap"]
            const t = nowMs()
            for (let i = 0; i < kinds.length; i++) { pendingClick[kinds[i]] = t; pickPending[kinds[i]] = true }
            const clearPending = () => { for (let i = 0; i < kinds.length; i++) pickPending[kinds[i]] = false }
            ctx.setTimeout(clearPending, PICK_PENDING_MAX)
            recordByLabel(el, clearPending)
        }

        if (hasVC) {
            try {
                ctx.dom.observe(TITLE_SEL, (els) => {
                    if (!els || !els.length) return
                    const el = els[els.length - 1]
                    try {
                        el.getText().then((t) => {
                            const name = String(t || "").trim()
                            if (name && name !== lastMenu) { lastMenu = name; log("· menu open: " + name) }
                        }).catch(() => {})
                    } catch (_e) {}
                })
            } catch (_e) {}
            try {
                ctx.dom.observe(OPT_SEL, (els) => {
                    if (!els || !els.length) return
                    for (let i = 0; i < els.length; i++) {
                        const el = els[i]
                        const id = el && el.id
                        if (!id || boundOpts[id]) continue
                        boundOpts[id] = true
                        try { el.addEventListener("click", () => onOptionClick(el)) } catch (_e) {}
                    }
                })
            } catch (_e) {}

            VC.addEventListener("video-loaded", (e) => arm((e && e.playbackId) || "", true))
            VC.addEventListener("video-loaded-metadata", (e) => arm((e && e.playbackId) || "", true))

            VC.addEventListener("video-subtitle-track", (e) => {
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackNumber === "number" && e.trackNumber >= 0) ? e.trackNumber : -1
                curTrack.sub = v
                if (enforceOpen.sub) scheduleEnforce("sub")
            })
            VC.addEventListener("video-media-caption-track", (e) => {
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackIndex === "number" && e.trackIndex >= 0) ? e.trackIndex : -1
                curTrack.cap = v
                if (enforceOpen.cap) scheduleEnforce("cap")
            })
        }

        function dim(t: string): any {
            return tray.text(t, { style: { color: "rgba(255,255,255,0.5)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" } })
        }
        function heading(t: string): any {
            return tray.text(t, { style: { fontSize: "11px", fontWeight: "600", letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: "2px" } })
        }
        function divider(): any {
            return tray.div({ items: [], style: { marginTop: "5px", marginBottom: "5px" } })
        }
        function toggleRow(on: boolean, click: string, label: string): any {
            return tray.flex({
                items: [
                    tray.button({ label: on ? "✓" : "✕", onClick: click, intent: "gray-subtle", size: "sm", style: on ? { ...ACCENT_SUBTLE, fontSize: ICON_FS, width: "40px", padding: "0" } : { fontSize: ICON_FS, width: "40px", padding: "0" } }),
                    tray.text(label, { style: { fontSize: "13px", color: "rgba(255,255,255,0.85)", overflowWrap: "anywhere", wordBreak: "break-word" } }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            })
        }
        function panel(rows: any[]): any {
            return tray.stack({
                items: rows,
                gap: 3,
                style: {
                    display: "flex",
                    flexDirection: "column",
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
        }
        function logBox(): any {
            const tail = logs.slice(-30)
            const items = tail.length
                ? tail.map((l) => tray.text(l.length ? l : " ", { style: aqStyle(aqLevelOf(l)) }))
                : [tray.text("(no logs yet — play something and change a track)", { style: { fontSize: "11px", color: "rgba(255,255,255,0.5)" } })]
            return tray.div({
                items: items,
                style: { background: "rgba(0,0,0,0.28)", borderRadius: "10px", padding: "10px 12px", maxHeight: "220px", overflowY: "auto" },
            })
        }

        ctx.registerEventHandler("ap-subs", () => { persistSubs.set(!persistSubs.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-log-copy", () => { try { ctx.dom.clipboard.write(logs.join("\n")) } catch (_e) {} ctx.toast.success("Logs copied to clipboard") })
        ctx.registerEventHandler("ap-log-clear", () => { logs = []; sset(LOG_KEY, logs); ctx.toast.info("Logs cleared"); tray.update() })
        ctx.registerEventHandler("ap-log-toggle", () => { logsOpen.set(!logsOpen.get()); tray.update() })

        function renderTray(): any {
            const rows: any[] = []

            if (!hasVC) {
                rows.push(dim("Needs the Playback permission — re-enable the plugin's permissions or update Seanime."))
                return panel(rows)
            }

            rows.push(heading("Preferences"))
            rows.push(toggleRow(persistSubs.get(), "ap-subs", "Remember player subtitle"))

            rows.push(divider())
            rows.push(tray.flex({
                items: [
                    heading("Logs"),
                    tray.button({ label: logsOpen.get() ? "Hide" : "Show", onClick: "ap-log-toggle", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                    tray.button({ label: "Copy", onClick: "ap-log-copy", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Clear", onClick: "ap-log-clear", intent: "alert-subtle", size: "xs" }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))
            if (logsOpen.get()) rows.push(logBox())
            return panel(rows)
        }

        tray.render(renderTray)
    })
}
