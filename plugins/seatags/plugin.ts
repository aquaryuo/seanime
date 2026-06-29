function init() {
    $ui.register((ctx) => {
        const SRC = "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/main/Marketplace/Main.json"
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
        const filterState = ctx.state<string>("all")
        const authorState = ctx.state<string>("")
        let lastAt = boot.at || 0

        const STATUS_OPTS: string[][] = [["all", "All statuses"], ["working", "Working"], ["broken", "Broken"], ["deprecated", "Deprecated"], ["untagged", "Untagged"]]

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
        let started = false
        let controlsStarted = false
        let domReady = false
        let filterStyle: any = null

        const CTL_INPUT_CSS = "height:40px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#0b0b0b;color:#d1d1d1;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box;padding:0 12px;min-width:180px"
        const CTL_SELECT_CSS = "height:40px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#0b0b0b;color:#d1d1d1;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box;cursor:pointer;padding:0 10px;min-width:160px"
        const CTL_WRAP_CSS = "display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;align-items:center;flex:1 1 auto;min-width:0"

        // ---------- helpers ----------
        function tagsOf(e: Entry): string[] {
            const t: string[] = []
            if (e.brokenTag) t.push("broken")
            if (e.deprecatedTag) t.push("deprecated")
            if (e.workingTag) t.push("working")
            return t
        }
        const PILL_LABEL: { [k: string]: string } = { working: "Working", broken: "Broken", deprecated: "Deprecated" }
        function cap(s: string): string { s = s || ""; return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : "" }
        function esc(s: string): string {
            return (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        }
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

        // ---------- card decoration ----------
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
            const author = info && info.author ? String(info.author).toLowerCase() : ""
            try { card.setAttribute("data-seatags", tags.length ? tags.join(" ") : "untagged") } catch (e) { dErr = "attr" }
            try { card.setAttribute("data-seatags-author", author) } catch (_e) {}
            if (info) await rebuildBadges(card, info, tags)
        }
        function decorateCards(cards: any[]): void {
            if (!cards) return
            for (let i = 0; i < cards.length; i++) decorateOne(cards[i]).catch(() => {})
        }

        // ---------- injected stylesheets ----------
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
            const a = authorState.get().toLowerCase().replace(/["\\]/g, "")
            let css = ""
            if (f && f !== "all") css += '[class*="extension-card"]:not([data-seatags~="' + f + '"]){display:none !important}'
            if (a) css += '[class*="extension-card"]:not([data-seatags-author*="' + a + '"]){display:none !important}'
            try { filterStyle.setText(css) } catch (e) { dErr = "filter" }
        }

        // ---------- toolbar controls (Author search + Status dropdown) ----------
        let authorToken = 0
        function onAuthorInput(el: any): void {
            const t = ++authorToken
            try {
                el.getProperty("value").then((v: any) => {
                    if (t !== authorToken) return
                    authorState.set(v == null ? "" : String(v))
                    applyFilter().catch(() => {})
                }).catch(() => {})
            } catch (_e) {}
        }
        function onStatusChange(el: any): void {
            try {
                el.getProperty("value").then((v: any) => {
                    filterState.set(v == null ? "all" : String(v))
                    applyFilter().catch(() => {})
                }).catch(() => {})
            } catch (_e) {}
        }
        function statusOptionsHtml(): string {
            let h = ""
            for (let i = 0; i < STATUS_OPTS.length; i++) h += '<option value="' + esc(STATUS_OPTS[i][0]) + '">' + esc(STATUS_OPTS[i][1]) + "</option>"
            return h
        }
        async function injectControls(inputs: any[]): Promise<void> {
            if (!inputs || !inputs.length) return
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i]
                try { input.setAttribute("data-seatags-tb", "1") } catch (_e) {}

                let ic: any = null
                try { ic = await input.getParent() } catch (_e) {}
                let rowEl: any = null
                if (ic) { try { rowEl = await ic.getParent() } catch (_e) {} }
                let langRoot: any[] = []
                if (rowEl) { try { langRoot = await rowEl.query(".UI-Select__root") } catch (_e) {} }
                const hasLang = !!(langRoot && langRoot.length)

                let inpClass = ""
                if (ic) { try { const c = await ic.getAttribute("class"); inpClass = c ? String(c) : "" } catch (_e) {} }
                let selClass = ""
                if (hasLang) { try { const c = await langRoot[0].getAttribute("class"); selClass = c ? String(c) : "" } catch (_e) {} }
                if (!selClass) selClass = inpClass

                let sel: any = null
                try { sel = await ctx.dom.createElement("select") } catch (_e) {}
                if (sel) {
                    if (selClass) { try { sel.setAttribute("class", selClass) } catch (_e) {} }
                    else { try { sel.setCssText(CTL_SELECT_CSS) } catch (_e) {} }
                    try { sel.setInnerHTML(statusOptionsHtml()) } catch (_e) {}
                    try { sel.setProperty("value", filterState.get()) } catch (_e) {}
                    try { sel.addEventListener("change", () => { onStatusChange(sel) }) } catch (_e) {}
                }

                let author: any = null
                try { author = await ctx.dom.createElement("input") } catch (_e) {}
                if (author) {
                    try { author.setAttribute("type", "text") } catch (_e) {}
                    try { author.setAttribute("placeholder", "Search by author...") } catch (_e) {}
                    if (inpClass) { try { author.setAttribute("class", inpClass) } catch (_e) {} }
                    else { try { author.setCssText(CTL_INPUT_CSS) } catch (_e) {} }
                    try { author.setProperty("value", authorState.get()) } catch (_e) {}
                    try { author.addEventListener("input", () => { onAuthorInput(author) }) } catch (_e) {}
                }

                if (hasLang) {
                    // Marketplace row: [Status][All Languages][Author][Search] — pure insertion, no node moves
                    if (sel) { try { langRoot[0].before(sel) } catch (e) { dErr = "place" } }
                    if (author && ic) { try { ic.before(author) } catch (_e) {} }
                } else if (ic) {
                    // Installed (no language dropdown): wrap into a flex row → [Status][Author][Search]
                    let wrap: any = null
                    try { wrap = await ctx.dom.createElement("div") } catch (_e) {}
                    if (wrap) {
                        try { wrap.setCssText(CTL_WRAP_CSS) } catch (_e) {}
                        try { ic.before(wrap) } catch (e) { dErr = "place" }
                        try { ic.setStyle("flex", "1 1 220px") } catch (_e) {}
                        if (sel) { try { wrap.append(sel) } catch (_e) {} }
                        if (author) { try { wrap.append(author) } catch (_e) {} }
                        try { wrap.append(ic) } catch (e) { dErr = "move" }
                    }
                }
            }
        }

        // ---------- startup ----------
        function startControls(): void {
            if (!domReady || controlsStarted) return
            controlsStarted = true
            try {
                ctx.dom.observe('input[placeholder*="extensions"]:not([data-seatags-tb])', injectControls)
            } catch (e) { dErr = "obs-ctl"; controlsStarted = false }
        }
        function startCards(): void {
            if (!domReady || started) return
            if (entriesState.get().length === 0) return
            started = true
            try {
                ctx.dom.observe('[class*="extension-card"]:not([data-seatags])', decorateCards, { withInnerHTML: true })
            } catch (e) { dErr = "obs-cards"; started = false }
            applyFilter().catch(() => {})
        }
        function onDomReady(): void {
            domReady = true
            startControls()
            load(false).catch(() => {})
        }
        try { ctx.dom.onReady(() => { onDomReady() }) } catch (_e) {}
        try { ctx.dom.onMainTabReady(() => { onDomReady() }) } catch (_e) {}
        try { ctx.screen.onNavigate(() => { startControls(); startCards() }) } catch (_e) {}

        // ---------- load the marketplace tag list ----------
        let inflight = false
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entriesState.get().length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            try {
                const res = await fetch(SRC, { timeout: 15 })
                if (res.ok) {
                    const data = res.json<any>()
                    if (Array.isArray(data)) {
                        entriesState.set(data as Entry[])
                        rebuildMaps()
                        lastAt = now()
                        try { $storage.set(CACHE_KEY, { at: lastAt, data: data }) } catch (_e) {}
                    }
                }
            } catch (_e) {
                dErr = "fetch"
            }
            inflight = false
            startCards()
        }

        ctx.setTimeout(() => { if (!domReady) onDomReady() }, 3000)
    })
}
