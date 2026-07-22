declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

function init() {
    $ui.register((ctx) => {
        // ── aqualog v1 ───────────────────────────────────────────────────────────────
        // Shared logging core. Plugins have no module system, so this block is copied
        // verbatim into each plugin instead of imported — keep the copies identical.
        // Every line in a plugin's log buffer has the same shape:
        //
        //     HH:MM:SS.mmm LVL [scope] message
        //
        // which is what lets the tray colour lines by severity, and what keeps a copied
        // log readable when it mixes plugin events with a child process's own output.
        type AqLevel = "ERR" | "WRN" | "OK" | "INF" | "DBG"

        const AQ_SEH_MARKER = "SEHERRv1"
        const AQ_LINE_RE = /^\d{2}:\d{2}:\d{2}\.\d{3} (ERR|WRN|OK|INF|DBG)\s/
        const AQ_GO_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\s+(INFO|ERROR|WARNING|WARN|DIAG|DEBUG)\s+/
        const AQ_SCOPE_RE = /^\[([A-Za-z0-9_/-]{2,24})\]\s*/

        const AQ_COLOR: { [k: string]: string } = {
            ERR: "rgba(255,138,138,0.95)",
            WRN: "rgba(255,199,120,0.95)",
            OK: "rgba(146,222,170,0.95)",
            INF: "rgba(255,255,255,0.78)",
            DBG: "rgba(255,255,255,0.45)",
        }

        function aqStamp(ms?: number): string {
            try {
                const d = ms === undefined || ms <= 0 ? new Date() : new Date(ms)
                const p2 = (n: number): string => (n < 10 ? "0" : "") + n
                const p3 = (n: number): string => (n < 100 ? (n < 10 ? "00" : "0") : "") + n
                return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds())
            } catch (_e) {
                return "00:00:00.000"
            }
        }

        // aqText flattens a message to one printable line. The tray renders logs in a
        // monospace box where an embedded newline breaks the one-line-per-event
        // alignment, and a few glyphs render inconsistently across platforms.
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

        function aqLine(lvl: AqLevel, scope: string, msg: string, ms?: number): string {
            const body = aqText(msg)
            if (!body) return ""
            return aqStamp(ms) + " " + (lvl + "  ").slice(0, 3) + " [" + (scope || "plugin") + "] " + body
        }

        function aqLevelOf(line: string): AqLevel {
            const m = AQ_LINE_RE.exec(line)
            if (m) return m[1] as AqLevel
            return aqGuessLevel(line)
        }

        // aqGuessLevel only runs on text that carries no level of its own. It stays
        // deliberately narrow: over-eager matching paints ordinary lines red.
        function aqGuessLevel(text: string): AqLevel {
            if (/\b(error|fatal|panic|failed|failure|refused|denied)\b/i.test(text)) return "ERR"
            if (/\b(warn|warning|deprecated)\b/i.test(text)) return "WRN"
            return "INF"
        }

        function aqMapLevel(tag: string): AqLevel {
            switch (tag.toUpperCase()) {
                case "ERROR":
                    return "ERR"
                case "WARNING":
                case "WARN":
                    return "WRN"
                case "DIAG":
                case "DEBUG":
                    return "DBG"
                default:
                    return "INF"
            }
        }

        // aqNormalize rewrites a foreign log line — a Go logger's "date LEVEL msg", a
        // bare "[subsystem] msg" tag, or raw stderr — into the canonical shape, so one
        // buffer holds one format. Lines that are already canonical pass through
        // untouched, which is what lets a plugin's own events and a child process's
        // output share a single funnel.
        function aqNormalize(line: string, defScope: string): string {
            const raw = aqText(line)
            if (!raw) return ""
            if (AQ_LINE_RE.test(raw)) return raw
            let rest = raw
            let ms = 0
            let lvl: AqLevel | undefined = undefined
            let scope = defScope
            const g = AQ_GO_RE.exec(rest)
            if (g) {
                try {
                    ms = new Date(parseInt(g[1], 10), parseInt(g[2], 10) - 1, parseInt(g[3], 10),
                        parseInt(g[4], 10), parseInt(g[5], 10), parseInt(g[6], 10)).getTime()
                } catch (_e) {
                    ms = 0
                }
                lvl = aqMapLevel(g[7])
                rest = rest.slice(g[0].length)
            }
            const s = AQ_SCOPE_RE.exec(rest)
            if (s) {
                const sub = s[1]
                scope = defScope ? defScope + "/" + sub : sub
                rest = rest.slice(s[0].length)
            }
            return aqLine(lvl === undefined ? aqGuessLevel(rest) : lvl, scope, rest, ms)
        }

        function aqStyle(lvl: AqLevel): { [k: string]: string } {
            return {
                fontSize: "11px",
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                lineHeight: "1.5",
                color: AQ_COLOR[lvl] || AQ_COLOR.INF,
            }
        }

        // aqReport mirrors a genuine error into Seanime's own log. console.error is the
        // only console level the host records above Debug, and the SEHERRv1 marker is
        // what Aqua's Utils scrapes back out of /api/v1/logs/latest — so this is the one
        // path that makes a plugin error visible outside its own tray. $debug is not an
        // option: the host binds it to a no-op unless the plugin is in development mode.
        function aqReport(ext: string, scope: string, msg: string): void {
            try {
                const body = aqText(msg)
                if (!body) return
                console.error(AQ_SEH_MARKER + " " + JSON.stringify({ t: Date.now(), ext: ext, scope: scope, msg: body }))
            } catch (_e) {}
        }
        // ── end aqualog v1 ───────────────────────────────────────────────────────────

        const SRC = "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/main/Marketplace/Main.json"
        const EXT_ID = "aq-seatags-beta"
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
                if (!e || typeof e !== "object") continue
                if (e.id) byId[e.id] = e
                if (e.name) byName[String(e.name).toLowerCase()] = e
            }
        }
        rebuildMaps()

        let dErr = ""
        // dErr used to be write-only: every failure was recorded and surfaced
        // nowhere. Route it through the shared reporter so it reaches the error
        // panel that already aggregates extension failures. Each distinct code
        // reports once per session, since the observers can fire repeatedly.
        const dErrSeen: { [k: string]: boolean } = {}
        function dsetErr(code: string): void {
            dErr = code
            if (dErrSeen[code]) return
            dErrSeen[code] = true
            aqReport(EXT_ID, "decorate", code)
        }
        let domReady = false
        let controlsCancel: any = null
        let cardsCancel: any = null
        let filterStyle: any = null
        let genById: { [k: string]: number } = {}
        let genSeq = 0
        function live(eid: string, gen: number): boolean { return genById[eid] === gen }

        const CTL_INPUT_CSS = "height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:#0b0b0b;color:#d1d1d1;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box;padding:0 12px;min-width:180px"
        const CTL_WRAP_CSS = "display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;align-items:center;flex:1 1 auto;min-width:0"
        const CTL_TRIGGER_CSS = "height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background-color:#0b0b0b;color:#d1d1d1;font-size:14px;font-family:inherit"
        const TRIGGER_OVERRIDE_CSS = "display:flex;align-items:center;justify-content:space-between;padding-left:0.75rem;padding-right:0.75rem;width:100%;box-sizing:border-box;cursor:pointer"
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
            let badges: any[] = [], block: any = null, existing: any[] = []
            try {
                const r = await Promise.all([
                    card.query(".UI-Badge__root").catch(() => []),
                    ctx.dom.createElement("div").catch(() => null),
                    card.query(".seatags-block").catch(() => []),
                ])
                badges = r[0] || []; block = r[1]; existing = r[2] || []
            } catch (e) { dsetErr("findrow") }
            for (let i = 0; i < existing.length; i++) { try { existing[i].remove() } catch (_e) {} }
            if (!block) return
            let row: any = null
            if (badges.length) { try { row = await badges[0].getParent() } catch (_e) {} }
            try { block.setAttribute("class", "seatags-block") } catch (_e) {}
            try { block.setCssText("display:flex;flex-direction:column;gap:6px;margin-top:8px") } catch (_e) {}
            try { block.setInnerHTML(blockHtml(info, tags)) } catch (e) { dsetErr("html") }
            if (row) {
                try { row.setStyle("display", "none") } catch (_e) {}
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
                try { card.setAttribute("data-seatags", tags.length ? tags.join(" ") : "untagged") } catch (e) { dsetErr("attr") }
                try { card.setAttribute("data-seatags-author", author) } catch (_e) {}
                if (info) await rebuildBadges(card, info, tags)
            } finally {
                if (cid) delete decorating[cid]
            }
        }
        function decorateCards(cards: any[]): void {
            if (!cards) return
            // Decorate in small chunks with a yield so a large marketplace (~200 cards) doesn't flood the
            // op scheduler and delay the toolbar controls. The first (visible) cards finish immediately.
            const CHUNK = 15
            let i = 0
            function step(): void {
                const end = i + CHUNK < cards.length ? i + CHUNK : cards.length
                for (; i < end; i++) decorateOne(cards[i]).catch(() => {})
                if (i < cards.length) { try { ctx.setTimeout(step, 16) } catch (_e) {} }
            }
            step()
        }

        // After a fetch changes the data, strip already-decorated cards (the observer won't re-deliver
        // them while they still carry [data-seatags]) so the re-armed observer re-decorates with fresh tags.
        async function refreshDecorated(): Promise<void> {
            let cards: any[] = [], blocks: any[] = []
            try {
                const r = await Promise.all([
                    ctx.dom.query("[data-seatags]").catch(() => []),
                    ctx.dom.query(".seatags-block").catch(() => []),
                ])
                cards = r[0] || []; blocks = r[1] || []
            } catch (_e) {}
            for (let i = 0; i < blocks.length; i++) { try { blocks[i].remove() } catch (_e) {} }
            for (let i = 0; i < cards.length; i++) { try { cards[i].removeAttribute("data-seatags") } catch (_e) {} }
        }

        // ---------- injected stylesheets ----------
        async function ensureFilterStyle(): Promise<void> {
            if (filterStyle) return
            try {
                const body = await ctx.dom.queryOne("body")
                if (body) {
                    const s = await ctx.dom.createElement("style")
                    try { s.setAttribute("data-seatags-style", "filter") } catch (_e) {}
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
            if (f && f !== "all" && entriesState.get().length > 0) css += '[class*="extension-card"]:not([data-seatags~="' + f + '"]){display:none !important}'
            if (a) css += '[class*="extension-card"]:not([data-seatags-author*="' + a + '"]){display:none !important}'
            try { filterStyle.setText(css) } catch (e) { dsetErr("filter") }
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
                try { s.setAttribute("data-seatags-style", "hover") } catch (_e) {}
                s.setText(".seatags-status-item:hover{background-color:var(--subtle)}")
                b.append(s)
                hoverStyle = s
            } catch (_e) {}
        }

        type Menu = { open: boolean; cancel: any; content: any; body: any; checks: any[]; gen: number; eid: string }
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
            if (st.body) { try { st.cancel = st.body.addEventListener("click", () => { if (!live(st.eid, st.gen)) return; closeMenu(st) }) } catch (_e) {} }
        }
        function toggleMenu(st: Menu): void { if (st.open) closeMenu(st); else openMenu(st) }

        let cachedBody: any = null
        async function getBody(): Promise<any> {
            if (cachedBody) return cachedBody
            try { cachedBody = await ctx.dom.queryOne("body") } catch (_e) {}
            return cachedBody
        }

        // Builds a div-based dropdown that reuses Seanime's own Select classes (looks identical).
        // Parallelizes the blocking reads (createElement / query) to minimize insertion latency.
        async function buildStatusDropdown(boxClass: string, gen: number, eid: string): Promise<any> {
            await ensureHoverStyle()
            const body = await getBody()

            let container: any = null, trigger: any = null, content: any = null
            try {
                const made = await Promise.all([
                    ctx.dom.createElement("div").catch(() => null),
                    ctx.dom.createElement("div").catch(() => null),
                    ctx.dom.createElement("div").catch(() => null),
                ])
                container = made[0]; trigger = made[1]; content = made[2]
            } catch (_e) {}
            if (!container || !trigger || !content) return null

            try { container.setCssText("position:relative;flex:none;width:200px;box-sizing:border-box") } catch (_e) {}

            if (boxClass) {
                try { trigger.setAttribute("class", boxClass) } catch (_e) {}
                try { trigger.setCssText(TRIGGER_OVERRIDE_CSS) } catch (_e) {}
            } else {
                try { trigger.setCssText(CTL_TRIGGER_CSS + ";" + TRIGGER_OVERRIDE_CSS) } catch (_e) {}
            }
            const labelStyle = "flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            try { trigger.setInnerHTML('<span class="seatags-label" style="' + labelStyle + '">' + esc(statusLabel(filterState.get())) + '</span><span class="UI-Combobox__chevronIcon ml-2 h-4 w-4 shrink-0 opacity-50">' + CHEVRON_SVG + '</span>') } catch (_e) {}

            try { content.setAttribute("class", SEL_CONTENT_CLASS) } catch (_e) {}
            try { content.setCssText("position:absolute;top:0;left:-24px;width:224px;box-sizing:border-box;display:none") } catch (_e) {}
            let itemsHtml = '<div class="' + SEL_VIEWPORT_CLASS + '">'
            for (let i = 0; i < STATUS_OPTS.length; i++) {
                const cdisp = STATUS_OPTS[i][0] === filterState.get() ? "inline-flex" : "none"
                itemsHtml += '<div class="' + SEL_ITEM_CLASS + '" style="cursor:default">'
                itemsHtml += '<span class="' + CHECK_ICON_CLASS + ' seatags-check" style="display:' + cdisp + '">' + CHECK_SVG + '</span>'
                itemsHtml += '<span>' + esc(STATUS_OPTS[i][1]) + '</span></div>'
            }
            itemsHtml += '</div>'
            try { content.setInnerHTML(itemsHtml) } catch (_e) {}

            try { container.append(trigger) } catch (_e) {}
            try { container.append(content) } catch (_e) {}

            let label: any = null, items: any[] = [], checks: any[] = []
            try {
                const q = await Promise.all([
                    trigger.query(".seatags-label").catch(() => []),
                    content.query(".seatags-status-item").catch(() => []),
                    content.query(".seatags-check").catch(() => []),
                ])
                if (q[0] && q[0].length) label = q[0][0]
                items = q[1] || []
                checks = q[2] || []
            } catch (_e) {}

            const st: Menu = { open: false, cancel: null, content: content, body: body, checks: [], gen: gen, eid: eid }
            if (checks) {
                for (let i = 0; i < checks.length && i < STATUS_OPTS.length; i++) {
                    if (checks[i]) st.checks.push({ val: STATUS_OPTS[i][0], el: checks[i] })
                }
            }
            if (items) {
                for (let i = 0; i < items.length && i < STATUS_OPTS.length; i++) {
                    const val = STATUS_OPTS[i][0]
                    const lbl = STATUS_OPTS[i][1]
                    const it = items[i]
                    if (it) { try { it.addEventListener("click", () => { if (!live(eid, gen)) return; filterState.set(val); if (label) { try { label.setText(lbl) } catch (_e) {} } updateChecks(st); applyFilter().catch(() => {}); closeMenu(st) }) } catch (_e) {} }
                }
            }
            try { trigger.addEventListener("click", () => { if (!live(eid, gen)) return; toggleMenu(st) }) } catch (_e) {}
            return container
        }

        async function buildAuthorInput(inputClass: string, gen: number, eid: string): Promise<any> {
            if (inputClass) {
                let author: any = null
                try { author = await ctx.dom.createElement("div") } catch (_e) {}
                if (!author) return null
                try { author.setCssText("position:relative;display:flex;align-items:center;flex:none;width:220px;max-width:220px;box-sizing:border-box") } catch (_e) {}
                try { author.setInnerHTML('<span class="' + ICON_CLASS + '" style="z-index:1">' + PERSON_SVG + '</span><input type="text" placeholder="Search by author..." class="' + esc(inputClass) + '" />') } catch (_e) {}
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
                try { input.setAttribute("data-seatags-tb", "1") } catch (_e) {}
                const gen = ++genSeq
                genById[eid] = gen

                // The search input's class is the InputAnatomy box (same box the language Select uses) — read once.
                if (!cachedInputClass) { try { const c = await input.getAttribute("class"); cachedInputClass = c ? String(c) : "" } catch (_e) {} }
                const cls = cachedInputClass

                // Resolve anchors AND build both controls concurrently (builds don't depend on anchors)
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

        // ---------- startup ----------
        // Observers are (re-)armed on every ready/navigate. On a client reload the server-side plugin
        // persists, so we cancel the stale observer and register a fresh one for the new client.
        function startControls(): void {
            if (!domReady) return
            if (controlsCancel) { try { controlsCancel() } catch (_e) {} controlsCancel = null }
            try {
                const r: any = ctx.dom.observe('input[placeholder^="Search"][placeholder*="extensions"]:not([data-seatags-tb])', injectControls)
                controlsCancel = (r && r.length) ? r[0] : null
            } catch (e) { dsetErr("obs-ctl") }
        }
        function startCards(): void {
            if (!domReady) return
            if (entriesState.get().length === 0) { applyFilter().catch(() => {}); return }
            if (cardsCancel) { try { cardsCancel() } catch (_e) {} cardsCancel = null }
            try {
                const r: any = ctx.dom.observe('[class*="extension-card"]:not([data-seatags])', decorateCards, { withInnerHTML: true })
                cardsCancel = (r && r.length) ? r[0] : null
            } catch (e) { dsetErr("obs-cards") }
            applyFilter().catch(() => {})
        }
        async function resetForReady(): Promise<void> {
            // A client reload resets the frontend's element-id counter, so our persisted handles and the
            // injected-id cache go stale and can collide with new elements (a recycled id can now point at a
            // live element, so calling .remove() on a stale handle would delete real UI). Drop the refs
            // WITHOUT removing through them; the old client's DOM is already gone on reload. For a same-tab
            // reset (no reload) clear any leftover styles by querying fresh handles instead.
            filterStyle = null
            hoverStyle = null
            cachedBody = null
            injectedIds = {}
            genById = {}
            // ctx.dom.query never settles off the main/disposed tab; awaiting it here would block the
            // resets above and (via .then) onDomReady. Clean up leftover styles fire-and-forget instead.
            try {
                ctx.dom.query("[data-seatags-style]").then((olds: any[]) => {
                    if (olds) for (let i = 0; i < olds.length; i++) { try { olds[i].remove() } catch (_e) {} }
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
        try { ctx.screen.onNavigate(() => { startControls(); startCards() }) } catch (_e) {}

        // ---------- load the marketplace tag list ----------
        let inflight = false
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entriesState.get().length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            let dataChanged = false
            try {
                const res = await fetch(SRC, { timeout: 15 })
                if (res.ok) {
                    const data = res.json<any>()
                    if (Array.isArray(data)) {
                        const clean = (data as any[]).filter((e) => e && typeof e === "object")
                        try { dataChanged = JSON.stringify(entriesState.get()) !== JSON.stringify(clean) } catch (_e) { dataChanged = true }
                        entriesState.set(clean as Entry[])
                        rebuildMaps()
                        try { $storage.set(CACHE_KEY, { at: now(), data: clean }) } catch (_e) {}
                    } else {
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
            if (dataChanged) { try { await refreshDecorated() } catch (_e) {} }
            startCards()
        }

        ctx.setTimeout(() => { if (!domReady) onDomReady() }, 3000)
    })
}
