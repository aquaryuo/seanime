declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

function init() {
    $ui.register((ctx) => {

        const AQ_SEH_MARKER = "SEHERRv1"
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

        function aqReport(ext: string, scope: string, msg: string): void {
            try {
                const body = aqText(msg)
                if (!body) return
                console.error(AQ_SEH_MARKER + " " + JSON.stringify({ t: Date.now(), ext: ext, scope: scope, msg: body }))
            } catch (_e) {}
        }

        const SRC = "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/main/Marketplace/Main.json"
        const OWN_SRC = "https://raw.githubusercontent.com/aquaryuo/seanime/beta/marketplace.json"
        const EXT_ID = "aq-seatags-beta"
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
            const nameCount: { [k: string]: number } = {}
            const es = entriesState.get()
            for (let i = 0; i < es.length; i++) {
                const e = es[i]
                if (!e || typeof e !== "object") continue
                if (e.id) byId[e.id] = e
                if (e.name) {
                    const k = String(e.name).toLowerCase()
                    nameCount[k] = (nameCount[k] || 0) + 1
                    byName[k] = e
                }
            }
            for (const k in nameCount) {
                if (nameCount[k] > 1) delete byName[k]
            }
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
            aqReport(EXT_ID, "decorate", D_REASON[code] || code)
        }
        let domReady = false
        let controlsCancel: any = null
        let cardsCancel: any = null
        let filterStyle: any = null
        let genById: { [k: string]: number } = {}
        let genSeq = 0
        function live(eid: string, gen: number): boolean { return genById[eid] === gen }

        const CTL_INPUT_CSS = "height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:#0b0b0b;color:#d1d1d1;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box;padding:0 12px;min-width:180px"
        const CTL_TRIGGER_CSS = "height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background-color:#0b0b0b;color:#d1d1d1;font-size:14px;font-family:inherit"
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
            const rcss = "display:flex;flex-wrap:wrap;gap:6px;align-items:center"
            let r1 = ""
            for (let i = 0; i < tags.length; i++) r1 += chipHtml(PILL_LABEL[tags[i]] || tags[i], tags[i])
            if (typeof info.stars === "number" && info.stars > 0) r1 += chipHtml("★ " + info.stars, "stars")
            return '<div style="' + rcss + '">' + r1 + "</div>"
        }
        function hasChips(info: Entry, tags: string[]): boolean {
            return tags.length > 0 || (typeof info.stars === "number" && info.stars > 0)
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
            if (!hasChips(info, tags)) return
            let row: any = null
            if (badges.length) { try { row = await badges[0].getParent() } catch (_e) {} }
            try { block.setAttribute("class", C_BLOCK) } catch (_e) {}
            try { block.setCssText("display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px") } catch (_e) {}
            try { block.setInnerHTML(blockHtml(info, tags)) } catch (e) { dsetErr("html") }
            if (row) {
                try { row.after(block) } catch (e) { dsetErr("insert") }
            } else {
                try { card.append(block) } catch (e) { dsetErr("append") }
            }
        }

        const decorating: { [k: string]: boolean } = {}
        async function decorateOne(card: any): Promise<void> {
            const cid = card && card.id ? String(card.id) : ""
            if (cid) { if (decorating[cid]) return; decorating[cid] = true }
            try {
                const html = (card && card.innerHTML) ? String(card.innerHTML) : ""
                const id = extractId(html)
                let info: Entry | null = (id && !/\s/.test(id) && byId[id]) ? byId[id] : null
                if (!info) {
                    const nm = extractName(html)
                    if (nm && byName[nm.toLowerCase()]) info = byName[nm.toLowerCase()]
                }
                const tags = info ? tagsOf(info) : []
                const author = info && info.author ? String(info.author).toLowerCase() : ""
                try { card.setAttribute(A_TAGS, tags.length ? tags.join(" ") : "untagged") } catch (e) { dsetErr("attr") }
                try { card.setAttribute(A_AUTHOR, author) } catch (_e) {}
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
            const f = filterState.get()
            const a = authorState.get().toLowerCase().replace(/["\\]/g, "")
            let css = ""
            if (f && f !== "all" && entriesState.get().length > 0) css += '[class*="extension-card"]:not([' + A_TAGS + '~="' + f + '"]){display:none !important}'
            if (a && entriesState.get().length > 0) css += '[class*="extension-card"]:not([' + A_AUTHOR + '*="' + a + '"]){display:none !important}'
            try { filterStyle.setText(css) } catch (e) { dsetErr("filter") }
        }

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
        async function buildStatusDropdown(boxClass: string, gen: number, eid: string): Promise<any> {
            let sel: any = null
            try { sel = await ctx.dom.createElement("select") } catch (_e) {}
            if (!sel) return null

            if (boxClass) {
                try { sel.setAttribute("class", boxClass) } catch (_e) {}
                try { sel.setCssText(SELECT_OVERRIDE_CSS) } catch (_e) {}
            } else {
                try { sel.setCssText(CTL_TRIGGER_CSS + ";" + SELECT_OVERRIDE_CSS) } catch (_e) {}
            }
            try { sel.setAttribute("aria-label", "Filter extensions by status") } catch (_e) {}
            try { sel.setAttribute("title", "Filter extensions by status") } catch (_e) {}

            let optsHtml = ""
            for (let i = 0; i < STATUS_OPTS.length; i++) {
                optsHtml += '<option value="' + esc(STATUS_OPTS[i][0]) + '">' + esc(STATUS_OPTS[i][1]) + "</option>"
            }
            try { sel.setInnerHTML(optsHtml) } catch (_e) {}
            try { sel.setProperty("value", filterState.get()) } catch (_e) {}

            const onPick = (): void => {
                if (!live(eid, gen)) return
                try {
                    sel.getProperty("value").then((v: any) => {
                        if (!live(eid, gen)) return
                        filterState.set(v == null ? STATUS_OPTS[0][0] : String(v))
                        applyFilter().catch(() => {})
                    }).catch(() => {})
                } catch (_e) {}
            }
            try { sel.addEventListener("change", onPick) } catch (_e) {}
            return sel
        }

        async function buildAuthorInput(inputClass: string, gen: number, eid: string): Promise<any> {
            if (inputClass) {
                let author: any = null
                try { author = await ctx.dom.createElement("div") } catch (_e) {}
                if (!author) return null
                try { author.setCssText("position:relative;display:flex;align-items:center;flex:none;width:220px;max-width:220px;box-sizing:border-box") } catch (_e) {}
                try { author.setInnerHTML('<span class="' + ICON_CLASS + '" style="z-index:1" aria-hidden="true">' + PERSON_SVG + '</span><input type="text" placeholder="Search by author..." aria-label="Search extensions by author" class="' + esc(inputClass) + '" />') } catch (_e) {}
                let ains: any[] = []
                try { ains = await author.query("input") } catch (_e) {}
                if (ains && ains.length) {
                    const ainput = ains[0]
                    try { ainput.setProperty("value", authorState.get()) } catch (_e) {}
                    try { ainput.addEventListener("input", () => { if (!live(eid, gen)) return; onAuthorInput(ainput) }) } catch (_e) {}
                    try { ainput.addEventListener("keyup", () => { if (!live(eid, gen)) return; onAuthorInput(ainput) }) } catch (_e) {}
                }
                return author
            }
            let author: any = null
            try { author = await ctx.dom.createElement("input") } catch (_e) {}
            if (!author) return null
            try { author.setAttribute("type", "text") } catch (_e) {}
            try { author.setAttribute("placeholder", "Search by author...") } catch (_e) {}
            try { author.setAttribute("aria-label", "Search extensions by author") } catch (_e) {}
            try { author.setCssText(CTL_INPUT_CSS) } catch (_e) {}
            try { author.setProperty("value", authorState.get()) } catch (_e) {}
            try { author.addEventListener("input", () => { if (!live(eid, gen)) return; onAuthorInput(author) }) } catch (_e) {}
            try { author.addEventListener("keyup", () => { if (!live(eid, gen)) return; onAuthorInput(author) }) } catch (_e) {}
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
            return { ic: ic, rowEl: rowEl, toolbar: toolbar, langRoot: langRoot || [], hasLang: !!(langRoot && langRoot.length) }
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
                const gen = ++genSeq
                genById[eid] = gen

                if (!cachedInputClass) { try { const c = await input.getAttribute("class"); cachedInputClass = c ? String(c) : "" } catch (_e) {} }
                const cls = cachedInputClass

                let anchors: any = { ic: null, langRoot: [], hasLang: false }
                let statusEl: any = null, author: any = null
                try {
                    const r = await Promise.all([
                        resolveAnchors(input),
                        buildStatusDropdown(cls, gen, eid).catch(() => null),
                        buildAuthorInput(cls, gen, eid).catch(() => null),
                    ])
                    anchors = r[0]; statusEl = r[1]; author = r[2]
                } catch (_e) {}
                const ic = anchors.ic
                const rowEl = anchors.rowEl
                const toolbar = anchors.toolbar
                const hasLang = anchors.hasLang

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

        function startControls(): void {
            if (!domReady) return
            if (controlsCancel) { try { controlsCancel() } catch (_e) {} controlsCancel = null }
            try {
                const r: any = ctx.dom.observe('input[placeholder^="Search"][placeholder*="extensions"]:not([' + A_TB + '])', injectControls)
                controlsCancel = (r && r.length) ? r[0] : null
            } catch (e) { dsetErr("obs-ctl") }
        }
        function startCards(): void {
            if (!domReady) return
            if (entriesState.get().length === 0) { applyFilter().catch(() => {}); return }
            if (cardsCancel) { try { cardsCancel() } catch (_e) {} cardsCancel = null }
            try {
                const r: any = ctx.dom.observe('[class*="extension-card"]:not([' + A_TAGS + '])', decorateCards, { withInnerHTML: true })
                cardsCancel = (r && r.length) ? r[0] : null
            } catch (e) { dsetErr("obs-cards") }
            applyFilter().catch(() => {})
        }
        async function resetForReady(): Promise<void> {
            filterStyle = null
            injectedIds = {}
            genById = {}
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
        try { ctx.dom.onReady(() => { resetForReady().then(() => onDomReady(), () => onDomReady()) }) } catch (_e) {}
        try { ctx.dom.onMainTabReady(() => { resetForReady().then(() => onDomReady(), () => onDomReady()) }) } catch (_e) {}
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
            if (!force && entriesState.get().length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            let dataChanged = false
            let ok = false
            try {
                const res = await fetch(SRC, { timeout: 15 })
                if (res.ok) {
                    let data: any = undefined
                    let parsed = true
                    try { data = res.json<any>() } catch (_e) { parsed = false; dsetErr("parse") }
                    if (!parsed) data = undefined
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
                        try { dataChanged = JSON.stringify(entriesState.get()) !== JSON.stringify(clean) } catch (_e) { dataChanged = true }
                        entriesState.set(clean as Entry[])
                        rebuildMaps()
                        try { $storage.set(CACHE_KEY, { at: now(), data: clean }) } catch (_e) {}
                    } else if (parsed) {
                        dsetErr("shape")
                    }
                    lastAt = now()
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
