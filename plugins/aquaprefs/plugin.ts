function init() {
    $ui.register((ctx) => {
        const VC = ctx.videoCore
        const hasVC = !!(VC && typeof VC.addEventListener === "function")

        const CFG_KEY = "cfg"
        const IDX_KEY = "pref:__index"
        const LOG_KEY = "log"
        const LOG_CAP = 200
        const EXPORT_MARKER = "AQUAPREFSv1"
        const CLICK_TO_EVENT = 2500
        const GRACE = 700
        const APPLY_GUARD = 1500
        const REARM_DEDUP = 1500
        const REAPPLY_AT = [1500, 3500]
        const OPT_SEL = "[data-vc-element='setting-select-option']"
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
            tray.update()
        }
        function shortPid(pid: string): string {
            const s = String(pid || "")
            return s.length > 14 ? "…" + s.slice(-12) : s
        }

        const cfg = sget<any>(CFG_KEY, {})
        const enabled = ctx.state<boolean>(cfg.enabled !== false)
        const scope = ctx.state<string>(cfg.scope === "episode" || cfg.scope === "series" ? cfg.scope : "global")
        const persistSubs = ctx.state<boolean>(cfg.subs !== false)
        const persistAudio = ctx.state<boolean>(cfg.audio !== false)
        const status = ctx.state<string>("")
        const importRef = ctx.fieldRef<string>("")

        function saveCfg(): void {
            sset(CFG_KEY, { enabled: enabled.get(), scope: scope.get(), subs: persistSubs.get(), audio: persistAudio.get() })
        }

        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/aquaprefs/icon.png",
            withContent: true,
            width: "460px",
        })

        let armedPid = ""
        let lastArmAt = 0
        let pendingClickAt = 0
        let lastEvt: any = null
        let applyingUntil = 0
        let skipClicks = false
        let lastMenu = ""
        let subPicked = false
        let capPicked = false
        let audPicked = false
        let lastAppliedSub = -99
        let lastAppliedAud = -99
        let lastAppliedCap = -99
        let subGen = 0
        let audGen = 0
        let capGen = 0

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

        function writeKey(): string {
            const sc = scope.get()
            if (sc === "global") return "pref:global"
            const mid = curMediaId()
            if (!mid) return "pref:global"
            if (sc === "series") return "pref:m:" + mid
            const ep = curEpisode()
            return ep ? "pref:e:" + mid + ":" + ep : "pref:m:" + mid
        }

        function readCascade(): any {
            const mid = curMediaId()
            const ep = curEpisode()
            const g = sget<any>("pref:global", null)
            const m = mid ? sget<any>("pref:m:" + mid, null) : null
            const e = (mid && ep) ? sget<any>("pref:e:" + mid + ":" + ep, null) : null
            const out: any = {}
            const lvls = [g, m, e]
            for (let i = 0; i < lvls.length; i++) {
                const r = lvls[i]
                if (!r) continue
                if (r.sub) out.sub = r.sub
                if (r.cap) out.cap = r.cap
                if (r.audio) out.audio = r.audio
            }
            return (out.sub || out.cap || out.audio) ? out : null
        }

        function levelsStr(): string {
            const mid = curMediaId(); const ep = curEpisode()
            const hasE = !!((mid && ep) && sget<any>("pref:e:" + mid + ":" + ep, null))
            const hasM = !!(mid && sget<any>("pref:m:" + mid, null))
            const hasG = !!sget<any>("pref:global", null)
            return "e:" + (hasE ? "y" : "-") + " m:" + (hasM ? "y" : "-") + " g:" + (hasG ? "y" : "-")
        }

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

        function applySub(sub: any): void {
            const g = subGen
            if (sub.off) { lastAppliedSub = -1; applyingUntil = nowMs() + APPLY_GUARD; try { VC.setSubtitleTrack(-1) } catch (_e) {} ; log("→ setSubtitleTrack(-1) off"); return }
            VC.getTextTracks().then((tracks) => {
                if (g !== subGen) { log("· applySub bailed (newer action)"); return }
                const n = matchTrack((tracks || []).filter((t) => t.type === "subtitles"), sub)
                if (n !== -2) { lastAppliedSub = n; applyingUntil = nowMs() + APPLY_GUARD; try { VC.setSubtitleTrack(n) } catch (_e) {} ; log("→ setSubtitleTrack(" + n + ") " + (sub.label || sub.language || "")) }
                else { log("· applySub: no match for " + (sub.label || sub.language || "?") + " in tracks") }
            }).catch(() => { log("· applySub: getTextTracks error") })
        }
        function applyCap(cap: any): void {
            const g = capGen
            if (cap.off) { lastAppliedCap = -1; applyingUntil = nowMs() + APPLY_GUARD; try { VC.setMediaCaptionTrack(-1) } catch (_e) {} ; log("→ setMediaCaptionTrack(-1) off"); return }
            VC.getTextTracks().then((tracks) => {
                if (g !== capGen) return
                const n = matchTrack((tracks || []).filter((t) => t.type === "captions"), cap)
                if (n !== -2) { lastAppliedCap = n; applyingUntil = nowMs() + APPLY_GUARD; try { VC.setMediaCaptionTrack(n) } catch (_e) {} ; log("→ setMediaCaptionTrack(" + n + ")") }
                else { log("· applyCap: no caption match") }
            }).catch(() => {})
        }
        function applyAudio(audio: any): void {
            const pi = pinfo()
            const at = (pi && pi.mkvMetadata && pi.mkvMetadata.audioTracks) ? pi.mkvMetadata.audioTracks : []
            const lang = String(audio.language || "").toLowerCase()
            if (at.length && lang) {
                for (let i = 0; i < at.length; i++) {
                    if (String(at[i].language || "").toLowerCase() === lang) { lastAppliedAud = at[i].number; applyingUntil = nowMs() + APPLY_GUARD; try { VC.setAudioTrack(at[i].number) } catch (_e) {} ; log("→ setAudioTrack(" + at[i].number + ") " + (audio.label || audio.language || "")); return }
                }
            }
            log("· applyAudio: no mkv audio match (HLS/online?)")
        }

        function applySaved(kind: string): void {
            const rec = readCascade()
            if (!rec) { log("↻ auto-reapply " + kind + ": nothing saved [" + levelsStr() + "]"); return }
            if (kind === "sub" && persistSubs.get() && rec.sub) { log("↻ auto-reapply sub=" + (rec.sub.off ? "off" : (rec.sub.label || rec.sub.language)) + " [" + levelsStr() + "]"); applySub(rec.sub) }
            else if (kind === "cap" && persistSubs.get() && rec.cap) { log("↻ auto-reapply cap [" + levelsStr() + "]"); applyCap(rec.cap) }
            else if (kind === "aud" && persistAudio.get() && rec.audio) { log("↻ auto-reapply audio [" + levelsStr() + "]"); applyAudio(rec.audio) }
        }

        function applyForCurrent(force: boolean): void {
            if (!enabled.get() || !pinfo()) return
            const where = levelsStr()
            const rec = readCascade()
            if (!rec) { log("↻ timer-reapply [" + where + "]: nothing saved"); return }
            const parts: string[] = []
            if (persistSubs.get()) {
                if (rec.sub && (force || !subPicked)) { applySub(rec.sub); parts.push(rec.sub.off ? "sub=off" : "sub=" + (rec.sub.label || rec.sub.language || "?")) }
                if (rec.cap && (force || !capPicked)) { applyCap(rec.cap); parts.push("cap") }
            }
            if (persistAudio.get() && rec.audio && (force || !audPicked)) { applyAudio(rec.audio); parts.push("audio") }
            log("↻ timer-reapply [" + where + "]: " + (parts.length ? parts.join(", ") : "nothing (already user-picked)"))
        }

        function matchByLabel(list: any[], label: string): any {
            const L = label.toLowerCase()
            const U = label.toUpperCase()
            for (let i = 0; i < list.length; i++) if (String(list[i].label || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toLowerCase() === L) return list[i]
            for (let i = 0; i < list.length; i++) if (String(list[i].language || "").toUpperCase() === U) return list[i]
            return null
        }

        function saveSubByLabel(label: string): void {
            if (/^off$/i.test(label)) { subPicked = true; subGen++; const key = writeKey(); recordTo(key, { sub: { off: true } }); log("✓ saved sub=off @ " + key); return }
            VC.getTextTracks().then((tracks) => {
                const subs = (tracks || []).filter((t) => t.type === "subtitles")
                const caps = (tracks || []).filter((t) => t.type === "captions")
                const m = matchByLabel(subs, label)
                if (m) { subPicked = true; subGen++; const key = writeKey(); recordTo(key, { sub: { off: false, language: m.language, label: m.label } }); log("✓ saved sub=" + (m.label || m.language) + " @ " + key); return }
                const cm = matchByLabel(caps, label)
                if (cm) { capPicked = true; capGen++; const key = writeKey(); recordTo(key, { cap: { off: false, language: cm.language, label: cm.label } }); log("✓ saved cap=" + (cm.label || cm.language) + " @ " + key); return }
                log("· '" + label + "' matched no subtitle track — not saved")
            }).catch(() => { log("· getTextTracks error while saving '" + label + "'") })
        }

        function saveAudByLabel(label: string): void {
            const pi = pinfo()
            const at = (pi && pi.mkvMetadata && pi.mkvMetadata.audioTracks) ? pi.mkvMetadata.audioTracks : []
            const L = label.toLowerCase(); const U = label.toUpperCase()
            for (let i = 0; i < at.length; i++) {
                const nm = String(at[i].name || "").toLowerCase(); const lg = String(at[i].language || "")
                if (nm === L || lg.toLowerCase() === L || lg.toUpperCase() === U) {
                    audPicked = true; audGen++; const key = writeKey(); recordTo(key, { audio: { language: at[i].language || "", label: at[i].name || "" } }); log("✓ saved audio=" + (at[i].name || at[i].language) + " @ " + key); return
                }
            }
            log("· audio '" + label + "' not resolvable (HLS/online?) — not saved")
        }

        function recordByLabel(el: any): void {
            const menu = lastMenu
            const isAudio = /audio/i.test(menu)
            const readLabel = el.query("[data-vc-element='setting-select-option-label']").then((spans: any[]) => {
                const sp = (spans && spans.length) ? spans[0] : el
                return sp.getText()
            })
            readLabel.then((txt: string) => {
                const label = String(txt || "").trim()
                if (!label) { log("· click: could not read label"); return }
                log("· you picked '" + label + "' in " + (menu || "?") + " menu")
                if (isAudio) saveAudByLabel(label)
                else saveSubByLabel(label)
            }).catch(() => { log("· click: could not read label") })
        }

        function picked(kind: string): boolean {
            return kind === "sub" ? subPicked : kind === "cap" ? capPicked : audPicked
        }

        function onTrackEvent(kind: string, v: number): void {
            const lbl = v < 0 ? "off" : "track " + v
            if (nowMs() - pendingClickAt <= CLICK_TO_EVENT) { pendingClickAt = 0; lastEvt = null; log("· " + kind + " " + lbl + " event (your pick — recorded from the menu)"); return }
            const at = nowMs()
            lastEvt = { kind: kind, v: v, at: at }
            log("· " + kind + " " + lbl + " (auto / awaiting click)")
            ctx.setTimeout(() => {
                if (!lastEvt || lastEvt.at !== at) return
                lastEvt = null
                if (picked(kind)) { log("· " + kind + " " + lbl + " left as-is (you picked this playback)"); return }
                applySaved(kind)
            }, GRACE)
        }

        function onOptionClick(el: any): void {
            if (skipClicks) { log("· click ignored (" + (lastMenu || "non-track") + " menu)"); return }
            pendingClickAt = nowMs()
            lastEvt = null
            recordByLabel(el)
        }

        function arm(pid: string, fromLoad: boolean): void {
            if (!pid) return
            if (fromLoad) {
                if (pid === armedPid && nowMs() - lastArmAt < REARM_DEDUP) return
            } else {
                if (pid === armedPid) return
            }
            const reload = (pid === armedPid)
            armedPid = pid
            lastArmAt = nowMs()
            subPicked = false; capPicked = false; audPicked = false
            lastAppliedSub = -99; lastAppliedAud = -99; lastAppliedCap = -99
            subGen++; audGen++; capGen++
            if (fromLoad) { pendingClickAt = 0; lastEvt = null }
            log("▶ LOAD" + (reload ? " (reload, same pid)" : "") + " pid=" + shortPid(pid) + " · scope=" + scope.get() + " · media=" + curMediaId() + " · ep=" + curEpisode())
            for (let i = 0; i < REAPPLY_AT.length; i++) {
                ctx.setTimeout(() => { if (pid === armedPid) applyForCurrent(false) }, REAPPLY_AT[i])
            }
        }

        function menuSkips(t: string): boolean {
            const s = String(t || "").toLowerCase()
            return s.indexOf("quality") >= 0 || s.indexOf("settings") >= 0
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
                            if (t !== lastMenu) { lastMenu = String(t || "").trim(); log("· menu open: " + lastMenu + (skip ? " (clicks ignored)" : "")) }
                            skipClicks = skip
                        }).catch(() => {})
                    } catch (_e) {}
                })
            } catch (_e) {}
            try {
                ctx.dom.observe(OPT_SEL, (els) => {
                    if (!els || !els.length) return
                    for (let i = 0; i < els.length; i++) {
                        try { const el = els[i]; el.addEventListener("click", () => onOptionClick(el)) } catch (_e) {}
                    }
                })
            } catch (_e) {}

            VC.addEventListener("video-loaded", (e) => { if (enabled.get()) arm((e && e.playbackId) || "", true) })
            VC.addEventListener("video-loaded-metadata", (e) => { if (enabled.get()) arm((e && e.playbackId) || "", true) })

            VC.addEventListener("video-subtitle-track", (e) => {
                arm((e && e.playbackId) || "", false)
                if (!enabled.get() || !persistSubs.get()) return
                const v = (typeof e.trackNumber === "number" && e.trackNumber >= 0) ? e.trackNumber : -1
                if (v === lastAppliedSub && nowMs() < applyingUntil) { lastAppliedSub = -99; log("· sub echo (" + (v < 0 ? "off" : "track " + v) + ")"); return }
                onTrackEvent("sub", v)
            })

            VC.addEventListener("video-media-caption-track", (e) => {
                arm((e && e.playbackId) || "", false)
                if (!enabled.get() || !persistSubs.get()) return
                const v = (typeof e.trackIndex === "number" && e.trackIndex >= 0) ? e.trackIndex : -1
                if (v === lastAppliedCap && nowMs() < applyingUntil) { lastAppliedCap = -99; log("· cap echo (" + (v < 0 ? "off" : "track " + v) + ")"); return }
                onTrackEvent("cap", v)
            })

            VC.addEventListener("video-audio-track", (e) => {
                arm((e && e.playbackId) || "", false)
                if (!enabled.get() || !persistAudio.get()) return
                const v = (typeof e.trackNumber === "number") ? e.trackNumber : -9
                if (v === lastAppliedAud && nowMs() < applyingUntil) { lastAppliedAud = -99; log("· audio echo (track " + v + ")"); return }
                onTrackEvent("aud", v)
            })
        }

        function exportPrefs(): void {
            const idx = sget<string[]>(IDX_KEY, [])
            const prefs: any = {}
            for (let i = 0; i < idx.length; i++) { const r = sget<any>(idx[i], null); if (r) prefs[idx[i]] = r }
            const blob = { marker: EXPORT_MARKER, v: 1, cfg: { enabled: enabled.get(), scope: scope.get(), subs: persistSubs.get(), audio: persistAudio.get() }, prefs: prefs }
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
                if (blob.cfg.scope === "episode" || blob.cfg.scope === "series" || blob.cfg.scope === "global") scope.set(blob.cfg.scope)
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
        function scopeBtn(id: string, label: string): any {
            return tray.button({ label: label, onClick: "ap-scope-" + id, intent: scope.get() === id ? "primary" : "gray-subtle", size: "sm" })
        }
        function logBox(): any {
            const tail = logs.slice(-60).join("\n")
            return tray.div({
                items: [tray.text(tail || "(no logs yet — play something and change a track)", { style: { fontFamily: "monospace", fontSize: "11px", lineHeight: "1.45", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", color: "rgba(255,255,255,0.72)" } })],
                style: { maxHeight: "200px", overflowY: "auto", background: "rgba(0,0,0,0.35)", borderRadius: "6px", padding: "8px", border: "1px solid rgba(255,255,255,0.08)" },
            })
        }

        ctx.registerEventHandler("ap-toggle", () => { enabled.set(!enabled.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-subs", () => { persistSubs.set(!persistSubs.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-audio", () => { persistAudio.set(!persistAudio.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-scope-episode", () => { scope.set("episode"); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-scope-series", () => { scope.set("series"); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-scope-global", () => { scope.set("global"); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-apply-now", () => { applyForCurrent(true); status.set("Re-applied to the current playback."); tray.update() })
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

            rows.push(heading("Persist across"))
            rows.push(tray.flex({ items: [scopeBtn("episode", "Episode"), scopeBtn("series", "Series"), scopeBtn("global", "Everything")], gap: 2 }))

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
