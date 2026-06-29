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

        const FILTERS: string[][] = [["all", "All"], ["working", "Working"], ["broken", "Broken"], ["deprecated", "Deprecated"], ["untagged", "Untagged"]]

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

        let dErr = ""
        function refresh(): void { try { tray.update() } catch (_e) {} }

        // ---------- decoration of the real Extensions cards ----------
        let started = false
        let domReady = false
        let filterStyle: any = null

        function tagsOf(e: Entry): string[] {
            const t: string[] = []
            if (e.brokenTag) t.push("broken")
            if (e.deprecatedTag) t.push("deprecated")
            if (e.workingTag) t.push("working")
            return t
        }
        const PILL_LABEL: { [k: string]: string } = { working: "Working", broken: "Broken", deprecated: "Deprecated" }
        function cap(s: string): string { s = s || ""; return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : "" }
        function chipCss(kind: string): string {
            const base = "display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;font-size:11px;font-weight:600;line-height:1;white-space:nowrap;border:1px solid transparent;box-sizing:border-box"
            if (kind === "version") return base + ";background:rgba(225,225,225,0.10);color:#cacaca;border-color:rgba(90,90,90,0.40)"
            if (kind === "author") return base + ";background:transparent;color:#cacaca;border-color:rgba(255,255,255,0.10)"
            if (kind === "lang") return base + ";background:rgba(239,246,255,0.10);color:#93c5fd"
            if (kind === "language") return base + ";background:transparent;color:rgba(255,255,255,0.40);padding:0"
            if (kind === "broken") return base + ";font-weight:700;background:rgba(255,80,80,0.18);color:#ff8585;border-color:rgba(255,80,80,0.50)"
            if (kind === "deprecated") return base + ";font-weight:700;background:rgba(255,180,60,0.18);color:#ffce80;border-color:rgba(255,180,60,0.50)"
            if (kind === "working") return base + ";font-weight:700;background:rgba(62,207,142,0.18);color:#5fe0a6;border-color:rgba(62,207,142,0.50)"
            if (kind === "stars") return base + ";background:transparent;color:#fcd34d;padding:0"
            return base
        }
        function esc(s: string): string {
            return (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        }
        function chipHtml(text: string, kind: string): string {
            return '<span style="' + chipCss(kind) + '">' + esc(text) + "</span>"
        }
        function blockHtml(info: Entry, tags: string[]): string {
            const rcss = "display:flex;flex-wrap:wrap;gap:6px;align-items:center"
            let r1 = ""
            if (info.version) r1 += chipHtml(String(info.version), "version")
            for (let i = 0; i < tags.length; i++) r1 += chipHtml(PILL_LABEL[tags[i]] || tags[i], tags[i])
            const lang = (info.lang || "").toString()
            if (lang) r1 += chipHtml(lang.toUpperCase(), lang.toLowerCase() === "multi" ? "language" : "lang")
            let r2 = ""
            if (info.author) r2 += chipHtml(String(info.author), "author")
            if (info.language) r2 += chipHtml(cap(String(info.language)), "language")
            if (typeof info.stars === "number" && info.stars > 0) r2 += chipHtml("★ " + info.stars, "stars")
            return '<div style="' + rcss + '">' + r1 + '</div><div style="' + rcss + '">' + r2 + "</div>"
        }
        function extractId(html: string): string {
            const m = html.match(/opacity-30[^>]*>([^<]+)</)
            return m ? m[1].trim() : ""
        }
        function extractName(html: string): string {
            const m = html.match(/font-semibold[^>]*>([^<]+)</)
            return m ? m[1].trim() : ""
        }

        async function rebuildBadges(card: any, info: Entry, tags: string[]): Promise<void> {
            let row: any = null
            try {
                const badges = await card.query(".UI-Badge__root")
                if (badges && badges.length) row = await badges[0].getParent()
            } catch (e) { dErr = "findrow" }
            let block: any = null
            try { block = await ctx.dom.createElement("div") } catch (e) { dErr = "create" }
            if (!block) return
            try { block.setCssText("display:flex;flex-direction:column;gap:6px;margin-top:8px") } catch (_e) {}
            try { block.setInnerHTML(blockHtml(info, tags)) } catch (e) { dErr = "html" }
            if (row) {
                try { row.setStyle("display", "none") } catch (_e) {}
                try { row.after(block) } catch (e) { dErr = "insert" }
            } else {
                try { card.append(block) } catch (e) { dErr = "append" }
            }
        }

        async function decorateOne(card: any): Promise<void> {
            const html = (card && card.innerHTML) ? String(card.innerHTML) : ""
            const id = extractId(html)
            let info: Entry | null = (id && byId[id]) ? byId[id] : null
            if (!info) {
                const nm = extractName(html)
                if (nm && byName[nm.toLowerCase()]) info = byName[nm.toLowerCase()]
            }
            const tags = info ? tagsOf(info) : []
            try { card.setAttribute("data-seatags", tags.length ? tags.join(" ") : "untagged") } catch (e) { dErr = "attr" }
            if (info) await rebuildBadges(card, info, tags)
        }
        function decorateCards(cards: any[]): void {
            if (!cards) return
            for (let i = 0; i < cards.length; i++) decorateOne(cards[i]).catch(() => {})
        }

        async function ensureFilterStyle(): Promise<void> {
            if (filterStyle) return
            try {
                const body = await ctx.dom.queryOne("body")
                if (body) {
                    const s = await ctx.dom.createElement("style")
                    s.setText("")
                    body.append(s)
                    filterStyle = s
                }
            } catch (e) { dErr = "fstyle" }
        }
        async function applyFilter(): Promise<void> {
            await ensureFilterStyle()
            if (!filterStyle) return
            const f = filterState.get()
            let css = ""
            if (f !== "all") css = '[class*="extension-card"]:not([data-seatags~="' + f + '"]){display:none !important}'
            try { filterStyle.setText(css) } catch (e) { dErr = "filter" }
        }

        function startDecorator(): void {
            if (!domReady) return
            ensureBar().catch(() => {})
            if (started) return
            if (entriesState.get().length === 0) return
            started = true
            try {
                ctx.dom.observe('[class*="extension-card"]:not([data-seatags])', decorateCards, { withInnerHTML: true })
            } catch (e) {
                dErr = "observe"
                started = false
            }
            applyFilter().catch(() => {})
        }
        function onDomReady(): void {
            domReady = true
            startDecorator()
            load(false).catch(() => {})
        }

        try { ctx.dom.onReady(() => { onDomReady() }) } catch (_e) {}
        try { ctx.dom.onMainTabReady(() => { onDomReady() }) } catch (_e) {}

        // ---------- on-page floating filter bar (Extensions screen only) ----------
        let bar: any = null
        let barBuilt = false
        const barBtns: { [k: string]: any } = {}

        function barBtnCss(active: boolean): string {
            if (active) return "appearance:none;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;background:#6152df;color:#ffffff;font-family:inherit"
            return "appearance:none;cursor:pointer;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:500;background:rgba(255,255,255,0.06);color:#cacaca;font-family:inherit"
        }
        function styleBarButtons(): void {
            const f = filterState.get()
            for (let i = 0; i < FILTERS.length; i++) {
                const k = FILTERS[i][0]
                const btn = barBtns[k]
                if (btn) { try { btn.setCssText(barBtnCss(f === k)) } catch (_e) {} }
            }
        }
        function selectFilter(k: string): void {
            filterState.set(k)
            applyFilter().catch(() => {})
            styleBarButtons()
            refresh()
        }
        function isExtPath(p: string): boolean { return !!p && p.indexOf("/extensions") === 0 }
        function currentPath(): string {
            try { return ctx.screen.state().get().pathname || "" } catch (_e) { return "" }
        }
        function showBar(show: boolean): void {
            if (!bar) return
            try { bar.setStyle("display", show ? "flex" : "none") } catch (_e) {}
        }
        const BAR_LABEL_CSS = "font-size:11px;font-weight:700;letter-spacing:0.02em;color:rgba(255,255,255,0.5);margin-right:2px"
        async function ensureBar(): Promise<void> {
            if (barBuilt || bar) return
            barBuilt = true
            try {
                const body = await ctx.dom.queryOne("body")
                if (!body) { barBuilt = false; return }
                const b = await ctx.dom.createElement("div")
                b.setCssText("position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;display:none;flex-direction:row;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;background:rgba(16,16,20,0.94);border:1px solid rgba(255,255,255,0.12);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.5)")
                const lab = await ctx.dom.createElement("span")
                lab.setText("SeaTags")
                try { lab.setCssText(BAR_LABEL_CSS) } catch (_e) {}
                b.append(lab)
                for (let i = 0; i < FILTERS.length; i++) {
                    const k = FILTERS[i][0]
                    const btn = await ctx.dom.createElement("button")
                    btn.setText(FILTERS[i][1])
                    try { btn.setCssText(barBtnCss(filterState.get() === k)) } catch (_e) {}
                    try { btn.addEventListener("click", () => { selectFilter(k) }) } catch (_e) {}
                    b.append(btn)
                    barBtns[k] = btn
                }
                body.append(b)
                bar = b
                showBar(isExtPath(currentPath()))
            } catch (e) { dErr = "bar"; barBuilt = false }
        }

        try { ctx.screen.onNavigate((e: any) => { const p = (e && e.pathname) ? String(e.pathname) : ""; showBar(isExtPath(p)); if (isExtPath(p)) startDecorator() }) } catch (_e) {}

        // ---------- load the marketplace tag list ----------
        let inflight = false
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entriesState.get().length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            statusState.set("loading")
            refresh()
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
            refresh()
            startDecorator()
        }

        // ---------- tray (stats + filter controls) ----------
        const tray = ctx.newTray({ iconUrl: ICON, withContent: true, width: "300px" })
        for (let i = 0; i < FILTERS.length; i++) {
            const k = FILTERS[i][0]
            ctx.registerEventHandler("st-f-" + k, () => { selectFilter(k) })
        }
        ctx.registerEventHandler("st-refresh", () => { load(true).catch(() => {}) })

        tray.render(() => {
          try {
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
            } else {
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
                items.push(tray.text("Filter (also shown on the Extensions page)", { style: { color: "rgba(255,255,255,0.55)", fontSize: "11px", marginTop: "4px" } }))
                items.push(tray.flex({
                    items: FILTERS.map((f) => tray.button({ label: f[1], onClick: "st-f-" + f[0], intent: filterState.get() === f[0] ? "primary" : "gray-subtle", size: "xs" })),
                    gap: 2,
                    style: { flexWrap: "wrap" },
                }))
            }
            if (dErr) items.push(tray.text("⚠ " + dErr, { style: { color: "rgba(255,180,80,0.7)", fontSize: "10px", marginTop: "4px" } }))
            return tray.stack({ items: items, gap: 3 })
          } catch (_e) {
            return tray.stack({ items: [tray.text("SeaTags", { style: { fontWeight: "600" } })], gap: 3 })
          }
        })
        tray.onOpen(() => { load(false).catch(() => {}); startDecorator() })

        ctx.setTimeout(() => { if (!domReady) onDomReady() }, 3000)
    })
}
