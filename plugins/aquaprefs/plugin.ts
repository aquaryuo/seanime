function init() {
    $ui.register((ctx) => {
        const VC = ctx.videoCore
        const hasVC = !!(VC && typeof VC.addEventListener === "function")

        const CFG_KEY = "cfg"
        const IDX_KEY = "pref:__index"
        const SUPPRESS_MS = 2500
        const APPLY_DELAY_MS = 500
        const APPLY_DELAY_MS2 = 1700
        const EXPORT_MARKER = "AQUAPREFSv1"

        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return (v === undefined || v === null) ? d : v } catch (_e) { return d }
        }
        function sset(k: string, v: any): void { try { $storage.set(k, v) } catch (_e) {} }
        function nowMs(): number { try { return Date.now() } catch (_e) { return 0 } }

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
            width: "440px",
        })

        let suppressUntil = 0
        let armedPid = ""
        let seenSub = ""
        let seenAudio = ""
        let seenCap = ""
        let dbgEvent = "(nothing yet)"
        let dbgApply = "(nothing yet)"

        function suppress(): void { suppressUntil = nowMs() + SUPPRESS_MS }
        function arm(pid: string): void {
            if (!pid || pid === armedPid) return
            armedPid = pid
            ctx.setTimeout(() => applyForCurrent(), APPLY_DELAY_MS)
            ctx.setTimeout(() => applyForCurrent(), APPLY_DELAY_MS2)
        }

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
            if (!mid) return ""
            if (sc === "series") return "pref:m:" + mid
            const ep = curEpisode()
            return ep ? "pref:e:" + mid + ":" + ep : "pref:m:" + mid
        }

        function readCascade(): any {
            const mid = curMediaId()
            const ep = curEpisode()
            const keys: string[] = []
            if (mid && ep) keys.push("pref:e:" + mid + ":" + ep)
            if (mid) keys.push("pref:m:" + mid)
            keys.push("pref:global")
            for (let i = 0; i < keys.length; i++) { const r = sget<any>(keys[i], null); if (r) return r }
            return null
        }

        function indexAdd(k: string): void {
            const idx = sget<string[]>(IDX_KEY, [])
            if (idx.indexOf(k) < 0) { idx.push(k); sset(IDX_KEY, idx) }
        }
        function record(patch: any): void {
            const k = writeKey()
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
            if (sub.off) { suppress(); try { VC.setSubtitleTrack(-1) } catch (_e) {} ; return }
            VC.getTextTracks().then((tracks) => {
                const n = matchTrack((tracks || []).filter((t) => t.type === "subtitles"), sub)
                if (n !== -2) { suppress(); try { VC.setSubtitleTrack(n) } catch (_e) {} }
            }).catch(() => {})
        }
        function applyCap(cap: any): void {
            if (cap.off) { suppress(); try { VC.setMediaCaptionTrack(-1) } catch (_e) {} ; return }
            VC.getTextTracks().then((tracks) => {
                const n = matchTrack((tracks || []).filter((t) => t.type === "captions"), cap)
                if (n !== -2) { suppress(); try { VC.setMediaCaptionTrack(n) } catch (_e) {} }
            }).catch(() => {})
        }
        function applyAudio(audio: any): void {
            const pi = pinfo()
            const at = (pi && pi.mkvMetadata && pi.mkvMetadata.audioTracks) ? pi.mkvMetadata.audioTracks : []
            const lang = String(audio.language || "").toLowerCase()
            if (at.length && lang) {
                for (let i = 0; i < at.length; i++) {
                    if (String(at[i].language || "").toLowerCase() === lang) { suppress(); try { VC.setAudioTrack(at[i].number) } catch (_e) {} ; return }
                }
            }
            if (typeof audio.index === "number" && audio.index >= 0) { suppress(); try { VC.setAudioTrack(audio.index) } catch (_e) {} }
        }

        function applyForCurrent(): void {
            if (!enabled.get() || !pinfo()) return
            const rec = readCascade()
            if (!rec) { dbgApply = "reapply: nothing saved for this scope"; tray.update(); return }
            const parts: string[] = []
            if (persistSubs.get()) {
                if (rec.sub) { applySub(rec.sub); parts.push(rec.sub.off ? "sub=off" : "sub=" + (rec.sub.label || rec.sub.language || "?")) }
                if (rec.cap) { applyCap(rec.cap); parts.push(rec.cap.off ? "cap=off" : "cap=" + (rec.cap.label || rec.cap.language || "?")) }
            }
            if (persistAudio.get() && rec.audio) { applyAudio(rec.audio); parts.push("audio=" + (rec.audio.label || rec.audio.language || ("#" + rec.audio.index))) }
            dbgApply = parts.length ? "reapply: " + parts.join(", ") : "reapply: nothing to apply"
            tray.update()
        }

        if (hasVC) {
            VC.addEventListener("video-loaded", (e) => { if (enabled.get()) arm((e && e.playbackId) || "") })
            VC.addEventListener("video-loaded-metadata", (e) => { if (enabled.get()) arm((e && e.playbackId) || "") })

            VC.addEventListener("video-subtitle-track", (e) => {
                const pid = (e && e.playbackId) || ""
                arm(pid)
                if (pid !== seenSub) { seenSub = pid; dbgEvent = "sub auto-default ignored (track " + e.trackNumber + ")"; return }
                if (!enabled.get() || !persistSubs.get() || nowMs() < suppressUntil) { dbgEvent = "sub change ignored (settling)"; return }
                if (e.trackNumber < 0) { record({ sub: { off: true } }); dbgEvent = "saved: sub=off"; tray.update(); return }
                VC.getTextTracks().then((tracks) => {
                    const m = (tracks || []).filter((t) => t.type === "subtitles" && t.number === e.trackNumber)[0]
                    if (m) { record({ sub: { off: false, language: m.language, label: m.label } }); dbgEvent = "saved: sub=" + (m.label || m.language); tray.update() }
                }).catch(() => {})
            })

            VC.addEventListener("video-media-caption-track", (e) => {
                const pid = (e && e.playbackId) || ""
                arm(pid)
                if (pid !== seenCap) { seenCap = pid; return }
                if (!enabled.get() || !persistSubs.get() || nowMs() < suppressUntil) return
                if (e.trackIndex < 0) { record({ cap: { off: true } }); dbgEvent = "saved: cap=off"; tray.update(); return }
                VC.getTextTracks().then((tracks) => {
                    const m = (tracks || []).filter((t) => t.type === "captions" && t.number === e.trackIndex)[0]
                    if (m) { record({ cap: { off: false, language: m.language, label: m.label } }); dbgEvent = "saved: cap=" + (m.label || m.language); tray.update() }
                }).catch(() => {})
            })

            VC.addEventListener("video-audio-track", (e) => {
                const pid = (e && e.playbackId) || ""
                arm(pid)
                if (pid !== seenAudio) { seenAudio = pid; dbgEvent = "audio auto-default ignored (track " + e.trackNumber + ")"; return }
                if (!enabled.get() || !persistAudio.get() || nowMs() < suppressUntil) return
                const rec: any = { index: e.trackNumber }
                const pi = pinfo()
                const at = (pi && pi.mkvMetadata && pi.mkvMetadata.audioTracks) ? pi.mkvMetadata.audioTracks : []
                const m = at.filter((t: any) => t.number === e.trackNumber)[0]
                if (m) { rec.language = m.language || ""; rec.label = m.name || "" }
                record({ audio: rec })
                dbgEvent = "saved: audio=" + (rec.label || rec.language || ("#" + rec.index))
                tray.update()
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
            let ok = false
            try { ctx.dom.clipboard.write(json); ok = true } catch (_e) {}
            if (ok) ctx.toast.success("Preferences exported to clipboard")
            status.set(ok ? "Copied " + Object.keys(prefs).length + " saved choice(s) to the clipboard." : "Couldn't access the clipboard.")
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
            for (let i = 0; i < idx.length; i++) sset(idx[i], null)
            sset(IDX_KEY, [])
            ctx.toast.info("Preferences cleared")
            status.set("Cleared all saved choices.")
            tray.update()
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

        ctx.registerEventHandler("ap-toggle", () => { enabled.set(!enabled.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-subs", () => { persistSubs.set(!persistSubs.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-audio", () => { persistAudio.set(!persistAudio.get()); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-scope-episode", () => { scope.set("episode"); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-scope-series", () => { scope.set("series"); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-scope-global", () => { scope.set("global"); saveCfg(); tray.update() })
        ctx.registerEventHandler("ap-apply-now", () => { applyForCurrent(); status.set("Re-applied to the current playback."); tray.update() })
        ctx.registerEventHandler("ap-export", () => exportPrefs())
        ctx.registerEventHandler("ap-import", () => importPrefs())
        ctx.registerEventHandler("ap-reset", () => resetPrefs())

        tray.render(() => {
            const rows: any[] = []
            rows.push(tray.flex({
                items: [
                    tray.text("Aqua's Prefs", { style: { fontWeight: "600", fontSize: "15px" } }),
                    enabled.get() ? tray.badge({ text: "On", intent: "success", size: "sm" }) : tray.badge({ text: "Off", intent: "gray", size: "sm" }),
                ],
                gap: 2,
            }))
            if (!hasVC) {
                rows.push(dim("Player control is unavailable — this needs the Playback permission (and a Seanime build with videoCore). Re-enable the plugin's permissions or update Seanime."))
                return tray.stack({ items: rows, gap: 3 })
            }
            rows.push(dim("Remembers your subtitle on/off, sub/caption track and audio (dub/sub) track, and re-applies them every new episode — across series and all built-in-player sources."))
            rows.push(tray.button({ label: enabled.get() ? "✓ Enabled" : "Enable", onClick: "ap-toggle", intent: enabled.get() ? "success-subtle" : "gray-subtle", size: "sm" }))

            rows.push(divider())
            rows.push(heading("Persist across"))
            rows.push(tray.flex({ items: [scopeBtn("episode", "Episode"), scopeBtn("series", "Series"), scopeBtn("global", "Everything")], gap: 2 }))
            rows.push(dim(scope.get() === "global"
                ? "One choice applies to every series and every source."
                : scope.get() === "series"
                    ? "Saved per series, applied across its episodes (falls back to your global choice)."
                    : "Saved per episode (falls back to the series, then global)."))

            rows.push(divider())
            rows.push(heading("What to keep"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: persistSubs.get() ? "✓ Subtitles (on/off & track)" : "Subtitles: not kept", onClick: "ap-subs", intent: persistSubs.get() ? "success-subtle" : "gray-subtle", size: "sm" }),
                    tray.button({ label: persistAudio.get() ? "✓ Audio · dub/sub" : "Audio: not kept", onClick: "ap-audio", intent: persistAudio.get() ? "success-subtle" : "gray-subtle", size: "sm" }),
                ],
                gap: 2,
            }))
            rows.push(dim(summary()))
            rows.push(tray.button({ label: "Re-apply to current playback", onClick: "ap-apply-now", intent: "gray-subtle", size: "xs" }))

            rows.push(divider())
            rows.push(heading("Backup"))
            rows.push(tray.flex({
                items: [
                    tray.button({ label: "Export (copy)", onClick: "ap-export", intent: "gray-subtle", size: "xs" }),
                    tray.button({ label: "Reset all", onClick: "ap-reset", intent: "alert-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
            }))
            rows.push(tray.input({ fieldRef: importRef, placeholder: "Paste an exported blob, then Import…" }))
            rows.push(tray.button({ label: "Import", onClick: "ap-import", intent: "primary-subtle", size: "xs" }))
            if (status.get()) rows.push(dim(status.get()))

            rows.push(divider())
            rows.push(heading("Debug"))
            rows.push(dim("last event — " + dbgEvent))
            rows.push(dim(dbgApply))
            rows.push(dim("playback " + (armedPid ? String(armedPid).slice(0, 8) : "—") + " · media " + (curMediaId() || "—") + " · ep " + (curEpisode() || "—")))

            rows.push(divider())
            rows.push(dim("Applies to Seanime's built-in player. Online dub/sub is chosen by the provider (a different episode list), so it isn't auto-switched here. The external MPV player isn't covered."))
            return tray.stack({ items: rows, gap: 3 })
        })
    })
}
