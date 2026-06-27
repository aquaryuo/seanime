function init() {
    $ui.register((ctx) => {
        const SRC = "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/main/Marketplace/Main.json"
        const ICON = "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/seatags/icon.png"
        const CACHE_KEY = "seatags:cache"
        const CACHE_TTL = 3600000

        type Entry = {
            id?: string
            name?: string
            author?: string
            version?: string
            type?: string
            stars?: number
            flags?: string
            workingTag?: boolean
            brokenTag?: boolean
            deprecatedTag?: boolean
        }

        let entries: Entry[] = []
        let lastAt = 0
        const tag = ctx.state<string>("all")
        const kind = ctx.state<string>("all")
        const status = ctx.state<string>("")

        function now(): number {
            try { return Date.now() } catch (_e) { return 0 }
        }
        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return v === undefined || v === null ? d : v } catch (_e) { return d }
        }

        const boot = sget<{ at: number; data: Entry[] }>(CACHE_KEY, { at: 0, data: [] })
        if (boot.data && boot.data.length > 0) {
            entries = boot.data
            lastAt = boot.at
        }

        const tray = ctx.newTray({ iconUrl: ICON, withContent: true, width: "480px" })

        let inflight = false
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entries.length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            status.set("loading")
            try { tray.update() } catch (_e) {}
            let msg = ""
            try {
                const res = await fetch(SRC, { timeout: 15 })
                if (!res.ok) {
                    msg = "fetch failed (HTTP " + res.status + ")"
                } else {
                    const data = res.json<any>()
                    if (!Array.isArray(data)) {
                        msg = "unexpected marketplace format"
                    } else {
                        entries = data as Entry[]
                        lastAt = now()
                        try { $storage.set(CACHE_KEY, { at: lastAt, data: entries }) } catch (_e) {}
                    }
                }
            } catch (_e) {
                msg = "could not reach the marketplace"
            }
            inflight = false
            status.set(msg)
            try { tray.update() } catch (_e) {}
        }

        const TAGS = ["all", "working", "broken", "deprecated", "untagged"]
        const KINDS = ["all", "plugin", "onlinestream-provider", "manga-provider", "anime-torrent-provider", "custom-source"]
        const TAG_LABEL: { [k: string]: string } = {
            all: "All",
            working: "✓ Working",
            broken: "✗ Broken",
            deprecated: "⚠ Deprecated",
            untagged: "Untagged",
        }
        const KIND_LABEL: { [k: string]: string } = {
            all: "All",
            plugin: "Plugins",
            "onlinestream-provider": "Stream",
            "manga-provider": "Manga",
            "anime-torrent-provider": "Torrent",
            "custom-source": "Custom",
        }

        for (let i = 0; i < TAGS.length; i++) {
            const t = TAGS[i]
            ctx.registerEventHandler("st-tag-" + t, () => { tag.set(t); tray.update() })
        }
        for (let i = 0; i < KINDS.length; i++) {
            const k = KINDS[i]
            ctx.registerEventHandler("st-kind-" + k, () => { kind.set(k); tray.update() })
        }
        ctx.registerEventHandler("st-refresh", () => { void load(true) })

        function hasTag(e: Entry, t: string): boolean {
            if (t === "all") return true
            if (t === "working") return !!e.workingTag
            if (t === "broken") return !!e.brokenTag
            if (t === "deprecated") return !!e.deprecatedTag
            if (t === "untagged") return !e.workingTag && !e.brokenTag && !e.deprecatedTag
            return true
        }
        function matches(e: Entry): boolean {
            if (!hasTag(e, tag.get())) return false
            const k = kind.get()
            if (k !== "all" && (e.type || "") !== k) return false
            return true
        }
        function tagCount(t: string): number {
            const k = kind.get()
            let n = 0
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i]
                if (k !== "all" && (e.type || "") !== k) continue
                if (hasTag(e, t)) n++
            }
            return n
        }

        function dim(s: string): any {
            return tray.text(s, { style: { color: "rgba(255,255,255,0.5)", fontSize: "12px", overflowWrap: "anywhere", wordBreak: "break-word" } })
        }
        function divider(): any {
            return tray.div({ items: [], style: { borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: "5px", marginBottom: "5px" } })
        }
        function pill(label: string, active: boolean, onClick: string): any {
            return tray.button({ label, onClick, intent: active ? "primary" : "gray-subtle", size: "xs" })
        }
        function tagBadges(e: Entry): any[] {
            const out: any[] = []
            if (e.brokenTag) out.push(tray.badge({ text: "Broken", intent: "alert", size: "sm" }))
            if (e.deprecatedTag) out.push(tray.badge({ text: "Deprecated", intent: "warning", size: "sm" }))
            if (e.workingTag) out.push(tray.badge({ text: "Working", intent: "success", size: "sm" }))
            if (out.length === 0) out.push(tray.badge({ text: "untagged", intent: "gray", size: "sm" }))
            return out
        }
        function row(e: Entry): any {
            const meta: string[] = []
            if (e.type) meta.push(KIND_LABEL[e.type] || e.type)
            if (e.author) meta.push(e.author)
            if (typeof e.stars === "number" && e.stars > 0) meta.push("★ " + e.stars)
            if (e.flags && e.flags.indexOf("0/") !== 0) meta.push("⚑ " + e.flags)
            return tray.div({
                items: [
                    tray.flex({
                        items: tagBadges(e).concat([
                            tray.text(e.name || e.id || "?", { style: { fontSize: "13px", fontWeight: "600", color: "rgba(255,255,255,0.92)", overflowWrap: "anywhere", wordBreak: "break-word" } }),
                        ]),
                        gap: 2,
                        style: { alignItems: "center" },
                    }),
                    tray.text(meta.join("  ·  "), { style: { fontSize: "11px", color: "rgba(255,255,255,0.5)", marginTop: "2px" } }),
                ],
                style: { padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" },
            })
        }

        const MAX = 60
        function renderTray(): any {
            const rows: any[] = []
            rows.push(tray.flex({
                items: [
                    tray.text("SeaTags", { style: { fontWeight: "600", fontSize: "15px", color: "rgba(255,255,255,0.95)" } }),
                    tray.button({ label: status.get() === "loading" ? "Loading…" : "Refresh", onClick: "st-refresh", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))

            if (entries.length === 0) {
                if (status.get() === "loading") rows.push(dim("Loading the marketplace tag list…"))
                else if (status.get()) rows.push(dim(status.get()))
                else rows.push(dim("Tap Refresh to load the marketplace tag list."))
                return tray.stack({ items: rows, gap: 3 })
            }

            rows.push(tray.flex({
                items: TAGS.map((t) => pill(TAG_LABEL[t] + " " + tagCount(t), tag.get() === t, "st-tag-" + t)),
                gap: 2,
                style: { flexWrap: "wrap" },
            }))
            rows.push(tray.flex({
                items: KINDS.map((k) => pill(KIND_LABEL[k], kind.get() === k, "st-kind-" + k)),
                gap: 2,
                style: { flexWrap: "wrap" },
            }))

            const filtered: Entry[] = []
            for (let i = 0; i < entries.length; i++) if (matches(entries[i])) filtered.push(entries[i])

            const head: any[] = [dim("Showing " + filtered.length + " of " + entries.length)]
            if (status.get() && status.get() !== "loading") head.push(dim("· " + status.get()))
            rows.push(tray.flex({ items: head, gap: 2 }))
            rows.push(divider())

            const listItems: any[] = []
            for (let i = 0; i < filtered.length && i < MAX; i++) listItems.push(row(filtered[i]))
            if (listItems.length === 0) rows.push(dim("Nothing matches this filter."))
            else rows.push(tray.div({ items: listItems, style: { maxHeight: "360px", overflowY: "auto" } }))
            if (filtered.length > MAX) rows.push(dim("… and " + (filtered.length - MAX) + " more — narrow the filter."))

            return tray.stack({ items: rows, gap: 3 })
        }

        tray.render(renderTray)
        tray.onOpen(() => { void load(false) })
        ctx.setTimeout(() => { void load(false) }, 0)
    })
}
