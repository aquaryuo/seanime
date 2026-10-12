declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Card = { sid: string; titles: string[]; type: string; year: number; eps: number }
type Cand = { r: SearchResult; card: Card }
type Target = { t: string; w: number }
type Scored = { c: Cand; s: number; adj: number; ep: number }
type Sub = { origin: string; lang: string; label: string; def: boolean; forced: boolean }

class Provider implements AnimeProvider {
    private baseUrl = this.cfg().replace(/\/+$/, "")
    private headers = { Referer: `${this.baseUrl}/` }
    private itemsMarkup = /items:\s*(?:JSON\.parse\(|\[)/
    private cacheTtl = 900000
    private srcCacheTtl = 300000
    private pageBudget = 10000
    private pageTimeout = 60
    private busy = "anizone: too many requests right now - wait a minute and retry"

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const sq = this.searchQueries(opts)
        const cands: Cand[] = []
        let anyOk = false
        let anyShape = false
        let limited = false
        const run = async (queries: string[]): Promise<void> => {
            for (const q of queries) {
                if (cands.length >= 12 || limited) break
                const ck = `anizone:q:${q.toLowerCase()}`
                let cards = this.readCache<Card[]>(ck, this.srcCacheTtl)
                if (cards) {
                    anyOk = true
                    anyShape = true
                } else {
                    let html = ""
                    try {
                        const res = await fetch(`${this.baseUrl}/anime?search=${encodeURIComponent(q)}`, {
                            headers: this.headers,
                            timeout: this.pageTimeout,
                        })
                        if (res.ok) {
                            anyOk = true
                            html = res.text()
                        }
                        limited = res.status === 429
                    } catch (_e) {}
                    cards = this.parseItems(html)
                    if (this.itemsMarkup.test(html)) {
                        anyShape = true
                        this.writeCache(ck, cards)
                    }
                }
                this.addCards(cards, opts, cands)
                if (this.pickBest(cands, opts.media, sq.season, sq.part).length === 1) return
            }
        }
        await run(sq.primary)
        if (cands.length === 0) await run(sq.fallback)
        if (limited) throw this.fail("search", this.busy)
        if (!anyOk) throw this.fail("search", "anizone: search failed (site unreachable)")
        if (!anyShape) throw this.fail("search", "anizone: search page layout not recognized")
        return this.pickBest(cands, opts.media, sq.season, sq.part)
    }

    private cfg(): string {
        const v = $getUserPreference("baseUrl")
        return v && v.indexOf("{{") === -1 ? v : "https://anizone.to"
    }

    private pickBest(cands: Cand[], media: Media, season: number, part: number): SearchResult[] {
        if (cands.length === 0) return []
        const targets = this.matchTargets(media)
        if (targets.length === 0) return cands.map((c) => c.r)
        const year = (media.startDate && media.startDate.year) || 0
        const eps = media.episodeCount && media.episodeCount > 0 ? media.episodeCount : 0
        const format = media.format || ""
        const scored: Scored[] = []
        const conflicted: Scored[] = []
        for (const c of cands) {
            const s = this.scoreTitles(c.card.titles, targets)
            const adj = s - this.yearPenalty(this.cardYear(c), year)
            const row = { c, s, adj, ep: eps > 0 && c.card.eps > 0 && c.card.eps === eps ? 1 : 0 }
            if (this.formatConflict(format, c.card.type)) conflicted.push(row)
            else scored.push(row)
        }
        if (scored.length === 0) for (const row of conflicted) scored.push(row)
        scored.sort((a, b) => b.adj - a.adj || b.ep - a.ep || b.s - a.s)
        const plausible = scored.filter((x) => x.adj >= 0.5)
        if (plausible.length === 0) return []
        const full = [media.romajiTitle, media.englishTitle].map((t) => this.normTitle(t || "")).filter((t) => t.length > 0)
        const picked = this.disambiguate(plausible, season, part, year, full)
        if (picked.length === 0) return []
        if (picked[0].adj >= 0.85 && (picked.length === 1 || picked[0].adj - picked[1].adj >= 0.12)) {
            return [picked[0].c.r]
        }
        return picked.map((x) => x.c.r)
    }

    private matchTargets(media: Media): Target[] {
        const out: Target[] = []
        const seen = new Set<string>()
        const push = (s: string, w: number): void => {
            const n = this.normTitle(s)
            if (n.length >= 3 && !seen.has(n)) {
                seen.add(n)
                out.push({ t: n, w })
            }
        }
        for (const t of [media.romajiTitle, media.englishTitle]) {
            if (!t) continue
            push(t, 1)
            push(t.split(/[:,;~]/)[0], 0.8)
            const nz = this.norm(t)
            push(nz.cleanBaseTitle || "", 1)
            push(nz.denoisedTitle || "", 1)
        }
        if (media.synonyms) for (const s of media.synonyms) push(s, 1)
        return out
    }

    private scoreTitles(titles: string[], targets: Target[]): number {
        let best = 0
        for (const title of titles) {
            const c = this.normTitle(title)
            if (!c) continue
            for (const t of targets) {
                const v = this.simNorm(c, t.t) * t.w
                if (v > best) best = v
            }
        }
        return best
    }

    private cardYear(c: Cand): number {
        if (c.card.year > 0) return c.card.year
        return this.yearOf(c.r.title)
    }

    private yearPenalty(cardYear: number, mediaYear: number): number {
        if (cardYear <= 0 || mediaYear <= 0) return 0
        const d = Math.abs(cardYear - mediaYear)
        if (d <= 1) return 0
        if (d === 2) return 0.1
        return 0.35
    }

    private formatConflict(mediaFormat: string, cardType: string): boolean {
        const f = (mediaFormat || "").toUpperCase()
        const t = (cardType || "").toLowerCase()
        if (!f || !t || f === "TV" || f === "TV_SHORT") return false
        const cardMovie = t.indexOf("movie") !== -1
        const cardSeries = t.indexOf("tv series") !== -1
        return f === "MOVIE" ? cardSeries : cardMovie
    }

    private disambiguate(scored: Scored[], season: number, part: number, year: number, full: string[]): Scored[] {
        if (year > 0) {
            const ym = scored.filter((x) => this.cardYear(x.c) === year)
            if (ym.length > 0) {
                const exact = ym.some((x) => x.c.card.titles.some((t) => full.indexOf(this.normTitle(t)) !== -1))
                const tagged = !exact && (season >= 2 || part >= 2) ? ym.filter((x) => x.c.card.titles.some((t) => this.yearOf(t) === year)) : []
                return this.byPart(tagged.length > 0 ? tagged : ym, part)
            }
        }
        if (season < 2 && part < 2) return this.byPart(scored, part)
        return scored.filter((x) => {
            const seasonOk = season < 2 || this.cardMax(x.c, (t) => this.norm(t).season || 0) === season
            const partOk = part < 2 || this.cardMax(x.c, (t) => this.partOf(t)) === part
            return seasonOk && partOk
        })
    }

    private byPart(list: Scored[], part: number): Scored[] {
        const pm = list.filter((x) => {
            const p = this.cardMax(x.c, (t) => this.partOf(t))
            return part < 2 ? p < 2 : p === part
        })
        return pm.length > 0 ? pm : list
    }

    private cardMax(c: Cand, f: (t: string) => number): number {
        return Math.max(0, ...c.card.titles.map(f))
    }

    private yearOf(title: string): number {
        const m = (title || "").match(/\((\d{4})\b/)
        return m ? parseInt(m[1] || "0", 10) : 0
    }

    private norm(title: string): Partial<$scannerUtils.NormalizedTitle> {
        try {
            return $scannerUtils.normalizeTitle(title) || {}
        } catch (_e) {
            return {}
        }
    }

    private partOf(title: string): number {
        let p = this.norm(title).part || 0
        const m = (title || "").match(/\b(?:part|cour)\s*(\d+)\b/i) || (title || "").match(/\bdai\s*(\d+)\s*bu\b/i)
        if (m) {
            const v = parseInt(m[1] || "0", 10)
            if (v > p) p = v
        }
        return p
    }

    private normTitle(s: string): string {
        return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }

    private simNorm(a: string, b: string): number {
        const ml = Math.max(a.length, b.length)
        return ml === 0 ? 0 : 1 - this.lev(a, b) / ml
    }

    private lev(a: string, b: string): number {
        const m = a.length
        const n = b.length
        if (!m) return n
        if (!n) return m
        const d: number[] = new Array(n + 1)
        for (let j = 0; j <= n; j++) d[j] = j
        for (let i = 1; i <= m; i++) {
            let prev = d[0]
            d[0] = i
            for (let j = 1; j <= n; j++) {
                const tmp = d[j]
                d[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[j], d[j - 1])
                prev = tmp
            }
        }
        return d[n]
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const shortid = this.shortId(id)
        if (!shortid) return []
        const cacheKey = `anizone:eps:${id}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.cacheTtl)
        if (cached) return cached
        const res = await this.guarded("episodes", `${this.baseUrl}/anime/${shortid}`)
        if (res.status === 404) return []
        if (!res.ok) throw this.fail("episodes", `anizone: series page failed (status ${res.status})`)
        const html = res.text()
        const nums = new Set<number>()
        this.collectEps(html, shortid, nums)
        this.addItemEps(this.itemsJson(html), nums)
        let sure = true
        if (await this.walkPages(res, html, shortid, nums)) {
            const top = this.topOf(nums)
            const trim = await this.trimToExisting(res, html, shortid, top)
            sure = trim.sure
            for (let n = /sort&quot;:&quot;[a-z]+-desc/.test(html) ? 1 : top + 1; n <= trim.last; n++) nums.add(n)
        }
        if (nums.size === 0 && !this.itemsMarkup.test(html)) throw this.fail("episodes", "anizone: episode list not recognized - the site changed its layout")
        const episodes: EpisodeDetails[] = []
        for (const n of nums) episodes.push({ id: `${shortid}$${n}${id.slice(shortid.length)}`, number: n, url: `${this.baseUrl}/anime/${shortid}/${n}` })
        episodes.sort((a, b) => a.number - b.number)
        if (episodes.length > 0 && sure) this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("$")
        const shortid = parts[0]
        const n = parts[1] || String(episode.number)
        const audio = this.audioOf(episode.id)
        const cacheKey = `anizone:src:${shortid}:${n}`
        let cached = this.readCache<{ m3u8: string; subs: Sub[] }>(cacheKey, this.srcCacheTtl)
        if (!cached || !cached.m3u8) {
            const res = await this.guarded("server", `${this.baseUrl}/anime/${shortid}/${n}`)
            if (res.status === 404) {
                try {
                    $store.remove("anizone:eps:" + parts.filter((_, i) => i !== 1).join("$"))
                } catch (_e) {}
                throw this.fail("server", `anizone: episode ${n} is not on anizone yet - refresh the episode list`)
            }
            if (!res.ok) throw this.fail("server", `anizone: episode page failed (status ${res.status})`)
            cached = this.parsePlayer(res.text())
            if (!cached.m3u8) throw this.fail("server", "anizone: no stream found for this episode")
            this.writeCache(cacheKey, cached)
        }
        if (audio === "dub") {
            const dub = await this.hasEnglishAudio(cached.m3u8, shortid, n)
            if (dub === undefined) throw this.fail("server", "anizone: could not check the dub audio track - retry")
            if (!dub) throw this.fail("server", "anizone: no dub available for this episode", "info")
        }
        return {
            server: "Auto",
            headers: this.headers,
            videoSources: [
                {
                    url: cached.m3u8,
                    type: "m3u8",
                    quality: "auto",
                    subtitles: this.buildSubs(cached.subs),
                },
            ],
        }
    }

    private searchQueries(opts: SearchOptions): { primary: string[]; fallback: string[]; season: number; part: number } {
        const primary: string[] = []
        const fallback: string[] = []
        const seen = new Set<string>()
        const add = (list: string[], s: string): void => {
            const q = (s || "").trim()
            if (!q) return
            const key = q.toLowerCase()
            if (seen.has(key)) return
            seen.add(key)
            list.push(q)
        }
        const romaji = opts.media.romajiTitle || ""
        const english = opts.media.englishTitle || ""
        const seed = [opts.query, romaji, english].filter((s) => s)
        let season = 0
        let part = 0
        if (!romaji && !english) add(primary, opts.query || "")
        for (const s of [romaji, english]) {
            add(primary, s)
            add(primary, s.replace(/\s*\b(?:\d+(?:st|nd|rd|th)\s+season|season\s*\d+|part\s*\d+|cour\s*\d+)\b.*$/i, ""))
        }
        try {
            const smart = $scannerUtils.buildSmartSearchTitles(seed)
            if (smart) {
                season = smart.season || 0
                part = smart.part || 0
                if (smart.titles) for (const t of smart.titles) add(primary, t)
            }
        } catch (_e) {}
        if (part < 2) part = Math.max(part, ...seed.map((s) => this.partOf(s)))
        add(fallback, this.firstWords(romaji, 1))
        add(fallback, this.firstWords(english, 2))
        add(fallback, this.firstWords(romaji, 2))
        add(fallback, this.firstWords(english, 3))
        return { primary: primary.slice(0, 4), fallback: fallback.slice(0, 4), season, part }
    }

    private firstWords(title: string, n: number): string {
        const base = (title || "").split(/[:~]/)[0]
        const cleaned = base.replace(/[\[\]【】「」『』(){}"'“”‘’]/g, " ").replace(/\s+/g, " ").trim()
        return cleaned.split(" ").slice(0, n).join(" ")
    }

    private addCards(cards: Card[], opts: SearchOptions, out: Cand[]): void {
        const target = opts.media.romajiTitle || opts.media.englishTitle || ""
        const suffix = (opts.media.id > 0 ? `$al${opts.media.id}` : "") + (opts.dub ? "$dub" : "$sub")
        for (const c of cards) {
            if (out.some((x) => x.card.sid === c.sid)) continue
            out.push({
                r: {
                    id: c.sid + suffix,
                    title: this.bestTitle(c.titles, target),
                    url: `${this.baseUrl}/anime/${c.sid}`,
                    subOrDub: "both",
                },
                card: c,
            })
        }
    }

    private parsePlayer(html: string): { m3u8: string; subs: Sub[] } {
        const m = /vidstackPlayer\(JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html)
        let cfg: any = null
        try {
            cfg = m && JSON.parse(this.unescapeJs(this.decodeEntities(m[1] || "")))
        } catch (_e) {}
        if (!cfg || typeof cfg !== "object") return { m3u8: "", subs: [] }
        const subs = (Array.isArray(cfg.subtitles) ? cfg.subtitles : [])
            .filter((t: any) => t && typeof t.file === "string" && /^https?:\/\//i.test(t.file))
            .map((t: any): Sub => ({
                origin: t.file,
                lang: String(t.language || "en").toLowerCase(),
                label: String(t.title || ""),
                def: t.default === true,
                forced: t.forced === true || String(t.forced || "").toLowerCase() === "yes",
            }))
        return { m3u8: typeof cfg.src === "string" ? cfg.src : "", subs }
    }

    private async walkPages(page: FetchResponse, html: string, shortid: string, nums: Set<number>): Promise<boolean> {
        let more = !/hasMore:\s*false/.test(html) || nums.size === 0
        if (nums.size === this.topOf(nums)) return more
        const cm = /nextCursor:\s*'([^']+)'/.exec(html)
        let cursor = cm ? cm[1] : ""
        const lw = this.lwSession(page, html, shortid)
        const deadline = Date.now() + this.pageBudget
        while (more && cursor && lw.csrf && lw.snapshot && Date.now() < deadline) {
            let comp: any = null
            try {
                comp = await this.lwUpdate(lw, shortid, {}, [{ path: "", method: "loadPage", params: [cursor] }])
            } catch (_e) {
                break
            }
            const loaded = ((comp && comp.effects && comp.effects.dispatches) || []).filter((d: any) => d && d.name === "items-loaded")[0]
            if (!loaded || !loaded.params || typeof comp.snapshot !== "string") break
            lw.snapshot = comp.snapshot
            this.addItemEps(loaded.params.items, nums)
            cursor = loaded.params.nextCursor || ""
            more = loaded.params.hasMore !== false
        }
        return more
    }

    private lwSession(page: FetchResponse, html: string, shortid: string): { csrf: string; snapshot: string; cookie: string } {
        const tm = /data-csrf="([^"]+)"/.exec(html)
        let snapshot = ""
        const re = /wire:snapshot="([^"]*)"/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const s = this.decodeEntities(m[1] || "")
            if (s.indexOf(`"slug":"${shortid}"`) !== -1) snapshot = s
        }
        const jar = page.cookies || {}
        return { csrf: tm ? tm[1] : "", snapshot, cookie: Object.keys(jar).map((k) => `${k}=${jar[k]}`).join("; ") }
    }

    private async lwUpdate(lw: { csrf: string; snapshot: string; cookie: string }, shortid: string, updates: any, calls: any[], timeout?: number): Promise<any> {
        const res = await fetch(`${this.baseUrl}/livewire/update`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Livewire": "", Cookie: lw.cookie, Referer: `${this.baseUrl}/anime/${shortid}`, Origin: this.baseUrl },
            body: JSON.stringify({ _token: lw.csrf, components: [{ snapshot: lw.snapshot, updates, calls }] }),
            timeout,
        })
        return res.ok ? res.json().components[0] : null
    }

    private async trimToExisting(page: FetchResponse, html: string, shortid: string, known: number): Promise<{ last: number; sure: boolean }> {
        const stated = this.statedEpisodeCount(html)
        if (stated <= known) return { last: known, sure: true }
        let status = 0
        try {
            status = (await fetch(`${this.baseUrl}/anime/${shortid}/${stated}`, { headers: this.headers, timeout: 5 })).status
        } catch (_e) {}
        if (status === 200) return { last: stated, sure: true }
        const lw = this.lwSession(page, html, shortid)
        const nums = new Set<number>()
        if (lw.csrf && lw.snapshot) {
            try {
                const comp = await this.lwUpdate(lw, shortid, { sort: "default-desc" }, [], this.pageTimeout)
                this.addItemEps(this.itemsJson((comp && comp.effects && comp.effects.html) || ""), nums)
            } catch (_e) {}
        }
        const newest = this.topOf(nums)
        if (newest >= known) return { last: newest, sure: true }
        return { last: status === 404 ? stated - 1 : stated, sure: false }
    }

    private statedEpisodeCount(html: string): number {
        const m = /(\d+)\s+Episodes?</i.exec(html || "")
        if (!m) return 0
        const n = parseInt(m[1] || "0", 10)
        return n > 0 && n <= 10000 ? n : 0
    }

    private itemsJson(html: string): any[] {
        const m = /items:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html)
        try {
            const v = m && JSON.parse(this.unescapeJs(m[1] || ""))
            return Array.isArray(v) ? v : []
        } catch (_e) {
            return []
        }
    }

    private addItemEps(list: any, nums: Set<number>): void {
        for (const it of Array.isArray(list) ? list : []) {
            const n = parseInt(String(it && it.slug), 10)
            if (n > 0) nums.add(n)
        }
    }

    private parseItems(html: string): Card[] {
        const out: Card[] = []
        for (const it of this.itemsJson(html)) {
            if (!it || typeof it !== "object") continue
            const sid = String(it.slug || "")
            if (!sid) continue
            const tl = it.title_list && typeof it.title_list === "object" ? Object.values(it.title_list) : []
            const titles: string[] = Array.from(new Set([it.main_title].concat(tl).filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean)))
            if (titles.length === 0) continue
            out.push({ sid, titles, type: String(it.type || ""), year: this.toInt(it.start_year), eps: this.toInt(it.episode_count) })
        }
        return out
    }

    private toInt(v: any): number {
        return Math.max(0, parseInt(v, 10) || 0)
    }

    private unescapeJs(escaped: string): string {
        return escaped.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m: string, esc: string) => {
            if (esc.charAt(0) === "u") return String.fromCharCode(parseInt(esc.slice(1), 16))
            if (esc === "n") return "\n"
            if (esc === "t") return "\t"
            return esc
        })
    }

    private bestTitle(titles: string[], target: string): string {
        if (!target) return titles[0]
        try {
            const best = $scannerUtils.findBestMatch(target, titles)
            if (best) return best
        } catch (_e) {}
        return titles[0]
    }

    private decodeEntities(s: string): string {
        return (s || "")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'")
            .replace(/&nbsp;/gi, " ")
            .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (m, h, d) => {
                const n = h ? parseInt(h, 16) : +d
                return n > 0x10ffff ? m : String.fromCodePoint(n)
            })
            .trim()
    }

    private isNonDialogue(label: string): boolean {
        const l = label || ""
        if (/\b(?:full|dialogu?e|dialog|main|complete)\b/i.test(l)) return false
        return /\b(?:forced|forc[eé]s|signs?|songs?|karaoke|kfx|typeset(?:ting)?|commentary)\b/i.test(l) || /\bs\s*[&+\/]\s*s\b/i.test(l) || /\bop\s*[\/&+]\s*ed\b/i.test(l)
    }

    private trackScore(label: string, isEnglish: boolean, def: boolean, nd: boolean): number {
        const mtl = /\b(?:ai|mtl)\b/i.test(label || "")
        const alt = /\b(?:sdh|cc|closed[\s-]?captions?|hearing[\s-]?impaired|dub[\s-]?titles?)\b/i.test(label || "")
        const base = nd ? (isEnglish ? 3 : 0) : mtl ? (isEnglish ? 4 : 1) : alt ? (isEnglish ? 5 : 1) : isEnglish ? 6 : 2
        return def ? base * 10 + 1 : base * 10
    }

    private displayName(code: string, label: string): string {
        const name = this.langName(code)
        if (!label) return name
        if (!/[a-z]/.test(name)) return label
        const base = this.langName(code.split("-")[0])
        if (label.toLowerCase().indexOf(base.toLowerCase()) !== -1) return label
        return `${name} - ${label}`
    }

    private buildSubs(subs: Sub[]): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const nonDialogue: boolean[] = []
        const seen = new Set<string>()
        let pick = 0
        let best = -1
        for (const s of subs) {
            const origin = s.origin
            if (seen.has(origin)) continue
            seen.add(origin)
            const code = s.lang
            const label = s.label.trim()
            const idx = out.length
            out.push({ id: `${code}-${idx}`, url: origin, language: this.displayName(code, label), isDefault: false })
            const isForced = s.forced === true || this.isNonDialogue(label)
            const score = this.trackScore(label, code.split("-")[0] === "en", s.def === true, isForced)
            nonDialogue.push(isForced)
            if (score > best) {
                best = score
                pick = idx
            }
        }
        if (out.length === 0) return out
        out[pick].isDefault = true
        return [out[pick]].concat(out.filter((_, i) => i !== pick && !nonDialogue[i]), out.filter((_, i) => i !== pick && nonDialogue[i]))
    }

    private audioOf(id: string): string {
        const m = (id || "").match(/\$(dub|sub)$/)
        return m ? m[1] : "sub"
    }

    private async hasEnglishAudio(m3u8: string, shortid: string, n: string): Promise<boolean | undefined> {
        const key = `anizone:dub:${shortid}:${n}`
        const cached = this.readCache<boolean>(key, this.srcCacheTtl)
        if (cached !== undefined) return cached
        try {
            const res = await fetch(m3u8, { headers: this.headers })
            if (!res.ok) return undefined
            const body = res.text()
            const ok = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*LANGUAGE="(?:en|eng|en-[a-z]+)"/i.test(body) || /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*(?:english|\bdub\b)/i.test(body)
            this.writeCache(key, ok)
            return ok
        } catch (_e) {
            return undefined
        }
    }

    private langName(code: string): string {
        const map: { [key: string]: string } = {
            en: "English", ja: "Japanese", ar: "Arabic", de: "German", es: "Spanish", fr: "French",
            it: "Italian", ru: "Russian", pt: "Portuguese", hi: "Hindi", ta: "Tamil", id: "Indonesian",
            ko: "Korean", zh: "Chinese", th: "Thai", vi: "Vietnamese", tr: "Turkish", pl: "Polish", nl: "Dutch",
            my: "Malay", tl: "Tagalog",
            he: "Hebrew", fa: "Persian", uk: "Ukrainian", ro: "Romanian", el: "Greek", hu: "Hungarian",
            cs: "Czech", sk: "Slovak", sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish",
            bg: "Bulgarian", hr: "Croatian", sr: "Serbian", lt: "Lithuanian", lv: "Latvian", et: "Estonian",
            bn: "Bengali", te: "Telugu", ml: "Malayalam", mr: "Marathi", ur: "Urdu", ms: "Malay",
            ca: "Catalan", eu: "Basque", gl: "Galician", sq: "Albanian", mk: "Macedonian", sl: "Slovenian",
            "es-419": "Latin American Spanish", "pt-br": "Portuguese (Brazil)",
            "zh-hans": "Chinese (Simplified)", "zh-hant": "Chinese (Traditional)",
        }
        const c = (code || "").toLowerCase()
        if (map[c]) return map[c]
        const base = c.split("-")[0]
        return map[base] || c.toUpperCase()
    }

    private shortId(id: string): string {
        const i = id.indexOf("$")
        return i === -1 ? id : id.slice(0, i)
    }

    private collectEps(html: string, shortid: string, nums: Set<number>): void {
        if (!/^[\w-]{1,64}$/.test(shortid)) return
        const re = new RegExp(`/anime/${shortid}/(\\d+)`, "g")
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const n = parseInt(m[1] || "0", 10)
            if (n > 0) nums.add(n)
        }
    }

    private topOf(nums: Set<number>): number {
        return Math.max(0, ...nums)
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        const msg = String(message).replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?").trim()
        const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-anizone", scope: scope, msg, lvl: lvl })
        if (lvl) console.warn(line)
        else console.error(line)
    }

    private fail(scope: string, message: string, lvl?: "warn" | "info"): string {
        this.reportError(scope, message, lvl)
        return message
    }

    private async guarded(scope: string, url: string): Promise<FetchResponse> {
        let res: FetchResponse
        try {
            res = await fetch(url, { headers: this.headers, timeout: this.pageTimeout })
        } catch (e) {
            this.reportError(scope, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
            throw "anizone did not respond — the site is slow or down right now, retry in a moment"
        }
        if (res.status === 429) throw this.fail(scope, this.busy)
        return res
    }

    private readCache<T>(key: string, ttl: number): T | undefined {
        const e = $store.get<{ at: number; data: T } | undefined>(key)
        return e && Date.now() - e.at < ttl ? e.data : undefined
    }

    private writeCache<T>(key: string, data: T): void {
        $store.set(key, { at: Date.now(), data })
    }
}
