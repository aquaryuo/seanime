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
            description?: string
            type?: string
            language?: string
            lang?: string
            icon?: string
            manifestURI?: string
            payloadURI?: string
            website?: string
            permalink?: string
            flags?: string
            stars?: number
            official?: boolean
            workingTag?: boolean
            brokenTag?: boolean
            deprecatedTag?: boolean
        }

        function now(): number {
            try { return Date.now() } catch (_e) { return 0 }
        }
        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return v === undefined || v === null ? d : v } catch (_e) { return d }
        }

        const boot = sget<{ at: number; data: Entry[] }>(CACHE_KEY, { at: 0, data: [] })
        const entriesState = ctx.state<Entry[]>(boot.data && boot.data.length > 0 ? boot.data : [])
        const statusState = ctx.state<string>("")
        const filterState = ctx.state<string>("all")
        let lastAt = boot.at || 0

        let byId: { [k: string]: Entry } = {}
        let byName: { [k: string]: Entry } = {}
        function rebuildMaps(): void {
            byId = {}
            byName = {}
            const es = entriesState.get()
            for (let i = 0; i < es.length; i++) {
                const e = es[i]
                if (e.id) byId[e.id] = e
                if (e.name) byName[String(e.name).toLowerCase()] = e
            }
        }
        rebuildMaps()

        // ---------- DOM decoration of the real Extensions cards ----------
        let domReady = false
        let started = false
        let filterStyle: any = null

        function statusOf(e: Entry): string {
            if (e.brokenTag) return "broken"
            if (e.deprecatedTag) return "deprecated"
            if (e.workingTag) return "working"
            return "untagged"
        }
        const PILL_LABEL: { [k: string]: string } = { working: "Working", broken: "Broken", deprecated: "Deprecated" }
        function pillCss(status: string): string {
            let bg = "rgba(150,150,165,0.15)", fg = "#b8b8c2", bd = "rgba(150,150,165,0.35)"
            if (status === "broken") { bg = "rgba(255,80,80,0.15)"; fg = "#ff8585"; bd = "rgba(255,80,80,0.4)" }
            else if (status === "deprecated") { bg = "rgba(255,180,60,0.15)"; fg = "#ffce80"; bd = "rgba(255,180,60,0.4)" }
            else if (status === "working") { bg = "rgba(62,207,142,0.15)"; fg = "#5fe0a6"; bd = "rgba(62,207,142,0.4)" }
            return "display:inline-block;margin-top:6px;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;line-height:1.5;background:" + bg + ";color:" + fg + ";border:1px solid " + bd + ";position:relative;z-index:2"
        }
        function extractId(html: string): string {
            const m = html.match(/opacity-30[^>]*>([^<]+)</)
            return m ? m[1].trim() : ""
        }
        function extractName(html: string): string {
            const m = html.match(/font-semibold[^>]*>([^<]+)</)
            return m ? m[1].trim() : ""
        }

        async function decorateOne(card: any): Promise<void> {
            const html = (card && card.innerHTML) ? String(card.innerHTML) : ""
            const id = extractId(html)
            let info: Entry | null = (id && byId[id]) ? byId[id] : null
            if (!info) {
                const nm = extractName(html)
                if (nm && byName[nm.toLowerCase()]) info = byName[nm.toLowerCase()]
            }
            const status = info ? statusOf(info) : "untagged"
            try { card.setAttribute("data-seatags", status) } catch (_e) {}
            if (status === "untagged") return
            try {
                const pill = await ctx.dom.createElement("div")
                pill.setText(PILL_LABEL[status] || status)
                pill.setCssText(pillCss(status))
                card.appendChild(pill)
            } catch (_e) {}
        }
        function decorateCards(cards: any[]): void {
            for (let i = 0; i < cards.length; i++) void decorateOne(cards[i])
        }

        function applyFilter(): void {
            if (!filterStyle) return
            const f = filterState.get()
            let css = ""
            if (f !== "all") css = '[class*="extension-card"]:not([data-seatags="' + f + '"]){display:none !important}'
            try { filterStyle.setText(css) } catch (_e) {}
        }

        async function startDecorator(): Promise<void> {
            if (started) return
            if (!domReady) return
            if (entriesState.get().length === 0) return
            started = true
            try {
                const body = await ctx.dom.queryOne("body")
                if (body) {
                    const s = await ctx.dom.createElement("style")
                    s.setText("")
                    body.appendChild(s)
                    filterStyle = s
                }
            } catch (_e) {}
            applyFilter()
            try { ctx.dom.observe('[class*="extension-card"]:not([data-seatags])', decorateCards, { withInnerHTML: true }) } catch (_e) {}
        }

        ctx.dom.onReady(() => { domReady = true; void startDecorator() })

        // ---------- load the marketplace tag list ----------
        let inflight = false
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entriesState.get().length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            statusState.set("loading")
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
                        entriesState.set(data as Entry[])
                        rebuildMaps()
                        lastAt = now()
                        try { $storage.set(CACHE_KEY, { at: lastAt, data: data }) } catch (_e) {}
                    }
                }
            } catch (_e) {
                msg = "could not reach the marketplace"
            }
            inflight = false
            statusState.set(msg)
            try { tray.update() } catch (_e) {}
            void startDecorator()
        }

        // ---------- tray (stats + filter controls) ----------
        const tray = ctx.newTray({ iconUrl: ICON, withContent: true, width: "300px" })
        const FILTERS: string[][] = [["all", "All"], ["working", "Working"], ["broken", "Broken"], ["deprecated", "Deprecated"], ["untagged", "Untagged"]]
        for (let i = 0; i < FILTERS.length; i++) {
            const k = FILTERS[i][0]
            ctx.registerEventHandler("st-f-" + k, () => { filterState.set(k); applyFilter(); tray.update() })
        }
        ctx.registerEventHandler("st-refresh", () => { void load(true) })

        tray.render(() => {
            const es = entriesState.get()
            const items: any[] = []
            items.push(tray.flex({
                items: [
                    tray.text("SeaTags", { style: { fontWeight: "600", fontSize: "15px", color: "rgba(255,255,255,0.95)" } }),
                    tray.button({ label: statusState.get() === "loading" ? "Loading…" : "Refresh", onClick: "st-refresh", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))
            if (es.length === 0) {
                items.push(tray.text(statusState.get() === "loading" ? "Loading the marketplace…" : (statusState.get() || "Tap Refresh to load the tag list."), { style: { color: "rgba(255,255,255,0.6)", fontSize: "12px" } }))
                return tray.stack({ items: items, gap: 3 })
            }
            let w = 0, b = 0, d = 0
            for (let i = 0; i < es.length; i++) { if (es[i].workingTag) w++; if (es[i].brokenTag) b++; if (es[i].deprecatedTag) d++ }
            items.push(tray.flex({
                items: [
                    tray.badge({ text: "✓ " + w, intent: "success", size: "sm" }),
                    tray.badge({ text: "✗ " + b, intent: "alert", size: "sm" }),
                    tray.badge({ text: "⚠ " + d, intent: "warning", size: "sm" }),
                    tray.badge({ text: es.length + " total", intent: "gray", size: "sm" }),
                ],
                gap: 2,
                style: { flexWrap: "wrap" },
            }))
            items.push(tray.text("Filter the Extensions page", { style: { color: "rgba(255,255,255,0.55)", fontSize: "11px", marginTop: "4px" } }))
            items.push(tray.flex({
                items: FILTERS.map((f) => tray.button({ label: f[1], onClick: "st-f-" + f[0], intent: filterState.get() === f[0] ? "primary" : "gray-subtle", size: "xs" })),
                gap: 2,
                style: { flexWrap: "wrap" },
            }))
            items.push(tray.text("Open Extensions ▸ Installed or Marketplace to see tags on the cards.", { style: { color: "rgba(255,255,255,0.4)", fontSize: "10px", marginTop: "2px" } }))
            return tray.stack({ items: items, gap: 3 })
        })
        tray.onOpen(() => { void load(false) })

        ctx.setTimeout(() => { void load(false) }, 0)
    })
}
