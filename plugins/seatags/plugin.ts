declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

function init() {
    $ui.register((ctx) => {

        const SRC = "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/main/Marketplace/Main.json"
        const OWN_SRC = "https://raw.githubusercontent.com/aquaryuo/seanime/main/marketplace.json"
        const EXT_ID = "aq-seatags"
        const NS = EXT_ID
        const A_TAGS = "data-" + NS
        const A_AUTHOR = A_TAGS + "-author"
        const A_STYLE = A_TAGS + "-style"
        const A_TB = A_TAGS + "-tb"
        const C_BLOCK = NS + "-block"
        const CACHE_KEY = "seatags:cache"
        const CACHE_TTL = 3600000

        type Entry = {
            id?: string
            name?: string
            author?: string
            stars?: number
            workingTag?: boolean
            brokenTag?: boolean
            deprecatedTag?: boolean
        }

        let boot: any = null
        try { boot = $storage.get(CACHE_KEY) } catch (_e) {}
        let entries: Entry[] = (boot && boot.data) || []
        let filter = "all"
        let authorQ = ""
        let lastAt = (boot && boot.at) || 0

        const STATUS_HTML = '<option value="all">All statuses</option><option value="working">Working</option><option value="broken">Broken</option><option value="deprecated">Deprecated</option><option value="untagged">Untagged</option>'

        let byId: { [k: string]: Entry } = {}
        let byName: { [k: string]: Entry } = {}
        let byNameAuthor: { [k: string]: Entry } = {}
        function rebuildMaps(): void {
            byId = {}
            byName = {}
            byNameAuthor = {}
            const nameCount: { [k: string]: number } = {}
            const pairCount: { [k: string]: number } = {}
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i]
                if (!e || typeof e !== "object") continue
                if (e.id) byId[e.id] = e
                if (!e.name) continue
                const k = String(e.name).toLowerCase()
                nameCount[k] = (nameCount[k] || 0) + 1
                byName[k] = e
                if (!e.author) continue
                const p = k + " " + String(e.author).toLowerCase()
                pairCount[p] = (pairCount[p] || 0) + 1
                byNameAuthor[p] = e
            }
            for (const k in nameCount) if (nameCount[k] > 1) delete byName[k]
            for (const p in pairCount) if (pairCount[p] > 1) delete byNameAuthor[p]
        }
        rebuildMaps()

        const dErrSeen: { [k: string]: boolean } = {}
        const D_REASON: { [k: string]: string } = {
            fetch: "could not reach the marketplace list, so no cards were tagged",
            http: "the marketplace list answered with an error status, so no cards were tagged",
            shape: "the marketplace list came back in an unexpected shape, so no cards were tagged",
            parse: "the marketplace list was not readable JSON, so no cards were tagged",
            findrow: "could not find the badge row on an extension card",
            attr: "could not tag an extension card",
            html: "could not render the tag block on a card",
            insert: "could not insert the tag block into a card",
            append: "could not append the tag block to a card",
            place: "could not place the filter controls above the extension grid",
            filter: "could not apply the tag filter",
            fstyle: "could not install the filter stylesheet",
        }
        function dsetErr(code: string): void {
            if (dErrSeen[code]) return
            dErrSeen[code] = true
            try { console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: EXT_ID, scope: "decorate", msg: D_REASON[code] || code })) } catch (_e) {}
        }
        let domReady = false
        let controlsCancel: any = null
        let cardsCancel: any = null
        let filterStyle: any = null
        let epoch = 0

        const SELECT_OVERRIDE_CSS = "flex:none;width:200px;padding-left:0.75rem;padding-right:0.75rem;box-sizing:border-box;cursor:pointer;appearance:auto"
        const PERSON_SVG = "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'></path><circle cx='12' cy='7' r='4'></circle></svg>"
        const ICON_CLASS = "UI-Input__addons--icon pointer-events-none absolute inset-y-0 left-0 w-12 grid place-content-center text-gray-500 dark:text-gray-300"

        function tagsOf(e: Entry): string[] {
            const t: string[] = []
            if (e.brokenTag) t.push("broken")
            if (e.deprecatedTag) t.push("deprecated")
            if (e.workingTag) t.push("working")
            return t
        }
        const PILL_LABEL: { [k: string]: string } = { working: "Working", broken: "Broken", deprecated: "Deprecated" }
        function esc(s: string): string {
            return (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
        }
        function chipCss(kind: string): string {
            const base = "display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;font-size:11px;font-weight:600;line-height:1;white-space:nowrap;border:1px solid transparent;box-sizing:border-box"
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
            let r1 = ""
            for (let i = 0; i < tags.length; i++) r1 += chipHtml(PILL_LABEL[tags[i]] || tags[i], tags[i])
            if (typeof info.stars === "number" && info.stars > 0) r1 += chipHtml("★ " + info.stars, "stars")
            return r1
        }
        function grab(html: string, re: RegExp): string {
            const m = html.match(re)
            return m ? m[1].trim() : ""
        }
        function extractAuthor(html: string): string {
            const re = /<[a-zA-Z]+[^>]*\bclass="([^"]*\bUI-Badge__root\b[^"]*)"[^>]*>([^<]*)</g
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                const cls = " " + m[1].replace(/\s+/g, " ") + " "
                if (cls.indexOf(" rounded-md ") === -1) continue
                if (cls.indexOf(" tracking-wide ") !== -1) continue
                if (cls.indexOf(" border-transparent ") !== -1) continue
                const t = m[2].trim()
                if (t) return t
            }
            return ""
        }

        async function rebuildBadges(card: any, info: Entry, tags: string[]): Promise<void> {
            let badges: any[] = [], block: any = null, existing: any[] = []
            try {
                const r = await Promise.all([
                    card.query(".UI-Badge__root").catch(() => []),
                    ctx.dom.createElement("div").catch(() => null),
                    card.query("." + C_BLOCK).catch(() => []),
                ])
                badges = r[0] || []; block = r[1]; existing = r[2] || []
            } catch (e) { dsetErr("findrow") }
            for (let i = 0; i < existing.length; i++) { try { existing[i].remove() } catch (_e) {} }
            if (!block) return
            const html = blockHtml(info, tags)
            if (!html) return
            let row: any = null
            if (badges.length) { try { row = await badges[0].getParent() } catch (_e) {} }
            try { block.setAttribute("class", C_BLOCK) } catch (_e) {}
            try { block.setCssText("display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px") } catch (_e) {}
            try { block.setInnerHTML(html) } catch (e) { dsetErr("html") }
            if (row) {
                try { row.after(block) } catch (e) { dsetErr("insert") }
            } else {
                try { card.append(block) } catch (e) { dsetErr("append") }
            }
        }

        const decorating: { [k: string]: boolean } = {}
        let decorated = false
        async function decorateOne(card: any): Promise<void> {
            const cid = card && card.id ? String(card.id) : ""
            if (cid) { if (decorating[cid]) return; decorating[cid] = true }
            try {
                const html = (card && card.innerHTML) ? String(card.innerHTML) : ""
                const id = grab(html, /opacity-30[^>]*>([^<]+)</)
                const cardAuthor = extractAuthor(html)
                let info: Entry | null = (id && !/\s/.test(id) && byId[id]) ? byId[id] : null
                if (!info) {
                    const nm = grab(html, /font-semibold[^>]*>([^<]+)</).toLowerCase()
                    if (nm && cardAuthor && byNameAuthor[nm + " " + cardAuthor.toLowerCase()]) info = byNameAuthor[nm + " " + cardAuthor.toLowerCase()]
                    if (!info && nm && byName[nm]) info = byName[nm]
                }
                const tags = info ? tagsOf(info) : []
                const author = (cardAuthor || (info && info.author ? String(info.author) : "")).toLowerCase()
                try { card.setAttribute(A_TAGS, tags.length ? tags.join(" ") : "untagged") } catch (e) { dsetErr("attr") }
                try { card.setAttribute(A_AUTHOR, author) } catch (_e) {}
                decorated = true
                if (info) await rebuildBadges(card, info, tags)
            } finally {
                if (cid) delete decorating[cid]
            }
        }
        function decorateCards(cards: any[]): void {
            if (!cards) return
            const CHUNK = 15
            let i = 0
            function step(): void {
                const end = i + CHUNK < cards.length ? i + CHUNK : cards.length
                for (; i < end; i++) decorateOne(cards[i]).catch(() => {})
                if (i < cards.length) { try { ctx.setTimeout(step, 16) } catch (_e) {} }
            }
            step()
        }

        async function refreshDecorated(): Promise<void> {
            let cards: any[] = [], blocks: any[] = []
            try {
                const r = await Promise.all([
                    ctx.dom.query("[" + A_TAGS + "]").catch(() => []),
                    ctx.dom.query("." + C_BLOCK).catch(() => []),
                ])
                cards = r[0] || []; blocks = r[1] || []
            } catch (_e) {}
            for (let i = 0; i < blocks.length; i++) { try { blocks[i].remove() } catch (_e) {} }
            for (let i = 0; i < cards.length; i++) { try { cards[i].removeAttribute(A_TAGS) } catch (_e) {} }
        }

        async function ensureFilterStyle(): Promise<void> {
            if (filterStyle) return
            try {
                const body = await ctx.dom.queryOne("body")
                if (body) {
                    const s = await ctx.dom.createElement("style")
                    try { s.setAttribute(A_STYLE, "filter") } catch (_e) {}
                    s.setText("")
                    body.append(s)
                    filterStyle = s
                }
            } catch (e) { dsetErr("fstyle") }
        }
        async function applyFilter(): Promise<void> {
            await ensureFilterStyle()
            if (!filterStyle) return
            const f = filter
            const a = authorQ.toLowerCase().replace(/["\\]/g, "")
            let css = ""
            if (f && f !== "all" && entries.length > 0) css += '[class*="extension-card"]:not([' + A_TAGS + '~="' + f + '"]){display:none !important}'
            if (a && decorated) css += '[class*="extension-card"]:not([' + A_AUTHOR + '*="' + a + '"]){display:none !important}'
            try { filterStyle.setText(css) } catch (e) { dsetErr("filter") }
        }

        let authorToken = 0
        function onAuthorInput(el: any): void {
            const t = ++authorToken
            try {
                el.getProperty("value").then((v: any) => {
                    if (t !== authorToken) return
                    authorQ = v == null ? "" : String(v)
                    applyFilter().catch(() => {})
                }).catch(() => {})
            } catch (_e) {}
        }
        async function buildStatusDropdown(boxClass: string, gen: number): Promise<any> {
            let sel: any = null
            try { sel = await ctx.dom.createElement("select") } catch (_e) {}
            if (!sel) return null

            try { sel.setAttribute("class", boxClass) } catch (_e) {}
            try { sel.setCssText(SELECT_OVERRIDE_CSS) } catch (_e) {}
            try { sel.setAttribute("aria-label", "Filter extensions by status") } catch (_e) {}
            try { sel.setAttribute("title", "Filter extensions by status") } catch (_e) {}

            try { sel.setInnerHTML(STATUS_HTML) } catch (_e) {}
            try { sel.setProperty("value", filter) } catch (_e) {}

            const onPick = (): void => {
                if (gen !== epoch) return
                try {
                    sel.getProperty("value").then((v: any) => {
                        if (gen !== epoch) return
                        filter = v == null ? "all" : String(v)
                        applyFilter().catch(() => {})
                    }).catch(() => {})
                } catch (_e) {}
            }
            try { sel.addEventListener("change", onPick) } catch (_e) {}
            return sel
        }

        async function buildAuthorInput(inputClass: string, gen: number): Promise<any> {
            let author: any = null
            try { author = await ctx.dom.createElement("div") } catch (_e) {}
            if (!author) return null
            try { author.setCssText("position:relative;display:flex;align-items:center;flex:none;width:220px;max-width:220px;box-sizing:border-box") } catch (_e) {}
            try { author.setInnerHTML('<span class="' + ICON_CLASS + '" style="z-index:1" aria-hidden="true">' + PERSON_SVG + '</span><input type="text" placeholder="Search by author..." aria-label="Search extensions by author" class="' + esc(inputClass) + '" />') } catch (_e) {}
            let ains: any[] = []
            try { ains = await author.query("input") } catch (_e) {}
            if (ains && ains.length) {
                const ainput = ains[0]
                try { ainput.setProperty("value", authorQ) } catch (_e) {}
                try { ainput.addEventListener("input", () => { if (gen !== epoch) return; onAuthorInput(ainput) }) } catch (_e) {}
                try { ainput.addEventListener("keyup", () => { if (gen !== epoch) return; onAuthorInput(ainput) }) } catch (_e) {}
            }
            return author
        }

        async function resolveAnchors(input: any): Promise<any> {
            let ic: any = null
            try { ic = await input.getParent() } catch (_e) {}
            let rowEl: any = null
            if (ic) { try { rowEl = await ic.getParent() } catch (_e) {} }
            let toolbar: any = null
            if (rowEl) { try { toolbar = await rowEl.getParent() } catch (_e) {} }
            let langRoot: any[] = []
            if (toolbar) { try { langRoot = await toolbar.query(".UI-Select__root") } catch (_e) {} }
            return { ic: ic, rowEl: rowEl, toolbar: toolbar, hasLang: !!(langRoot && langRoot.length) }
        }

        let injectedIds: { [k: string]: boolean } = {}
        let cachedInputClass = ""
        async function injectControls(inputs: any[]): Promise<void> {
            if (!inputs || !inputs.length) return
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i]
                const eid = input && input.id ? String(input.id) : ""
                if (eid && injectedIds[eid]) continue
                if (eid) injectedIds[eid] = true
                try { input.setAttribute(A_TB, "1") } catch (_e) {}
                const gen = epoch

                if (!cachedInputClass) { try { const c = await input.getAttribute("class"); cachedInputClass = c ? String(c) : "" } catch (_e) {} }
                const cls = cachedInputClass

                let anchors: any = {}
                let statusEl: any = null, author: any = null
                try {
                    const r = await Promise.all([
                        resolveAnchors(input),
                        buildStatusDropdown(cls, gen).catch(() => null),
                        buildAuthorInput(cls, gen).catch(() => null),
                    ])
                    anchors = r[0]; statusEl = r[1]; author = r[2]
                } catch (_e) {}
                const { ic, rowEl, toolbar, hasLang } = anchors

                if (hasLang) {
                    if (toolbar) {
                        try { toolbar.setStyle("align-items", "center") } catch (_e) {}
                        try { toolbar.setStyle("flex-wrap", "wrap") } catch (_e) {}
                    }
                    if (statusEl && rowEl) { try { rowEl.before(statusEl) } catch (e) { dsetErr("place") } }
                    if (author && rowEl) { try { rowEl.before(author) } catch (_e) {} }
                    if (rowEl) {
                        try { rowEl.setStyle("flex", "1 1 200px") } catch (_e) {}
                        try { rowEl.setStyle("max-width", "100%") } catch (_e) {}
                    }
                } else if (ic) {
                    if (rowEl) {
                        try { rowEl.setStyle("display", "flex") } catch (_e) {}
                        try { rowEl.setStyle("align-items", "center") } catch (_e) {}
                        try { rowEl.setStyle("gap", "8px") } catch (_e) {}
                        try { rowEl.setStyle("flex-wrap", "wrap") } catch (_e) {}
                    }
                    if (statusEl) { try { ic.before(statusEl) } catch (e) { dsetErr("place") } }
                    if (author) { try { ic.before(author) } catch (_e) {} }
                    try { ic.setStyle("flex", "1 1 320px") } catch (_e) {}
                    try { ic.setStyle("max-width", "100%") } catch (_e) {}
                }
            }
        }

        function reobserve(prev: any, sel: string, cb: any, code: string, opts?: any): any {
            if (prev) { try { prev() } catch (_e) {} }
            try { return ctx.dom.observe(sel, cb, opts)[0] } catch (_e) { dsetErr(code); return null }
        }
        function startControls(): void {
            if (!domReady) return
            controlsCancel = reobserve(controlsCancel, 'input[placeholder^="Search"][placeholder*="extensions"]:not([' + A_TB + '])', injectControls, "obs-ctl")
        }
        function startCards(): void {
            if (!domReady) return
            cardsCancel = reobserve(cardsCancel, '[class*="extension-card"]:not([' + A_TAGS + '])', decorateCards, "obs-cards", { withInnerHTML: true })
            applyFilter().catch(() => {})
        }
        function resetForReady(): void {
            filterStyle = null
            injectedIds = {}
            epoch++
            try {
                ctx.dom.query("[" + A_STYLE + "]").then((olds: any[]) => {
                    if (olds) for (let i = 0; i < olds.length; i++) { try { olds[i].remove() } catch (_e) {} }
                }, () => {})
            } catch (_e) {}
            try {
                ctx.dom.query("[" + A_TB + "]").then((marked: any[]) => {
                    if (marked) for (let i = 0; i < marked.length; i++) { try { marked[i].removeAttribute(A_TB) } catch (_e) {} }
                }, () => {})
            } catch (_e) {}
        }
        function onDomReady(): void {
            domReady = true
            startControls()
            startCards()
            load(false).catch(() => {})
        }
        try { ctx.dom.onReady(() => { resetForReady(); onDomReady() }) } catch (_e) {}
        try { ctx.dom.onMainTabReady(() => { resetForReady(); onDomReady() }) } catch (_e) {}
        try { ctx.screen.onNavigate(() => { startControls(); startCards(); load(false).catch(() => {}) }) } catch (_e) {}

        async function fetchOwn(): Promise<Entry[]> {
            try {
                const res = await fetch(OWN_SRC)
                if (!res.ok) return []
                const data = res.json<any>()
                if (!Array.isArray(data)) return []
                return (data as any[]).filter((e) => e && typeof e === "object" && e.id) as Entry[]
            } catch (_e) {
                return []
            }
        }

        let inflight = false
        let loadFails = 0
        let loadWarned = false
        let retryPending = false
        function scheduleRetry(): void {
            if (retryPending) return
            loadFails++
            if (loadFails > 3) {
                if (!loadWarned) {
                    loadWarned = true
                    try { ctx.toast.warning("Seatags could not load the tag list, so cards stay untagged for now.") } catch (_e) {}
                }
                return
            }
            retryPending = true
            try {
                ctx.setTimeout(() => { retryPending = false; load(true).catch(() => {}) }, 5000 * loadFails)
            } catch (_e) {
                retryPending = false
            }
        }
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entries.length > 0 && Date.now() - lastAt < CACHE_TTL) return
            inflight = true
            let dataChanged = false
            let ok = false
            try {
                const res = await fetch(SRC)
                if (res.ok) {
                    let data: any = undefined
                    try { data = res.json<any>() } catch (_e) { dsetErr("parse") }
                    if (Array.isArray(data)) {
                        ok = true
                        const clean = (data as any[]).filter((e) => e && typeof e === "object")
                        const haveId: { [k: string]: boolean } = {}
                        for (const e of clean) { if (e && e.id) haveId["#" + String(e.id)] = true }
                        for (const e of await fetchOwn()) {
                            const k = "#" + String(e.id)
                            if (haveId[k]) continue
                            haveId[k] = true
                            clean.push(e)
                        }
                        try { dataChanged = JSON.stringify(entries) !== JSON.stringify(clean) } catch (_e) { dataChanged = true }
                        entries = clean as Entry[]
                        rebuildMaps()
                        try { $storage.set(CACHE_KEY, { at: Date.now(), data: clean }) } catch (_e) {}
                    } else if (data !== undefined) {
                        dsetErr("shape")
                    }
                    lastAt = Date.now()
                } else {
                    dsetErr("http")
                }
            } catch (_e) {
                dsetErr("fetch")
            }
            inflight = false
            if (ok) loadFails = 0
            else scheduleRetry()
            if (dataChanged) { try { await refreshDecorated() } catch (_e) {} }
            startCards()
        }

        ctx.setTimeout(() => { if (!domReady) onDomReady() }, 3000)
    })
}
