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

        const CTL_INPUT_CSS = "height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:#0b0b0b;color:#d1d1d1;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box;padding:0 12px;min-width:180px"
        const CTL_WRAP_CSS = "display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;align-items:center;flex:1 1 auto;min-width:0"
        const CTL_TRIGGER_CSS = "display:inline-flex;align-items:center;justify-content:space-between;gap:8px;height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background-color:#0b0b0b;color:#d1d1d1;font-size:14px;padding:0 12px;min-width:160px;cursor:pointer;box-sizing:border-box;font-family:inherit"
        const SEL_CONTENT_CLASS = "UI-Select__content w-full overflow-hidden rounded-[--radius] shadow-md bg-[--paper] border leading-none z-[100]"
        const SEL_VIEWPORT_CLASS = "UI-Select__viewport p-1"
        const SEL_ITEM_CLASS = "UI-Select__item seatags-status-item text-base leading-none rounded-[--radius] flex items-center h-8 pr-2 pl-8 relative select-none"
        const CHECK_ICON_CLASS = "UI-Select__checkIcon absolute left-2 w-4 inline-flex items-center justify-center"
        const CHECK_SVG = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'></polyline></svg>"
        const CHEVRON_SVG = "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'></path></svg>"
        const PERSON_SVG = "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'></path><circle cx='12' cy='7' r='4'></circle></svg>"
        const ICON_CLASS = "UI-Input__addons--icon pointer-events-none absolute inset-y-0 left-0 w-12 grid place-content-center text-gray-500 dark:text-gray-300"

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
        function statusLabel(v: string): string {
            for (let i = 0; i < STATUS_OPTS.length; i++) if (STATUS_OPTS[i][0] === v) return STATUS_OPTS[i][1]
            return STATUS_OPTS[0][1]
        }
        function selIndex(v: string): number {
            for (let i = 0; i < STATUS_OPTS.length; i++) if (STATUS_OPTS[i][0] === v) return i
            return 0
        }
        const ITEM_H = 32
        let hoverStyle: any = null
        async function ensureHoverStyle(): Promise<void> {
            if (hoverStyle) return
            try {
                const b = await ctx.dom.queryOne("body")
                if (!b) return
                const s = await ctx.dom.createElement("style")
                s.setText(".seatags-status-item:hover{background-color:rgba(255,255,255,0.08)}")
                b.append(s)
                hoverStyle = s
            } catch (_e) {}
        }

        type Menu = { open: boolean; cancel: any; content: any; body: any; checks: any[] }
        function updateChecks(st: Menu): void {
            if (!st.checks) return
            const v = filterState.get()
            for (let i = 0; i < st.checks.length; i++) {
                const c = st.checks[i]
                if (c && c.el) { try { c.el.setStyle("display", c.val === v ? "inline-flex" : "none") } catch (_e) {} }
            }
        }
        function closeMenu(st: Menu): void {
            try { st.content.setStyle("display", "none") } catch (_e) {}
            st.open = false
            if (st.cancel) { try { st.cancel() } catch (_e) {} ; st.cancel = null }
        }
        function openMenu(st: Menu): void {
            const idx = selIndex(filterState.get())
            try { st.content.setStyle("top", (-(1 + idx * ITEM_H)) + "px") } catch (_e) {}
            updateChecks(st)
            try { st.content.setStyle("display", "block") } catch (_e) {}
            st.open = true
            if (st.body) { try { st.cancel = st.body.addEventListener("click", () => { closeMenu(st) }) } catch (_e) {} }
        }
        function toggleMenu(st: Menu): void { if (st.open) closeMenu(st); else openMenu(st) }

        // Builds a div-based dropdown that reuses Seanime's own Select classes (looks identical)
        async function buildStatusDropdown(boxClass: string): Promise<any> {
            await ensureHoverStyle()
            let body: any = null
            try { body = await ctx.dom.queryOne("body") } catch (_e) {}

            let container: any = null
            try { container = await ctx.dom.createElement("div") } catch (_e) {}
            if (!container) return null
            try { container.setCssText("position:relative;flex:none;width:200px;box-sizing:border-box") } catch (_e) {}

            let trigger: any = null
            try { trigger = await ctx.dom.createElement("div") } catch (_e) {}
            if (!trigger) return null
            if (boxClass) { try { trigger.setAttribute("class", boxClass) } catch (_e) {} }
            else { try { trigger.setCssText(CTL_TRIGGER_CSS) } catch (_e) {} }
            try { trigger.addClass("inline-flex", "items-center", "justify-between") } catch (_e) {}
            try { trigger.setStyle("display", "flex") } catch (_e) {}
            try { trigger.setStyle("align-items", "center") } catch (_e) {}
            try { trigger.setStyle("justify-content", "space-between") } catch (_e) {}
            try { trigger.setStyle("padding-left", "0.75rem") } catch (_e) {}
            try { trigger.setStyle("padding-right", "0.75rem") } catch (_e) {}
            try { trigger.setStyle("width", "100%") } catch (_e) {}
            try { trigger.setStyle("box-sizing", "border-box") } catch (_e) {}
            try { trigger.setStyle("cursor", "pointer") } catch (_e) {}

            let label: any = null
            try { label = await ctx.dom.createElement("span") } catch (_e) {}
            if (label) {
                try { label.setText(statusLabel(filterState.get())) } catch (_e) {}
                try { label.setStyle("flex", "1") } catch (_e) {}
                try { label.setStyle("text-align", "left") } catch (_e) {}
                try { label.setStyle("overflow", "hidden") } catch (_e) {}
                try { label.setStyle("text-overflow", "ellipsis") } catch (_e) {}
                try { label.setStyle("white-space", "nowrap") } catch (_e) {}
                try { trigger.append(label) } catch (_e) {}
            }

            let chev: any = null
            try { chev = await ctx.dom.createElement("span") } catch (_e) {}
            if (chev) {
                try { chev.setAttribute("class", "UI-Combobox__chevronIcon ml-2 h-4 w-4 shrink-0 opacity-50") } catch (_e) {}
                try { chev.setInnerHTML(CHEVRON_SVG) } catch (_e) {}
                try { trigger.append(chev) } catch (_e) {}
            }

            let content: any = null
            try { content = await ctx.dom.createElement("div") } catch (_e) {}
            if (!content) return null
            try { content.setAttribute("class", SEL_CONTENT_CLASS) } catch (_e) {}
            try { content.setCssText("position:absolute;top:0;left:-24px;width:224px;box-sizing:border-box;display:none") } catch (_e) {}

            let vp: any = null
            try { vp = await ctx.dom.createElement("div") } catch (_e) {}
            if (vp) { try { vp.setAttribute("class", SEL_VIEWPORT_CLASS) } catch (_e) {} ; try { content.append(vp) } catch (_e) {} }

            const st: Menu = { open: false, cancel: null, content: content, body: body, checks: [] }

            for (let i = 0; i < STATUS_OPTS.length; i++) {
                const val = STATUS_OPTS[i][0]
                const lbl = STATUS_OPTS[i][1]
                let it: any = null
                try { it = await ctx.dom.createElement("div") } catch (_e) {}
                if (!it) continue
                try { it.setAttribute("class", SEL_ITEM_CLASS) } catch (_e) {}
                try { it.setStyle("cursor", "pointer") } catch (_e) {}
                let chk: any = null
                try { chk = await ctx.dom.createElement("span") } catch (_e) {}
                if (chk) {
                    try { chk.setAttribute("class", CHECK_ICON_CLASS) } catch (_e) {}
                    try { chk.setInnerHTML(CHECK_SVG) } catch (_e) {}
                    try { chk.setStyle("display", val === filterState.get() ? "inline-flex" : "none") } catch (_e) {}
                    try { it.append(chk) } catch (_e) {}
                    st.checks.push({ val: val, el: chk })
                }
                let txt: any = null
                try { txt = await ctx.dom.createElement("span") } catch (_e) {}
                if (txt) { try { txt.setText(lbl) } catch (_e) {} ; try { it.append(txt) } catch (_e) {} }
                try { it.addEventListener("click", () => { filterState.set(val); if (label) { try { label.setText(lbl) } catch (_e) {} } updateChecks(st); applyFilter().catch(() => {}); closeMenu(st) }) } catch (_e) {}
                if (vp) { try { vp.append(it) } catch (_e) {} }
            }

            try { container.append(trigger) } catch (_e) {}
            try { container.append(content) } catch (_e) {}
            try { trigger.addEventListener("click", () => { toggleMenu(st) }) } catch (_e) {}
            return container
        }

        const injectedIds: { [k: string]: boolean } = {}
        async function injectControls(inputs: any[]): Promise<void> {
            if (!inputs || !inputs.length) return
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i]
                const eid = input && input.id ? String(input.id) : ""
                if (eid && injectedIds[eid]) continue
                if (eid) injectedIds[eid] = true
                try { input.setAttribute("data-seatags-tb", "1") } catch (_e) {}

                let ic: any = null
                try { ic = await input.getParent() } catch (_e) {}
                let rowEl: any = null
                if (ic) { try { rowEl = await ic.getParent() } catch (_e) {} }
                let langRoot: any[] = []
                if (rowEl) { try { langRoot = await rowEl.query(".UI-Select__root") } catch (_e) {} }
                const hasLang = !!(langRoot && langRoot.length)

                let inputClass = ""
                try { const c = await input.getAttribute("class"); inputClass = c ? String(c) : "" } catch (_e) {}
                let boxClass = ""
                if (hasLang) { try { const c = await langRoot[0].getAttribute("class"); boxClass = c ? String(c) : "" } catch (_e) {} }
                if (!boxClass) boxClass = inputClass

                const statusEl = await buildStatusDropdown(boxClass)

                let author: any = null
                if (inputClass) {
                    // Replicate the search box: container > absolute person icon > input (keeps pl-10)
                    try { author = await ctx.dom.createElement("div") } catch (_e) {}
                    if (author) {
                        try { author.setCssText("position:relative;display:flex;align-items:center;flex:none;width:220px;max-width:220px") } catch (_e) {}
                        let aicon: any = null
                        try { aicon = await ctx.dom.createElement("span") } catch (_e) {}
                        if (aicon) {
                            try { aicon.setAttribute("class", ICON_CLASS) } catch (_e) {}
                            try { aicon.setStyle("z-index", "1") } catch (_e) {}
                            try { aicon.setInnerHTML(PERSON_SVG) } catch (_e) {}
                            try { author.append(aicon) } catch (_e) {}
                        }
                        let ainput: any = null
                        try { ainput = await ctx.dom.createElement("input") } catch (_e) {}
                        if (ainput) {
                            try { ainput.setAttribute("type", "text") } catch (_e) {}
                            try { ainput.setAttribute("placeholder", "Search by author...") } catch (_e) {}
                            try { ainput.setAttribute("class", inputClass) } catch (_e) {}
                            try { ainput.setProperty("value", authorState.get()) } catch (_e) {}
                            try { ainput.addEventListener("input", () => { onAuthorInput(ainput) }) } catch (_e) {}
                            try { author.append(ainput) } catch (_e) {}
                        }
                    }
                } else {
                    try { author = await ctx.dom.createElement("input") } catch (_e) {}
                    if (author) {
                        try { author.setAttribute("type", "text") } catch (_e) {}
                        try { author.setAttribute("placeholder", "Search by author...") } catch (_e) {}
                        try { author.setCssText(CTL_INPUT_CSS) } catch (_e) {}
                        try { author.setProperty("value", authorState.get()) } catch (_e) {}
                        try { author.addEventListener("input", () => { onAuthorInput(author) }) } catch (_e) {}
                    }
                }

                if (hasLang) {
                    // Marketplace row: [Status][All Languages][Author][Search] — pure insertion, no node moves
                    if (statusEl) { try { langRoot[0].before(statusEl) } catch (e) { dErr = "place" } }
                    if (author && ic) { try { ic.before(author) } catch (_e) {} }
                } else if (ic) {
                    // Installed (no language dropdown): wrap into a flex row → [Status][Author][Search]
                    let wrap: any = null
                    try { wrap = await ctx.dom.createElement("div") } catch (_e) {}
                    if (wrap) {
                        try { wrap.setCssText(CTL_WRAP_CSS) } catch (_e) {}
                        try { ic.before(wrap) } catch (e) { dErr = "place" }
                        try { ic.setStyle("flex", "1 1 220px") } catch (_e) {}
                        if (statusEl) { try { wrap.append(statusEl) } catch (_e) {} }
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
