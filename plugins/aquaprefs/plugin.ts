function init() {
    $ui.register((ctx) => {
        const VC = ctx.videoCore
        const hasVC = !!(VC && typeof VC.addEventListener === "function")

        const CFG_KEY = "cfg"
        const IDX_KEY = "pref:__index"
        const LOG_KEY = "log"
        const LOG_CAP = 30
        const EXPORT_MARKER = "AQUAPREFSv1"
        const CLICK_SUPPRESS = 2500
        const GRACE = 450
        const PICK_PENDING_MAX = 4000
        const POLL_ATTEMPTS = 8
        const POLL_INTERVAL = 350
        const MAX_CORRECTIONS = 8
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
        function clock(): string {
            try {
                const d = new Date()
                const p2 = (n: number) => (n < 10 ? "0" : "") + n
                const p3 = (n: number) => (n < 100 ? (n < 10 ? "00" : "0") : "") + n
                return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds())
            } catch (_e) { return "" }
        }
        function log(msg: string): void {
            logs.push(clock() + "  " + msg)
            if (logs.length > LOG_CAP) logs = logs.slice(logs.length - LOG_CAP)
            sset(LOG_KEY, logs)
            try { tray.update() } catch (_e) {}
        }
        function shortPid(pid: string): string {
            const s = String(pid || "")
            return s.length > 14 ? "…" + s.slice(-12) : s
        }

        const cfg = sget<any>(CFG_KEY, {})
        const enabled = ctx.state<boolean>(cfg.enabled !== false)
        const persistSubs = ctx.state<boolean>(cfg.subs !== false)
        const persistAudio = ctx.state<boolean>(cfg.audio !== false)
        const status = ctx.state<string>("")
        const importRef = ctx.fieldRef<string>("")

        function saveCfg(): void {
            sset(CFG_KEY, { enabled: enabled.get(), subs: persistSubs.get(), audio: persistAudio.get() })
        }

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/aquaprefs/icon.png",
            withContent: true,
            width: "460px",
        })

        let gen = 0
        let armedPid = ""
        let lastArmAt = 0
        let lastMenu = ""
        let skipClicks = false
        const boundOpts: any = {}
        const pendingClick: any = { sub: 0, cap: 0, aud: 0 }
        const pickPending: any = { sub: false, cap: false, aud: false }
        const enforceCount: any = { sub: 0, cap: 0, aud: 0 }
        const lastDesired: any = { sub: -999, cap: -999, aud: -999 }
        const stopEnforce: any = { sub: false, cap: false, aud: false }
        const curTrack: any = { sub: -999, cap: -999, aud: -999 }
        const enforceTok: any = { sub: 0, cap: 0, aud: 0 }

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
            return (g.sub || g.cap || g.audio) ? g : null
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
        function matchTrack(list: any[], want: any): number {
            const lang = String(want.language || "").toLowerCase()
            const label = String(want.label || "").toLowerCase()
            for (let i = 0; i < list.length; i++) if (lang && String(list[i].language || "").toLowerCase() === lang) return list[i].number
            for (let i = 0; i < list.length; i++) if (label && String(list[i].label || "").toLowerCase() === label) return list[i].number
            return -2
        }
        function matchByLabel(list: any[], label: string): any {
            const L = label.toLowerCase(); const U = label.toUpperCase()
            for (let i = 0; i < list.length; i++) if (String(list[i].label || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toUpperCase() === U) return list[i]
            return null
        }
        function matchAudio(at: any[], want: any): number {
            const lang = String(want.language || "").toLowerCase()
            const label = String(want.label || "").toLowerCase()
            for (let i = 0; i < at.length; i++) if (lang && String(at[i].language || "").toLowerCase() === lang) return at[i].number
            for (let i = 0; i < at.length; i++) if (label && String(at[i].name || "").toLowerCase() === label) return at[i].number
            return -2
        }

        function savedFor(kind: string): any {
            const rec = readCascade()
            if (!rec) return null
            return kind === "sub" ? (rec.sub || null) : kind === "cap" ? (rec.cap || null) : (rec.audio || null)
        }
        function enabledFor(kind: string): boolean { return kind === "aud" ? persistAudio.get() : persistSubs.get() }

        function setKind(kind: string, n: number, myGen: number): void {
            if (myGen !== gen) return
            if (n === lastDesired[kind]) {
                enforceCount[kind]++
                if (enforceCount[kind] > MAX_CORRECTIONS) {
                    if (!stopEnforce[kind]) { stopEnforce[kind] = true; log("⚠ " + kind + " enforcement paused — player keeps overriding (" + n + ")") }
                    return
                }
            } else { lastDesired[kind] = n; enforceCount[kind] = 1 }
            try {
                if (kind === "sub") VC.setSubtitleTrack(n)
                else if (kind === "cap") VC.setMediaCaptionTrack(n)
                else VC.setAudioTrack(n)
                log("→ " + (kind === "sub" ? "setSubtitleTrack" : kind === "cap" ? "setMediaCaptionTrack" : "setAudioTrack") + "(" + n + ")")
            } catch (_e) {}
        }

        function enforceKind(kind: string, current: number, myGen: number): Promise<string> {
            if (myGen !== gen) return Promise.resolve("stale")
            if (!enabled.get()) return Promise.resolve("off")
            if (stopEnforce[kind]) return Promise.resolve("stopped")
            if (pickPending[kind] || nowMs() - pendingClick[kind] <= CLICK_SUPPRESS) return Promise.resolve("user")
            if (!enabledFor(kind)) return Promise.resolve("disabled")
            const sv = savedFor(kind)
            if (!sv) return Promise.resolve("none")
            if (current === -999) return Promise.resolve("unknown")
            if (kind === "aud") {
                const pi = pinfo()
                const at = (pi && pi.mkvMetadata && pi.mkvMetadata.audioTracks) ? pi.mkvMetadata.audioTracks : []
                if (!at.length) return Promise.resolve("no-tracks")
                const n = matchAudio(at, sv)
                if (n === -2) return Promise.resolve("no-match")
                if (current === n) { enforceCount.aud = 0; return Promise.resolve("ok") }
                setKind("aud", n, myGen); return Promise.resolve("applied")
            }
            return VC.getTextTracks().then((tracks) => {
                if (myGen !== gen) return "stale"
                const subs = (tracks || []).filter((t) => t.type === "subtitles")
                const caps = (tracks || []).filter((t) => t.type === "captions")
                if (!subs.length && !caps.length) return "no-tracks"
                if (sv.off) {
                    if (current === -1) { enforceCount[kind] = 0; return "ok" }
                    setKind(kind, -1, myGen); return "applied"
                }
                const list = kind === "cap" ? caps : subs
                const n = matchTrack(list, sv)
                if (n === -2) { return "no-match" }
                if (current === n) { enforceCount[kind] = 0; return "ok" }
                setKind(kind, n, myGen); return "applied"
            }).catch(() => "error")
        }

        function scheduleEnforce(kind: string): void {
            if (stopEnforce[kind]) return
            enforceTok[kind]++
            const tok = enforceTok[kind]
            const myGen = gen
            ctx.setTimeout(() => {
                if (myGen !== gen || enforceTok[kind] !== tok) return
                enforceKind(kind, curTrack[kind], myGen)
            }, GRACE)
        }

        function pollLoad(myGen: number, attempt: number): void {
            if (myGen !== gen || !enabled.get()) return
            if (persistAudio.get() && curTrack.aud === -999 && savedFor("aud") && VC && typeof (VC as any).sendGetAudioTrack === "function") {
                try { (VC as any).sendGetAudioTrack() } catch (_e) {}
            }
            Promise.all([
                enforceKind("sub", curTrack.sub, myGen),
                enforceKind("cap", curTrack.cap, myGen),
                enforceKind("aud", curTrack.aud, myGen),
            ]).then((st) => {
                if (myGen !== gen) return
                if ((st.indexOf("no-tracks") >= 0 || st.indexOf("unknown") >= 0) && attempt < POLL_ATTEMPTS) {
                    ctx.setTimeout(() => pollLoad(myGen, attempt + 1), POLL_INTERVAL)
                }
            }).catch(() => {})
        }

        function arm(pid: string, fromLoad: boolean): void {
            if (!pid) return
            if (fromLoad) { if (pid === armedPid && nowMs() - lastArmAt < REARM_DEDUP) return }
            else { if (pid === armedPid) return }
            const reload = (pid === armedPid)
            armedPid = pid
            lastArmAt = nowMs()
            gen++
            const ks = ["sub", "cap", "aud"]
            for (let i = 0; i < ks.length; i++) { const k = ks[i]; enforceCount[k] = 0; lastDesired[k] = -999; stopEnforce[k] = false; pickPending[k] = false; pendingClick[k] = 0; curTrack[k] = -999 }
            for (const id in boundOpts) delete boundOpts[id]
            log("▶ LOAD" + (reload ? " (reload)" : "") + " pid=" + shortPid(pid) + " · " + ctxStr())
            pollLoad(gen, 0)
        }

        function menuSkips(t: string): boolean {
            const s = String(t || "").toLowerCase()
            return s.indexOf("quality") >= 0 || s.indexOf("settings") >= 0
        }

        function saveAudByLabel(label: string): void {
            const pi = pinfo()
            const at = (pi && pi.mkvMetadata && pi.mkvMetadata.audioTracks) ? pi.mkvMetadata.audioTracks : []
            const L = label.toLowerCase(); const U = label.toUpperCase()
            for (let i = 0; i < at.length; i++) {
                const nm = String(at[i].name || "").toLowerCase(); const lg = String(at[i].language || "")
                if (nm === L || lg.toLowerCase() === L || lg.toUpperCase() === U) {
                    const key = writeKey(); recordTo(key, { audio: { language: at[i].language || "", label: at[i].name || "" } }); log("✓ saved audio=" + (at[i].name || at[i].language) + " @ " + key); return
                }
            }
            log("· audio '" + label + "' not resolvable (HLS/online?) — not saved")
        }

        function recordByLabel(el: any, isAudio: boolean, done: () => void): void {
            el.query(LABEL_SEL).then((spans: any[]) => {
                const sp = (spans && spans.length) ? spans[0] : el
                return sp.getText()
            }).then((txt: string) => {
                const label = String(txt || "").trim()
                if (!label) { log("· click: could not read label"); done(); return }
                log("· you picked '" + label + "' (" + (lastMenu || "?") + ")")
                if (isAudio) { saveAudByLabel(label); done(); return }
                if (/^off$/i.test(label)) { const key = writeKey(); recordTo(key, { sub: { off: true }, cap: null }); log("✓ saved sub=off @ " + key); done(); return }
                VC.getTextTracks().then((tracks) => {
                    const subs = (tracks || []).filter((t) => t.type === "subtitles")
                    const caps = (tracks || []).filter((t) => t.type === "captions")
                    const m = matchByLabel(subs, label)
                    if (m) { const key = writeKey(); recordTo(key, { sub: { off: false, language: m.language, label: m.label }, cap: null }); log("✓ saved sub=" + (m.label || m.language) + " @ " + key); done(); return }
                    const cm = matchByLabel(caps, label)
                    if (cm) { const key = writeKey(); recordTo(key, { cap: { off: false, language: cm.language, label: cm.label }, sub: null }); log("✓ saved cap=" + (cm.label || cm.language) + " @ " + key); done(); return }
                    log("· '" + label + "' matched no track — not saved"); done()
                }).catch(() => { log("· getTextTracks error"); done() })
            }).catch(() => { log("· click: could not read label"); done() })
        }

        function onOptionClick(el: any): void {
            if (skipClicks) { log("· click ignored (" + (lastMenu || "?") + ")"); return }
            const isAudio = /audio/i.test(lastMenu)
            const kinds = isAudio ? ["aud"] : ["sub", "cap"]
            const t = nowMs()
            for (let i = 0; i < kinds.length; i++) { pendingClick[kinds[i]] = t; pickPending[kinds[i]] = true }
            const clearPending = () => { for (let i = 0; i < kinds.length; i++) pickPending[kinds[i]] = false }
            ctx.setTimeout(clearPending, PICK_PENDING_MAX)
            recordByLabel(el, isAudio, clearPending)
        }

        if (hasVC) {
            log("◆ plugin loaded (enabled=" + enabled.get() + ")")
            try {
                ctx.dom.observe(TITLE_SEL, (els) => {
                    if (!els || !els.length) return
                    const el = els[els.length - 1]
                    try {
                        el.getText().then((t) => {
                            const skip = menuSkips(t)
                            const name = String(t || "").trim()
                            if (name && name !== lastMenu) { lastMenu = name; log("· menu open: " + name + (skip ? " (clicks ignored)" : "")) }
                            skipClicks = skip
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

            VC.addEventListener("video-loaded", (e) => { if (enabled.get()) arm((e && e.playbackId) || "", true) })
            VC.addEventListener("video-loaded-metadata", (e) => { if (enabled.get()) arm((e && e.playbackId) || "", true) })

            VC.addEventListener("video-subtitle-track", (e) => {
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackNumber === "number" && e.trackNumber >= 0) ? e.trackNumber : -1
                curTrack.sub = v
                if (!enabled.get()) return
                scheduleEnforce("sub")
            })
            VC.addEventListener("video-media-caption-track", (e) => {
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackIndex === "number" && e.trackIndex >= 0) ? e.trackIndex : -1
                curTrack.cap = v
                if (!enabled.get()) return
                scheduleEnforce("cap")
            })
            VC.addEventListener("video-audio-track", (e) => {
                arm((e && e.playbackId) || "", false)
                const v = (typeof e.trackNumber === "number") ? e.trackNumber : -999
                if (v !== -999) curTrack.aud = v
                if (!enabled.get()) return
                scheduleEnforce("aud")
            })
        }

        function exportPrefs(): void {
            const idx = sget<string[]>(IDX_KEY, [])
            const prefs: any = {}
            for (let i = 0; i < idx.length; i++) { const r = sget<any>(idx[i], null); if (r) prefs[idx[i]] = r }
            const blob = { marker: EXPORT_MARKER, v: 1, cfg: { enabled: enabled.get(), subs: persistSubs.get(), audio: persistAudio.get() }, prefs: prefs }
            let json = ""
            try { json = JSON.stringify(blob) } catch (_e) { json = "" }
            if (!json) { status.set("Export failed."); tray.update(); return }
            try { ctx.dom.clipboard.write(json) } catch (_e) {}
            ctx.toast.success("Preferences sent to clipboard")
            status.set("Sent " + Object.keys(prefs).length + " saved choice(s) to the clipboard.")
            tray.update()
        }
        function importPrefs(): void {
            const raw = String(importRef.current || "").trim()
            if (!raw) { status.set("Paste an exported blob into the box first."); tray.update(); return }
            let blob: any = null
            try { blob = JSON.parse(raw) } catch (_e) { blob = null }
            if (!blob || blob.marker !== EXPORT_MARKER || !blob.prefs) { status.set("That isn't a valid preferences export."); tray.update(); return }
            const idx = sget<string[]>(IDX_KEY, [])
            let n = 0
            for (const k in blob.prefs) {
                if (k.indexOf("pref:") !== 0 || k === IDX_KEY) continue
                sset(k, blob.prefs[k]); if (idx.indexOf(k) < 0) idx.push(k); n++
            }
            sset(IDX_KEY, idx)
            if (blob.cfg) {
                if (typeof blob.cfg.enabled === "boolean") enabled.set(blob.cfg.enabled)
                if (typeof blob.cfg.subs === "boolean") persistSubs.set(blob.cfg.subs)
                if (typeof blob.cfg.audio === "boolean") persistAudio.set(blob.cfg.audio)
                saveCfg()
            }
            importRef.setValue("")
            ctx.toast.success("Preferences imported")
            status.set("Imported " + n + " saved choice(s).")
            tray.update()
        }
        function resetPrefs(): void {
            const idx = sget<string[]>(IDX_KEY, [])
            for (let i = 0; i < idx.length; i++) { try { ($storage as any).remove(idx[i]) } catch (_e) { sset(idx[i], null) } }
            sset(IDX_KEY, [])
            ctx.toast.info("Preferences cleared")
            status.set("Cleared all saved choices.")
            log("✗ all saved preferences cleared")
        }
        function summary(): string {
            const rec = readCascade()
            if (!rec) return "Nothing saved yet — set your subtitle/audio in the player and it'll be remembered for next time."
            const parts: string[] = []
            if (rec.sub) parts.push(rec.sub.off ? "subtitles: Off" : "subtitles: " + (rec.sub.label || rec.sub.language || "track"))
            if (rec.cap) parts.push("caption: " + (rec.cap.label || rec.cap.language || "track"))
            if (rec.audio) parts.push("audio: " + (rec.audio.label || rec.audio.language || ("track #" + rec.audio.index)))
            return parts.length ? "Remembered: " + parts.join("  ·  ") : "Nothing saved yet."
        }

        function dim(t: string): any {
            return tray.text(t, { style: { color: "rgba(255,255,255,0.5)", fontSize: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" } })
        }
        function heading(t: string): any {
            return tray.text(t, { style: { fontSize: "11px", fontWeight: "600", letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginTop: "2px" } })
        }
        function divider(): any {
            return tray.div({ items: [], style: { borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: "4px", marginBottom: "4px" } })
        }
        function logBox(): any {
            const tail = logs.slice(-30).join("\n")
            return tray.div({
                items: [tray.text(tail || "(no logs yet — play something and change a track)", { style: { fontFamily: "monospace", fontSize: "11px", lineHeight: "1.45", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", color: "rgba(255,255,255,0.72)" } })],
                style: { maxHeight: "200px", overflowY: "auto", background: "rgba(0,0,0,0.35)", borderRadius: "6px", padding: "8px", border: "1px solid rgba(255,255,255,0.08)" },
            })
        }

        ctx.registerEventHandler("ap-toggle", () => { enabled.set(!enabled.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-subs", () => { persistSubs.set(!persistSubs.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-audio", () => { persistAudio.set(!persistAudio.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-apply-now", () => {
            const ks = ["sub", "cap", "aud"]
            for (let i = 0; i < ks.length; i++) { const k = ks[i]; stopEnforce[k] = false; enforceCount[k] = 0; lastDesired[k] = -999; pickPending[k] = false; pendingClick[k] = 0; curTrack[k] = -1000 }
            gen++; log("↻ manual re-apply"); pollLoad(gen, 0); status.set("Re-applying saved choices…"); tray.update()
        })
        ctx.registerEventHandler("ap-export", () => exportPrefs())
        ctx.registerEventHandler("ap-import", () => importPrefs())
        ctx.registerEventHandler("ap-reset", () => resetPrefs())
        ctx.registerEventHandler("ap-log-copy", () => { try { ctx.dom.clipboard.write(logs.join("\n")) } catch (_e) {} ctx.toast.success("Logs copied to clipboard") })
        ctx.registerEventHandler("ap-log-clear", () => { logs = []; sset(LOG_KEY, logs); ctx.toast.info("Logs cleared"); tray.update() })

        tray.render(() => {
            const rows: any[] = []
            rows.push(tray.flex({
                items: [
                    tray.text("Aqua's Prefs", { style: { fontWeight: "600", fontSize: "15px" } }),
                    tray.button({ label: enabled.get() ? "On" : "Off", onClick: "ap-toggle", intent: enabled.get() ? "success-subtle" : "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            if (!hasVC) {
                rows.push(dim("Needs the Playback permission — re-enable the plugin's permissions or update Seanime."))
                return tray.stack({ items: rows, gap: 3 })
            }

            rows.push(heading("Keep"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: (persistSubs.get() ? "✓ " : "") + "Subtitles", onClick: "ap-subs", intent: persistSubs.get() ? "success-subtle" : "gray-subtle", size: "sm" }),
                    tray.button({ label: (persistAudio.get() ? "✓ " : "") + "Audio (dub/sub)", onClick: "ap-audio", intent: persistAudio.get() ? "success-subtle" : "gray-subtle", size: "sm" }),
                ],
                gap: 2,
            }))
            rows.push(dim(summary()))

            rows.push(divider())
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Re-apply now", onClick: "ap-apply-now", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Export", onClick: "ap-export", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Import", onClick: "ap-import", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Reset", onClick: "ap-reset", intent: "alert-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            rows.push(tray.input({ fieldRef: importRef, placeholder: "Paste export to import" }))
            if (status.get()) rows.push(dim(status.get()))

            rows.push(divider())
            rows.push(tray.flex({
                items: [
                    heading("Logs"),
                    tray.button({ label: "Copy", onClick: "ap-log-copy", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                    tray.button({ label: "Clear", onClick: "ap-log-clear", intent: "alert-subtle", size: "xs" }),
                ],
                gap: 2,
            }))
            rows.push(logBox())
            return tray.stack({ items: rows, gap: 3 })
        })
    })
}
