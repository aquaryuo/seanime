declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Card = { sid: string; titles: string[]; type: string; year: number; eps: number }
type Cand = { r: SearchResult; card: Card }
type Target = { t: string; w: number }
type Scored = { c: Cand; s: number; adj: number; ep: number }

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "https://anizone.to").replace(/\/+$/, "")
    private cacheTtl = 900000
    private srcCacheTtl = 300000
    private pageBudget = 10000
    private probeBudget = 20000

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const sq = this.searchQueries(opts)
        const cands: Cand[] = []
        const seen: { [key: string]: boolean } = {}
        let anyOk = false
        let anyShape = false
        const run = async (queries: string[]): Promise<void> => {
            for (const q of queries) {
                if (cands.length >= 12) break
                if (!q) continue
                const ck = `anizone:q:${q.toLowerCase()}`
                let cards = this.readCache<Card[]>(ck, this.srcCacheTtl)
                if (cards) {
                    anyOk = true
                    anyShape = true
                } else {
                    let html = ""
                    try {
                        const res = await fetch(`${this.baseUrl}/anime?search=${encodeURIComponent(q)}`, {
                            headers: this.pageHeaders(),
                        })
                        if (res.ok) {
                            anyOk = true
                            html = res.text()
                        }
                    } catch (_e) {
                        html = ""
                    }
                    cards = this.parseItems(html)
                    if (/items:\s*(?:JSON\.parse\(|\[)/.test(html)) {
                        anyShape = true
                        this.writeCache(ck, cards)
                    }
                }
                this.addCards(cards, opts, seen, cands)
            }
        }
        await run(sq.primary)
        if (cands.length === 0) await run(sq.fallback)
        if (!anyOk) throw this.fail("search", "anizone: search failed (site unreachable)")
        if (!anyShape) throw this.fail("search", "anizone: search page layout not recognized")
        return this.pickBest(cands, opts.media, sq.season, sq.part)
    }

    private cfg(name: string, fallback: string): string {
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
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
        const seen: { [key: string]: boolean } = {}
        const push = (s: string, w: number): void => {
            const n = this.normTitle(s)
            if (n.length >= 3 && !seen["#" + n]) {
                seen["#" + n] = true
                out.push({ t: n, w })
            }
        }
        for (const t of [media.romajiTitle, media.englishTitle]) {
            if (!t) continue
            push(t, 1)
            push(t.split(/[:,;~]/)[0], 0.8)
            try {
                const nz = $scannerUtils.normalizeTitle(t)
                if (nz) {
                    push(nz.cleanBaseTitle, 1)
                    push(nz.denoisedTitle, 1)
                }
            } catch (_e) {}
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
            const seasonOk = season < 2 || this.cardMax(x.c, (t) => this.seasonOf(t)) === season
            const partOk = part < 2 || this.cardMax(x.c, (t) => this.partOf(t)) === part
            return seasonOk && partOk
        })
    }

    private byPart(list: Scored[], part: number): Scored[] {
        if (part < 2) {
            const main = list.filter((x) => this.cardMax(x.c, (t) => this.partOf(t)) < 2)
            return main.length > 0 ? main : list
        }
        const pm = list.filter((x) => this.cardMax(x.c, (t) => this.partOf(t)) === part)
        return pm.length > 0 ? pm : list
    }

    private cardMax(c: Cand, f: (t: string) => number): number {
        return Math.max(0, ...c.card.titles.map(f))
    }

    private yearOf(title: string): number {
        const m = (title || "").match(/\((\d{4})\b/)
        return m ? parseInt(m[1] || "0", 10) : 0
    }

    private seasonOf(title: string): number {
        try {
            const n = $scannerUtils.normalizeTitle(title)
            if (n && n.season) return n.season
        } catch (_e) {}
        return 0
    }

    private partOf(title: string): number {
        let p = 0
        try {
            const n = $scannerUtils.normalizeTitle(title)
            if (n && n.part) p = n.part
        } catch (_e) {}
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
        const alId = this.alOf(id)
        const alTag = alId > 0 ? `$al${alId}` : ""
        const audio = this.audioOf(id)
        const cacheKey = this.epsKey(id)
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.cacheTtl)
        if (cached && cached.length > 0) return cached
        const res = await this.guarded("episodes", `${this.baseUrl}/anime/${shortid}`, { headers: this.pageHeaders() })
        if (res.status === 404) return []
        if (!res.ok) throw this.fail("episodes", `anizone: series page failed (status ${res.status})`)
        const html = res.text()
        const nums: { [key: number]: boolean } = {}
        this.collectEps(html, shortid, nums)
        this.addItemEps(this.itemsJson(html), nums)
        let sure = true
        if (await this.walkPages(res, html, shortid, nums)) {
            const top = this.topOf(nums)
            const trim = await this.trimToExisting(shortid, this.statedEpisodeCount(html), top)
            sure = trim.sure
            for (let n = /sort&quot;:&quot;[a-z]+-desc/.test(html) ? 1 : top + 1; n <= trim.last; n++) nums[n] = true
        }
        const episodes: EpisodeDetails[] = []
        for (const k in nums) {
            const n = parseInt(k, 10)
            episodes.push({ id: `${shortid}$${n}${alTag}$${audio}`, number: n, url: `${this.baseUrl}/anime/${shortid}/${n}` })
        }
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
        let cached = this.readCache<{ m3u8: string; subs: { origin: string; lang: string; label?: string; def?: boolean }[] }>(cacheKey, this.srcCacheTtl)
        if (!cached || !cached.m3u8) {
            const res = await this.guarded("server", `${this.baseUrl}/anime/${shortid}/${n}`, { headers: this.pageHeaders() })
            if (res.status === 404) {
                try {
                    $store.remove(this.epsKey(episode.id))
                } catch (_e) {}
                throw this.fail("server", `anizone: episode ${n} is not on anizone yet - refresh the episode list`)
            }
            if (!res.ok) throw this.fail("server", `anizone: episode page failed (status ${res.status})`)
            const html = res.text()
            const player = this.parsePlayer(html)
            const found = player.m3u8
            if (!found) throw this.fail("server", "anizone: no stream found for this episode")
            const subs = player.subs
            cached = { m3u8: found, subs }
            this.writeCache(cacheKey, cached)
        }
        const m3u8 = cached.m3u8
        if (audio === "dub") {
            const dub = await this.hasEnglishAudio(m3u8, shortid, n)
            if (dub === undefined) throw this.fail("server", "anizone: could not check the dub audio track - retry")
            if (!dub) throw this.fail("server", "anizone: no dub available for this episode", "info")
        }
        const subtitles = this.buildSubs(cached.subs)
        return {
            server: "Auto",
            headers: this.pageHeaders(),
            videoSources: [
                {
                    url: m3u8,
                    type: "m3u8",
                    quality: "auto",
                    subtitles,
                },
            ],
        }
    }

    private searchQueries(opts: SearchOptions): { primary: string[]; fallback: string[]; season: number; part: number } {
        const primary: string[] = []
        const fallback: string[] = []
        const seen: { [key: string]: boolean } = {}
        const add = (list: string[], s: string): void => {
            const q = (s || "").trim()
            if (!q) return
            const key = q.toLowerCase()
            if (seen["#" + key]) return
            seen["#" + key] = true
            list.push(q)
        }
        const romaji = opts.media.romajiTitle || ""
        const english = opts.media.englishTitle || ""
        let season = 0
        let part = 0
        if (!romaji && !english) add(primary, opts.query || "")
        for (const s of [romaji, english]) {
            add(primary, s)
            add(primary, s.replace(/\s*\b(?:\d+(?:st|nd|rd|th)\s+season|season\s*\d+|part\s*\d+|cour\s*\d+)\b.*$/i, ""))
        }
        try {
            const seed: string[] = []
            if (opts.query) seed.push(opts.query)
            if (romaji) seed.push(romaji)
            if (english) seed.push(english)
            const smart = $scannerUtils.buildSmartSearchTitles(seed)
            if (smart) {
                season = smart.season || 0
                part = smart.part || 0
                if (smart.titles) for (const t of smart.titles) add(primary, t)
            }
        } catch (_e) {}
        if (part < 2) for (const s of [opts.query, romaji, english]) {
            const pm = (s || "").match(/\b(?:part|cour)\s*(\d+)\b/i)
            if (pm) part = Math.max(part, parseInt(pm[1], 10))
        }
        add(fallback, this.firstWords(romaji, 1))
        add(fallback, this.firstWords(english, 2))
        add(fallback, this.firstWords(romaji, 2))
        add(fallback, this.firstWords(english, 3))
        return { primary: primary.slice(0, 4), fallback: fallback.slice(0, 4), season, part }
    }

    private firstWords(title: string, n: number): string {
        const base = (title || "").split(/[:~]/)[0]
        const cleaned = base.replace(/[\[\]【】「」『』(){}"'“”‘’]/g, " ").replace(/\s+/g, " ").trim()
        if (!cleaned) return ""
        return cleaned.split(" ").slice(0, n).join(" ")
    }

    private addCards(cards: Card[], opts: SearchOptions, seen: { [key: string]: boolean }, out: Cand[]): void {
        const target = opts.media.romajiTitle || opts.media.englishTitle || ""
        for (const c of cards) {
            if (!c.sid || seen["#" + c.sid]) continue
            seen["#" + c.sid] = true
            const alId = opts.media && opts.media.id > 0 ? opts.media.id : 0
            const audio = opts.dub ? "dub" : "sub"
            out.push({
                r: {
                    id: (alId > 0 ? `${c.sid}$al${alId}` : c.sid) + `$${audio}`,
                    title: this.bestTitle(c.titles, target),
                    url: `${this.baseUrl}/anime/${c.sid}`,
                    subOrDub: "both",
                },
                card: c,
            })
        }
    }

    private parsePlayer(html: string): { m3u8: string; subs: { origin: string; lang: string; label?: string; def?: boolean; forced?: boolean }[] } {
        const empty = { m3u8: "", subs: [] as { origin: string; lang: string; label?: string; def?: boolean; forced?: boolean }[] }
        const m = /vidstackPlayer\(JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html)
        if (!m) return empty
        let cfg: any = null
        try {
            cfg = JSON.parse(this.unescapeJs(this.decodeEntities(m[1] || "")))
        } catch (_e) {
            return empty
        }
        if (!cfg || typeof cfg !== "object") return empty
        const src = typeof cfg.src === "string" ? cfg.src : ""
        const subs: { origin: string; lang: string; label?: string; def?: boolean; forced?: boolean }[] = []
        const list = cfg.subtitles
        if (list && typeof list.length === "number") {
            for (let i = 0; i < list.length; i++) {
                const t = list[i]
                if (!t || typeof t !== "object") continue
                const file = typeof t.file === "string" ? t.file : ""
                if (!/^https?:\/\//i.test(file)) continue
                const forced = t.forced === true || String(t.forced || "").toLowerCase() === "yes"
                subs.push({
                    origin: file,
                    lang: String(t.language || "en").toLowerCase(),
                    label: String(t.title || ""),
                    def: t.default === true,
                    forced: forced,
                })
            }
        }
        return { m3u8: src, subs }
    }

    private async walkPages(page: FetchResponse, html: string, shortid: string, nums: { [key: number]: boolean }): Promise<boolean> {
        let more = !/hasMore:\s*false/.test(html) || Object.keys(nums).length === 0
        if (Object.keys(nums).length === this.topOf(nums)) return more
        const cm = /nextCursor:\s*'([^']+)'/.exec(html)
        let cursor = cm ? cm[1] : ""
        const tm = /data-csrf="([^"]+)"/.exec(html)
        const csrf = tm ? tm[1] : ""
        let snapshot = ""
        const re = /wire:snapshot="([^"]*)"/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const s = this.decodeEntities(m[1] || "")
            if (s.indexOf(`"slug":"${shortid}"`) !== -1) snapshot = s
        }
        const jar = page.cookies || {}
        const cookie = Object.keys(jar).map((k) => `${k}=${jar[k]}`).join("; ")
        const deadline = Date.now() + this.pageBudget
        while (more && cursor && csrf && snapshot && Date.now() < deadline) {
            let comp: any = null
            try {
                const res = await fetch(`${this.baseUrl}/livewire/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Livewire": "", Cookie: cookie, Referer: `${this.baseUrl}/anime/${shortid}`, Origin: this.baseUrl },
                    body: JSON.stringify({ _token: csrf, components: [{ snapshot, updates: {}, calls: [{ path: "", method: "loadPage", params: [cursor] }] }] }),
                })
                if (!res.ok) break
                comp = res.json().components[0]
            } catch (_e) {
                break
            }
            const loaded = ((comp && comp.effects && comp.effects.dispatches) || []).filter((d: any) => d && d.name === "items-loaded")[0]
            if (!loaded || !loaded.params || typeof comp.snapshot !== "string") break
            snapshot = comp.snapshot
            this.addItemEps(loaded.params.items, nums)
            cursor = loaded.params.nextCursor || ""
            more = loaded.params.hasMore !== false
        }
        return more
    }

    private async trimToExisting(shortid: string, stated: number, known: number): Promise<{ last: number; sure: boolean }> {
        if (stated <= known) return { last: known, sure: true }
        const deadline = Date.now() + this.probeBudget
        let lo = known
        let hi = stated + 1
        for (let i = 0; hi - lo > 1; i++) {
            if (Date.now() > deadline) break
            const n = i < 8 ? hi - 1 : Math.floor((lo + hi) / 2)
            let status = 0
            try {
                status = (await fetch(`${this.baseUrl}/anime/${shortid}/${n}`, { headers: this.pageHeaders() })).status
            } catch (_e) {
                break
            }
            if (status === 200 && i < 8) return { last: n, sure: true }
            if (status === 200) lo = n
            else if (status === 404) hi = n
            else break
        }
        return { last: hi - 1, sure: hi - lo <= 1 }
    }

    private statedEpisodeCount(html: string): number {
        const m = /(\d+)\s+Episodes?</i.exec(html || "")
        if (!m) return 0
        const n = parseInt(m[1] || "0", 10)
        return n > 0 && n <= 10000 ? n : 0
    }

    private itemsJson(html: string): any {
        const m = /items:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html)
        if (!m) return null
        try {
            return JSON.parse(this.unescapeJs(m[1] || ""))
        } catch (_e) {
            return null
        }
    }

    private addItemEps(list: any, nums: { [key: number]: boolean }): void {
        if (!list || typeof list.length !== "number") return
        for (let i = 0; i < list.length; i++) {
            const it = list[i]
            if (!it) continue
            const n = parseInt(String(it.slug || ""), 10)
            if (!isNaN(n) && n > 0) nums[n] = true
        }
    }

    private parseItems(html: string): Card[] {
        const out: Card[] = []
        const list = this.itemsJson(html)
        if (!list || typeof list.length !== "number") return out
        for (let i = 0; i < list.length; i++) {
            const it = list[i]
            if (!it || typeof it !== "object") continue
            const sid = String(it.slug || "")
            if (!sid) continue
            const titles: string[] = []
            const seenT: { [key: string]: boolean } = {}
            const add = (t: any): void => {
                const v = typeof t === "string" ? t.trim() : ""
                if (v && !seenT["#" + v]) {
                    seenT["#" + v] = true
                    titles.push(v)
                }
            }
            add(it.main_title)
            const tl = it.title_list
            if (tl && typeof tl === "object") for (const k in tl) add(tl[k])
            if (titles.length === 0) continue
            out.push({ sid, titles, type: String(it.type || ""), year: this.toInt(it.start_year), eps: this.toInt(it.episode_count) })
        }
        return out
    }

    private toInt(v: any): number {
        const n = typeof v === "number" ? v : parseInt(String(v || "0"), 10)
        return isNaN(n) || n < 0 ? 0 : Math.floor(n)
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
            .replace(/&#0?39;|&apos;/gi, "'")
            .replace(/&nbsp;/gi, " ")
            .replace(/&#x([0-9a-f]+);/gi, (m, h) => this.codePoint(parseInt(h, 16), m))
            .replace(/&#(\d+);/g, (m, d) => this.codePoint(parseInt(d, 10), m))
            .trim()
    }

    private codePoint(n: number, raw: string): string {
        if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return raw
        try {
            return String.fromCodePoint(n)
        } catch (_e) {
            return raw
        }
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
        const c = (code || "en").toLowerCase()
        const name = this.langName(c)
        if (!label) return name
        if (!/[a-z]/.test(name)) return label
        const base = this.langName(c.split("-")[0])
        if (label.toLowerCase().indexOf(base.toLowerCase()) !== -1) return label
        return `${name} - ${label}`
    }

    private buildSubs(subs: { origin: string; lang: string; label?: string; def?: boolean; forced?: boolean }[]): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const nonDialogue: boolean[] = []
        const seen: { [key: string]: boolean } = {}
        let pick = 0
        let best = -1
        for (const s of subs) {
            const origin = s.origin
            if (!origin || seen["#" + origin]) continue
            seen["#" + origin] = true
            const code = (s.lang || "en").toLowerCase()
            const label = (s.label || "").trim()
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

    private alOf(id: string): number {
        const m = (id || "").match(/\$al(\d+)/)
        return m ? parseInt(m[1] || "0", 10) : 0
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
            const res = await fetch(m3u8, { headers: this.pageHeaders() })
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

    private collectEps(html: string, shortid: string, nums: { [key: number]: boolean }): void {
        if (!/^[\w-]{1,64}$/.test(shortid)) return
        const re = new RegExp(`/anime/${shortid}/(\\d+)`, "g")
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const n = parseInt(m[1] || "0", 10)
            if (n > 0) nums[n] = true
        }
    }

    private topOf(o: { [key: number]: boolean }): number {
        return Math.max(0, ...Object.keys(o).map(Number))
    }

    private epsKey(id: string): string {
        const al = this.alOf(id)
        return `anizone:eps:${this.shortId(id)}${al > 0 ? `$al${al}` : ""}$${this.audioOf(id)}`
    }

    private pageHeaders(): { [key: string]: string } {
        return { Referer: `${this.baseUrl}/` }
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-anizone", scope: scope, msg: this.plain(message), lvl: lvl }))
        } catch (_e) {}
    }

    private plain(message: string): string {
        return String(message === undefined || message === null ? "" : message)
            .replace(/\u2026/g, "...")
            .replace(/[\u2014\u2013]/g, "-")
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u00b7\u2022]/g, "-")
            .replace(/\s+/g, " ")
            .replace(/[^\x20-\x7e]/g, "?")
            .replace(/^ +| +$/g, "")
    }

    private fail(scope: string, message: string, lvl?: "warn" | "info"): string {
        this.reportError(scope, message, lvl)
        return message
    }

    private async guarded(scope: string, url: string, opts?: FetchOptions): Promise<FetchResponse> {
        try {
            return await fetch(url, opts)
        } catch (e) {
            this.reportError(scope, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
            throw "anizone could not be reached — check your connection or retry in a moment"
        }
    }

    private readCache<T>(key: string, ttl: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        if (entry && entry.at > 0 && Date.now() - entry.at < ttl) return entry.data
        if (entry !== undefined && entry !== null) {
            try {
                $store.remove(key)
            } catch (_e) {}
        }
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        $store.set(key, { at: Date.now(), data })
    }
}
