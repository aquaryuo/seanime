declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Card = { sid: string; titles: string[]; type: string; year: number; eps: number; locales: string[] }
type Cand = { r: SearchResult; card: Card }
type Target = { t: string; w: number }
type Scored = { c: Cand; s: number; adj: number; ep: number }
type Sub = { origin: string; lang: string; label?: string }
type Source = { m3u8: string; origin: string; subs: Sub[] }

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "https://kaa.lt").replace(/\/+$/, "")
    private cacheTtl = 900000
    private srcCacheTtl = 300000
    private busy = "kickassanime: too many requests right now - wait a minute and retry"
    private subLocales = ["ja-JP", "zh-CN", "ko-KR"]
    private dubLocale = "en-US"

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const sq = this.searchQueries(opts)
        const cands: Cand[] = []
        const seen: { [key: string]: boolean } = {}
        let anyOk = false
        let anyShape = false
        let down = false
        const run = async (queries: string[]): Promise<void> => {
            for (const q of queries) {
                if (!q) continue
                const ck = `kickassanime:q:${q.toLowerCase()}`
                let cards = this.readCache<Card[]>(ck, this.srcCacheTtl)
                if (cards) {
                    anyOk = true
                    anyShape = true
                } else {
                    let res: FetchResponse | null = null
                    try {
                        res = await fetch(`${this.baseUrl}/api/fsearch`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json", Accept: "application/json", Referer: `${this.baseUrl}/` },
                            body: JSON.stringify({ page: 1, query: q }),
                        })
                    } catch (_e) {
                        res = null
                    }
                    if (res && res.status === 429) throw this.fail("search", this.busy)
                    if (!res || res.status >= 500) {
                        down = true
                        return
                    }
                    const body = res && res.ok ? this.json(res) : null
                    if (res && res.ok) anyOk = true
                    cards = this.parseCards(body)
                    if (body && Array.isArray(body.result)) {
                        anyShape = true
                        this.writeCache(ck, cards)
                    }
                }
                this.addCards(cards, opts, seen, cands)
                if (this.pickBest(cands, opts.media, sq.season, sq.part).length === 1) return
            }
        }
        await run(sq.primary)
        if (cands.length === 0 && !down) await run(sq.fallback)
        if (!anyOk || (down && cands.length === 0)) throw this.fail("search", "kickassanime: search failed (site unreachable)")
        if (!anyShape) throw this.fail("search", "kickassanime: search answer not recognized - the site changed its API")
        const picked = this.pickBest(cands, opts.media, sq.season, sq.part)
        const audio = opts.dub ? "dub" : "sub"
        const none = `kickassanime: no ${audio} for this title on kickassanime`
        const out: SearchResult[] = []
        for (const r of picked) {
            const card = this.candOf(cands, r).card
            const lang = this.localeOf(card.locales, audio)
            if (lang) out.push({ id: `${card.sid}$${lang}$${audio}`, title: r.title, url: r.url, subOrDub: r.subOrDub })
        }
        if (out.length === 0 && picked.some((r) => this.candOf(cands, r).card.locales.length > 0)) throw this.fail("search", none, "info")
        if (audio === "dub" && out.length === 1 && !(await this.firstEpisodePlays(out[0].id))) throw this.fail("search", none, "info")
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const parts = id.split("$")
        const show = parts[0] || ""
        const audio = this.audioOf(id)
        const lang = parts.length >= 3 ? parts[1] : audio === "dub" ? this.dubLocale : this.subLocales[0]
        if (!/^[\w-]{1,160}$/.test(show) || !/^[a-z]{2}-[\w]{2,4}$/i.test(lang)) return []
        const cacheKey = `kickassanime:eps:${show}$${lang}$${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.cacheTtl)
        if (cached && cached.length > 0) return cached
        const res = await this.guarded("episodes", this.episodesUrl(show, 1, lang))
        if (res.status === 404) return []
        if (!res.ok) throw this.fail("episodes", `kickassanime: episode list failed (status ${res.status})`)
        const body = this.json(res)
        if (!body || !Array.isArray(body.pages)) throw this.fail("episodes", "kickassanime: episode list not recognized - the site changed its API")
        const known: { [key: number]: { slug: string; title: string } } = {}
        for (const e of Array.isArray(body.result) ? body.result : []) {
            const n = this.epNumber(e && e.episode_number)
            if (n > 0 && typeof e.slug === "string" && /^[\w-]{1,64}$/.test(e.slug)) known[n] = { slug: e.slug, title: typeof e.title === "string" ? e.title : "" }
        }
        const nums: { [key: number]: boolean } = {}
        for (const p of body.pages) for (const v of (p && Array.isArray(p.eps) ? p.eps : [])) {
            const n = this.epNumber(v)
            if (n > 0) nums[n] = true
        }
        const episodes: EpisodeDetails[] = []
        for (const k in nums) {
            const n = parseInt(k, 10)
            const ep = known[n]
            const row: EpisodeDetails = {
                id: `${show}$${n}$${ep ? ep.slug : ""}$${lang}$${audio}`,
                number: n,
                url: ep ? `${this.baseUrl}/${show}/ep-${n}-${ep.slug}` : `${this.baseUrl}/${show}`,
            }
            if (ep && ep.title) row.title = ep.title
            episodes.push(row)
        }
        episodes.sort((a, b) => a.number - b.number)
        if (episodes.length > 0) this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("$")
        const show = parts[0] || ""
        const n = parseInt(parts[1] || "", 10) || episode.number
        const audio = this.audioOf(episode.id)
        const lang = parts[3] || (audio === "dub" ? this.dubLocale : this.subLocales[0])
        if (!/^[\w-]{1,160}$/.test(show) || !/^[\w-]{0,64}$/.test(parts[2] || "") || !/^[a-z]{2}-[\w]{2,4}$/i.test(lang)) throw this.fail("server", "kickassanime: unrecognized episode id - refresh the episode list")
        const cacheKey = `kickassanime:src:${show}:${n}:${lang}`
        let src: Source | undefined | null = this.readCache<Source>(cacheKey, this.srcCacheTtl)
        if (!src || !src.m3u8) {
            const gone = `kickassanime: episode ${n} (${audio}) is not on kickassanime anymore - refresh the episode list`
            let detail = parts[2] ? await this.episodeDetail(show, n, parts[2]) : null
            if (!detail) {
                const slug = await this.slugFor(show, n, lang)
                detail = slug ? await this.episodeDetail(show, n, slug) : null
            }
            if (!detail) {
                try {
                    $store.remove(`kickassanime:eps:${show}$${lang}$${audio}`)
                } catch (_e) {}
                throw this.fail("server", gone)
            }
            const servers = this.streamable(detail.servers)
            if (servers.length === 0) throw this.fail("server", `kickassanime: the site has no ${audio} stream for episode ${n}`, "info")
            const got = await this.playable(servers)
            if (typeof got === "string") throw this.fail("server", `kickassanime: no playable stream for episode ${n} - ${got}`)
            src = got
            this.writeCache(cacheKey, src)
        }
        return {
            server: "Auto",
            headers: { Origin: src.origin, Referer: `${src.origin}/` },
            videoSources: [{ url: src.m3u8, type: "m3u8", quality: "auto", subtitles: this.buildSubs(src.subs) }],
        }
    }

    private cfg(name: string, fallback: string): string {
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
    }

    private episodesUrl(show: string, ep: number, lang: string): string {
        return `${this.baseUrl}/api/show/${show}/episodes?ep=${ep}&lang=${encodeURIComponent(lang)}`
    }

    private async episodeDetail(show: string, n: number, slug: string): Promise<{ servers: any[] } | null> {
        const res = await this.guarded("server", `${this.baseUrl}/api/show/${show}/episode/ep-${n}-${slug}`)
        if (res.status === 404) return null
        if (!res.ok) throw this.fail("server", `kickassanime: episode page failed (status ${res.status})`)
        const body = this.json(res)
        if (!body || !Array.isArray(body.servers)) throw this.fail("server", "kickassanime: episode page not recognized - the site changed its API")
        return { servers: body.servers }
    }

    private async slugFor(show: string, n: number, lang: string): Promise<string> {
        const res = await this.guarded("server", this.episodesUrl(show, n, lang))
        if (!res.ok) return ""
        const body = this.json(res)
        for (const e of body && Array.isArray(body.result) ? body.result : []) {
            if (e && this.epNumber(e.episode_number) === n && typeof e.slug === "string" && /^[\w-]{1,64}$/.test(e.slug)) return e.slug
        }
        return ""
    }

    private async firstEpisodePlays(id: string): Promise<boolean> {
        const first = (await this.findEpisodes(id))[0]
        if (!first) return false
        const parts = first.id.split("$")
        if (!parts[2]) return true
        const detail = await this.episodeDetail(parts[0], first.number, parts[2])
        return !!detail && this.streamable(detail.servers).length > 0
    }

    private streamable(servers: any[]): any[] {
        return servers
            .filter((s) => s && typeof s.src === "string" && /^https:\/\//i.test(s.src) && !/[?&]type=dash\b/i.test(s.src))
            .sort((a, b) => (/vidstream/i.test(b.name || "") ? 1 : 0) - (/vidstream/i.test(a.name || "") ? 1 : 0))
    }

    private async playable(list: any[]): Promise<Source | string> {
        let why = "no player answered"
        for (const s of list.slice(0, 2)) {
            const res = await this.guarded("server", s.src, { headers: { Referer: `${this.baseUrl}/` } })
            if (!res.ok) {
                why = `the player answered ${res.status}, retry in a moment`
                continue
            }
            const p = this.parsePlayer(res.text())
            const origin = (/^https:\/\/[^/?#]+/i.exec(s.src) || [""])[0]
            if (p.m3u8 && origin) return { m3u8: p.m3u8, origin, subs: p.subs }
            why = "the player page was not recognized - the site changed its player; this extension needs an update"
        }
        return why
    }

    private parsePlayer(html: string): { m3u8: string; subs: Sub[] } {
        const empty = { m3u8: "", subs: [] as Sub[] }
        const m = /<astro-island\b[^>]*?\sprops="([^"]*)"/.exec(html || "")
        if (!m) return empty
        let raw: any = null
        try {
            raw = JSON.parse(this.decodeEntities(m[1] || ""))
        } catch (_e) {
            return empty
        }
        const props = this.astro([0, raw])
        if (!props || typeof props !== "object") return empty
        const url = this.fixUrl(props.manifest)
        if (!/^https:\/\/[^/]+\/.*\.m3u8(?:[?#]|$)/i.test(url)) return empty
        const subs: Sub[] = []
        for (const t of Array.isArray(props.subtitles) ? props.subtitles : []) {
            const src = this.fixUrl(t && t.src)
            if (!/^https?:\/\/[^/]/i.test(src)) continue
            subs.push({ origin: src, lang: this.subCode(String(t.language || "")), label: String(t.name || "") })
        }
        return { m3u8: url, subs }
    }

    private fixUrl(v: any): string {
        return (typeof v === "string" ? v.trim() : "").replace(/^\/\/(?=[^/])/, "https://").replace(/^(https?:)\/{3,}/i, "$1//")
    }

    private subCode(lang: string): string {
        const c = (lang || "").toLowerCase() || "en"
        const base = c.split("-")[0]
        const iso2: { [key: string]: string } = {
            eng: "en", ara: "ar", dan: "da", ind: "id", ita: "it", kor: "ko", may: "ms", msa: "ms", nor: "no", nob: "no",
            spa: "es", swe: "sv", tha: "th", ukr: "uk", vie: "vi", fre: "fr", fra: "fr", ger: "de", deu: "de", gre: "el",
            ell: "el", por: "pt", rus: "ru", jpn: "ja", chi: "zh", zho: "zh", tur: "tr", pol: "pl", hin: "hi", tam: "ta",
            fin: "fi", dut: "nl", nld: "nl", heb: "he", cze: "cs", ces: "cs", hun: "hu", rum: "ro", ron: "ro", fil: "tl", per: "fa", fas: "fa",
        }
        return iso2[base] ? iso2[base] + c.slice(base.length) : c
    }

    private astro(v: any): any {
        if (!Array.isArray(v)) return v
        const x = v[1]
        if (v[0] === 1) return Array.isArray(x) ? x.map((i: any) => this.astro(i)) : []
        if (v[0] === 0 && x && typeof x === "object" && !Array.isArray(x)) {
            const o: any = {}
            for (const k in x) o[k] = this.astro(x[k])
            return o
        }
        return x
    }

    private parseCards(body: any): Card[] {
        const out: Card[] = []
        const list = body && Array.isArray(body.result) ? body.result : []
        for (const it of list) {
            if (!it || typeof it !== "object" || typeof it.slug !== "string" || !/^[\w-]{1,160}$/.test(it.slug)) continue
            const titles: string[] = []
            for (const t of [it.title, it.title_en]) {
                const v = typeof t === "string" ? t.trim() : ""
                if (v && titles.indexOf(v) === -1) titles.push(v)
            }
            if (titles.length === 0) continue
            const locales = Array.isArray(it.locales) ? it.locales.filter((l: any) => typeof l === "string") : []
            out.push({ sid: it.slug, titles, type: String(it.type || ""), year: this.toInt(it.year), eps: this.toInt(it.episode_count), locales })
        }
        return out
    }

    private localeOf(locales: string[], audio: string): string {
        if (audio === "dub") return locales.indexOf(this.dubLocale) !== -1 ? this.dubLocale : ""
        for (const l of this.subLocales) if (locales.indexOf(l) !== -1) return l
        return ""
    }

    private candOf(cands: Cand[], r: SearchResult): Cand {
        return cands.filter((c) => c.r === r)[0]
    }

    private addCards(cards: Card[], opts: SearchOptions, seen: { [key: string]: boolean }, out: Cand[]): void {
        const target = opts.media.romajiTitle || opts.media.englishTitle || ""
        for (const c of cards) {
            if (!c.sid || seen["#" + c.sid]) continue
            seen["#" + c.sid] = true
            out.push({ r: { id: c.sid, title: this.bestTitle(c.titles, target), url: `${this.baseUrl}/${c.sid}`, subOrDub: opts.dub ? "dub" : "sub" }, card: c })
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
        if (!f || !t) return false
        return f === "MOVIE" ? t === "tv" : t === "movie"
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

    private bestTitle(titles: string[], target: string): string {
        if (!target) return titles[0]
        try {
            const best = $scannerUtils.findBestMatch(target, titles)
            if (best) return best
        } catch (_e) {}
        return titles[0]
    }

    private epNumber(v: any): number {
        const n = typeof v === "number" ? v : Number(v)
        return Number.isInteger(n) && n > 0 && n <= 100000 ? n : 0
    }

    private toInt(v: any): number {
        const n = typeof v === "number" ? v : parseInt(String(v || "0"), 10)
        return isNaN(n) || n < 0 ? 0 : Math.floor(n)
    }

    private json(res: FetchResponse): any {
        try {
            return res.json()
        } catch (_e) {
            return null
        }
    }

    private decodeEntities(s: string): string {
        const named: { [key: string]: string } = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
        return (s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m: string, e: string) => {
            if (e.charAt(0) !== "#") return named[e.toLowerCase()] || m
            const n = e.charAt(1).toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
            return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
        })
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

    private buildSubs(subs: Sub[]): VideoSubtitle[] {
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
            const nd = this.isNonDialogue(label)
            const score = this.trackScore(label, code.split("-")[0] === "en", false, nd)
            nonDialogue.push(nd)
            if (score > best) {
                best = score
                pick = idx
            }
        }
        if (out.length === 0) return out
        out[pick].isDefault = true
        return [out[pick]].concat(out.filter((_, i) => i !== pick && !nonDialogue[i]), out.filter((_, i) => i !== pick && nonDialogue[i]))
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

    private audioOf(id: string): string {
        const m = (id || "").match(/\$(dub|sub)$/)
        return m ? m[1] : "sub"
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-kickassanime", scope: scope, msg: this.plain(message), lvl: lvl })
            if (lvl) console.warn(line)
            else console.error(line)
        } catch (_e) {}
    }

    private plain(message: string): string {
        return String(message === undefined || message === null ? "" : message)
            .replace(/…/g, "...")
            .replace(/[—–]/g, "-")
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"')
            .replace(/[·•]/g, "-")
            .replace(/\s+/g, " ")
            .replace(/[^\x20-\x7e]/g, "?")
            .replace(/^ +| +$/g, "")
    }

    private fail(scope: string, message: string, lvl?: "warn" | "info"): string {
        this.reportError(scope, message, lvl)
        return message
    }

    private async guarded(scope: string, url: string, opts?: FetchOptions): Promise<FetchResponse> {
        let res: FetchResponse
        try {
            res = await fetch(url, { headers: { Accept: "application/json", Referer: `${this.baseUrl}/` }, ...opts })
        } catch (e) {
            this.reportError(scope, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
            throw "kickassanime: the site did not respond - retry in a moment"
        }
        if (res.status === 429) throw this.fail(scope, this.busy)
        return res
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
