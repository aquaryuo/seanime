declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Card = { sid: string; titles: string[]; type: string; year: number; eps: number }
type Cand = { r: SearchResult; card: Card }
type Target = { t: string; w: number }
type Scored = { c: Cand; s: number; adj: number; ep: number }

class Provider {
    private baseUrl = "{{baseUrl}}"
    private cacheTtl = 900000
    private srcCacheTtl = 300000

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
                if (!q || cands.length >= 12) continue
                let html = ""
                try {
                    const res = await fetch(`${this.normBase()}/anime?search=${encodeURIComponent(q)}`, {
                        headers: this.pageHeaders(),
                        timeout: 12,
                    })
                    if (res.ok) {
                        anyOk = true
                        html = res.text()
                    }
                } catch (_e) {
                    html = ""
                }
                if (html) {
                    if (this.hasCardShape(html)) anyShape = true
                    this.parseCards(html, opts, seen, cands)
                }
            }
        }
        await run(sq.primary)
        if (cands.length === 0) await run(sq.fallback)
        if (!anyOk) throw this.fail("search", "anizone: search failed (site unreachable)")
        if (!anyShape) throw this.fail("search", "anizone: search page layout not recognized")
        return this.pickBest(cands, opts.media, sq.season, sq.part)
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
        const picked = this.disambiguate(plausible, season, part, year)
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
            if (n.length >= 3 && !seen[n]) {
                seen[n] = true
                out.push({ t: n, w })
            }
        }
        for (const t of [media.romajiTitle, media.englishTitle]) {
            if (!t) continue
            push(t, 1)
            // A bare parent-series name is only weak evidence for an "X: Subtitle" media:
            // at full weight "Chainsaw Man" scored 1.0 for the Reze Arc movie.
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

    // The card's own start_year, falling back to a year in the display title for legacy cards.
    private cardYear(c: Cand): number {
        if (c.card.year > 0) return c.card.year
        return this.yearOf(c.r.title)
    }

    // Soft: a wrong year lowers confidence, it never removes a candidate on its own.
    private yearPenalty(cardYear: number, mediaYear: number): number {
        if (cardYear <= 0 || mediaYear <= 0) return 0
        const d = Math.abs(cardYear - mediaYear)
        if (d <= 1) return 0
        if (d === 2) return 0.1
        return 0.35
    }

    // Upstream sends format "TV" when it doesn't know, so "TV" is never evidence of anything.
    private formatConflict(mediaFormat: string, cardType: string): boolean {
        const f = (mediaFormat || "").toUpperCase()
        const t = (cardType || "").toLowerCase()
        if (!f || !t || f === "TV" || f === "TV_SHORT") return false
        const cardMovie = t.indexOf("movie") !== -1
        const cardSeries = t.indexOf("tv series") !== -1
        return f === "MOVIE" ? cardSeries : cardMovie
    }

    private disambiguate(scored: Scored[], season: number, part: number, year: number): Scored[] {
        // An exact start_year match outranks the season marker: anizone labels a sequel
        // "Jujutsu Kaisen (2023)", so a season filter on the title alone would drop it.
        if (year > 0) {
            const ym = scored.filter((x) => this.cardYear(x.c) === year)
            if (ym.length > 0) return this.byPart(ym, part)
        }
        if (season < 2 && part < 2) return this.byPart(scored, part)
        return scored.filter((x) => {
            const seasonOk = season < 2 || this.cardSeason(x.c) === season
            const partOk = part < 2 || this.cardPart(x.c) === part
            return seasonOk && partOk
        })
    }

    private byPart(list: Scored[], part: number): Scored[] {
        if (part < 2) {
            const main = list.filter((x) => this.cardPart(x.c) < 2)
            return main.length > 0 ? main : list
        }
        const pm = list.filter((x) => this.cardPart(x.c) === part)
        return pm.length > 0 ? pm : list
    }

    private cardSeason(c: Cand): number {
        let s = 0
        for (const t of c.card.titles) {
            const v = this.seasonOf(t)
            if (v > s) s = v
        }
        return s
    }

    private cardPart(c: Cand): number {
        let p = 0
        for (const t of c.card.titles) {
            const v = this.partOf(t)
            if (v > p) p = v
        }
        return p
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
        const cacheKey = `anizone:eps:${shortid}${alTag}$${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.cacheTtl)
        if (cached && cached.length > 0) return cached
        const res = await fetch(`${this.normBase()}/anime/${shortid}`, { headers: this.pageHeaders(), timeout: 12 })
        if (res.status === 404) return []
        if (!res.ok) throw this.fail("episodes", `anizone: series page failed (status ${res.status})`)
        const html = res.text()
        const nums: { [key: number]: boolean } = {}
        this.collectEps(html, shortid, nums)
        if (/gotoPage\(\d+\)/.test(html)) {
            try {
                const first = await fetch(`${this.normBase()}/anime/${shortid}?page=1`, { headers: this.pageHeaders(), timeout: 12 })
                if (first && first.ok) this.collectEps(first.text(), shortid, nums)
            } catch (_e) {}
            for (let p = 2; p <= 60; p++) {
                let pr: FetchResponse | undefined
                try {
                    pr = await fetch(`${this.normBase()}/anime/${shortid}?page=${p}`, { headers: this.pageHeaders(), timeout: 12 })
                } catch (_e) {
                    break
                }
                if (!pr || !pr.ok) break
                const before = this.objLen(nums)
                this.collectEps(pr.text(), shortid, nums)
                if (this.objLen(nums) <= before) break
            }
        }
        const episodes: EpisodeDetails[] = []
        for (const k in nums) {
            const n = parseInt(k, 10)
            episodes.push({ id: `${shortid}$${n}${alTag}$${audio}`, number: n, url: `${this.normBase()}/anime/${shortid}/${n}` })
        }
        episodes.sort((a, b) => a.number - b.number)
        if (episodes.length > 0) this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("$")
        const shortid = parts[0]
        const n = parts[1] || String(episode.number)
        const alId = this.alOf(episode.id)
        const audio = this.audioOf(episode.id)
        const cacheKey = `anizone:src:${shortid}:${n}`
        let cached = this.readCache<{ m3u8: string; subs: { origin: string; lang: string; ext: string; label?: string; def?: boolean }[] }>(cacheKey, this.srcCacheTtl)
        if (!cached || !cached.m3u8) {
            const res = await fetch(`${this.normBase()}/anime/${shortid}/${n}`, { headers: this.pageHeaders(), timeout: 14 })
            if (!res.ok) throw this.fail("server", `anizone: episode page failed (status ${res.status})`)
            const html = res.text()
            const player = this.parsePlayer(html)
            const found = player.m3u8 || this.firstMatch(html, /https?:\/\/[^"'\s]+\/master\.m3u8[^"'\s]*/)
            if (!found) throw this.fail("server", "anizone: no stream found for this episode")
            const subs = player.subs.length > 0 ? player.subs : this.extractSubs(html)
            cached = { m3u8: found, subs }
            this.writeCache(cacheKey, cached)
        }
        const m3u8 = cached.m3u8
        if (audio === "dub" && !(await this.hasEnglishAudio(m3u8, shortid, n))) throw this.fail("server", "anizone: no dub available for this episode")
        const subtitles = await this.buildSubs(cached.subs, alId, parseInt(n, 10) || episode.number)
        return {
            server: server === "Auto" || server === "default" || !server ? "Auto" : server,
            headers: { Referer: `${this.normBase()}/` },
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
            if (seen[key]) return
            seen[key] = true
            list.push(q)
        }
        const romaji = opts.media.romajiTitle || ""
        const english = opts.media.englishTitle || ""
        let season = 0
        let part = 0
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
        if (part < 2) {
            for (const s of [opts.query, romaji, english]) {
                const pm = (s || "").match(/\b(?:part|cour)\s*(\d+)\b/i)
                if (pm) {
                    const v = parseInt(pm[1] || "0", 10)
                    if (v > part) part = v
                }
            }
        }
        add(primary, romaji)
        add(primary, english)
        add(fallback, this.firstWords(romaji, 1))
        add(fallback, this.firstWords(english, 2))
        add(fallback, this.firstWords(romaji, 2))
        add(fallback, this.firstWords(english, 3))
        return { primary: primary.slice(0, 3), fallback: fallback.slice(0, 4), season, part }
    }

    private firstWords(title: string, n: number): string {
        const base = (title || "").split(/[:~]/)[0]
        const cleaned = base.replace(/[\[\]【】「」『』(){}"'“”‘’]/g, " ").replace(/\s+/g, " ").trim()
        if (!cleaned) return ""
        return cleaned.split(" ").slice(0, n).join(" ")
    }

    private parseCards(html: string, opts: SearchOptions, seen: { [key: string]: boolean }, out: Cand[]): void {
        const cards = this.parseItems(html).concat(this.parseLegacyCards(html))
        const target = opts.media.romajiTitle || opts.media.englishTitle || ""
        for (const c of cards) {
            if (!c.sid || seen[c.sid]) continue
            seen[c.sid] = true
            const alId = opts.media && opts.media.id > 0 ? opts.media.id : 0
            const audio = opts.dub ? "dub" : "sub"
            out.push({
                r: {
                    id: (alId > 0 ? `${c.sid}$al${alId}` : c.sid) + `$${audio}`,
                    title: this.bestTitle(c.titles, target),
                    url: `${this.normBase()}/anime/${c.sid}`,
                    subOrDub: "both",
                },
                card: c,
            })
        }
    }

    private parsePlayer(html: string): { m3u8: string; subs: { origin: string; lang: string; ext: string; label?: string; def?: boolean; forced?: boolean }[] } {
        const empty = { m3u8: "", subs: [] as { origin: string; lang: string; ext: string; label?: string; def?: boolean; forced?: boolean }[] }
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
        const subs: { origin: string; lang: string; ext: string; label?: string; def?: boolean; forced?: boolean }[] = []
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
                    ext: String(t.format || "ass").toLowerCase(),
                    label: String(t.title || ""),
                    def: t.default === true,
                    forced: forced,
                })
            }
        }
        return { m3u8: src, subs }
    }

    private hasCardShape(html: string): boolean {
        return /items:\s*(?:JSON\.parse\(|\[)/.test(html) || /anmTitles:\s*JSON\.parse\(/.test(html)
    }

    private parseItems(html: string): Card[] {
        const out: Card[] = []
        const m = /items:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(html)
        if (!m) return out
        let list: any = null
        try {
            list = JSON.parse(this.unescapeJs(m[1] || ""))
        } catch (_e) {
            return out
        }
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
                if (v && !seenT[v]) {
                    seenT[v] = true
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

    private parseLegacyCards(html: string): Card[] {
        const out: Card[] = []
        const titleRe = /anmTitles:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/g
        const blocks: { idx: number; titles: string[] }[] = []
        let tm: RegExpExecArray | null
        while ((tm = titleRe.exec(html)) !== null) {
            blocks.push({ idx: tm.index, titles: this.decodeTitles(tm[1] || "") })
        }
        if (blocks.length === 0) return out
        const hrefRe = /href="https?:\/\/[a-z0-9.-]+\/anime\/([a-z0-9]+)"/g
        const hrefs: { idx: number; sid: string }[] = []
        let hm: RegExpExecArray | null
        while ((hm = hrefRe.exec(html)) !== null) {
            hrefs.push({ idx: hm.index, sid: hm[1] })
        }
        for (const b of blocks) {
            let sid = ""
            for (const h of hrefs) {
                if (h.idx > b.idx) {
                    sid = h.sid
                    break
                }
            }
            if (sid) out.push({ sid, titles: b.titles, type: "", year: 0, eps: 0 })
        }
        return out
    }

    private unescapeJs(escaped: string): string {
        return escaped.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m: string, esc: string) => {
            if (esc.charAt(0) === "u") return String.fromCharCode(parseInt(esc.slice(1), 16))
            if (esc === "n") return "\n"
            if (esc === "t") return "\t"
            return esc
        })
    }

    private decodeTitles(escaped: string): string[] {
        const json = this.unescapeJs(escaped)
        const out: string[] = []
        const seen: { [key: string]: boolean } = {}
        const add = (t: string): void => {
            const v = (t || "").trim()
            if (v && !seen[v]) {
                seen[v] = true
                out.push(v)
            }
        }
        try {
            const obj = JSON.parse(json)
            if (obj && typeof obj === "object") {
                for (const k in obj) if (typeof obj[k] === "string") add(obj[k] as string)
            }
        } catch (_e) {}
        if (out.length === 0) {
            const re = /"(?:\\.|[^"\\])*":"((?:\\.|[^"\\])*)"/g
            let m: RegExpExecArray | null
            while ((m = re.exec(json)) !== null) add((m[1] || "").replace(/\\(.)/g, "$1"))
        }
        return out
    }

    private bestTitle(titles: string[], target: string): string {
        if (titles.length === 0) return target
        if (!target) return titles[0]
        try {
            const best = $scannerUtils.findBestMatch(target, titles)
            if (best) return best
        } catch (_e) {}
        return titles[0]
    }

    private tagAttr(tag: string, name: string): string {
        const pats = [
            new RegExp("(?:^|\\s)" + name + '\\s*=\\s*"([^"]*)"', "i"),
            new RegExp("(?:^|\\s)" + name + "\\s*=\\s*'([^']*)'", "i"),
            new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([^\\s>]+)", "i"),
        ]
        for (const re of pats) {
            const m = re.exec(tag)
            if (m) return m[1] || ""
        }
        return ""
    }

    private decodeEntities(s: string): string {
        return (s || "")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#0?39;|&apos;/gi, "'")
            .replace(/&nbsp;/gi, " ")
            .trim()
    }

    private extractSubs(html: string): { origin: string; lang: string; ext: string; label: string; def: boolean }[] {
        const out: { origin: string; lang: string; ext: string; label: string; def: boolean }[] = []
        const seen: { [key: string]: boolean } = {}
        const tagRe = /<track\b[^>]*>/gi
        let t: RegExpExecArray | null
        while ((t = tagRe.exec(html)) !== null) {
            const tag = t[0]
            const src = this.tagAttr(tag, "src")
            if (!/^https?:\/\//i.test(src) || src.indexOf("/subtitles/") === -1) continue
            const kind = this.tagAttr(tag, "kind").toLowerCase()
            if (kind && kind !== "subtitles" && kind !== "captions") continue
            if (seen[src]) continue
            seen[src] = true
            const fromUrl = src.match(/\/subtitles\/[0-9]+_([A-Za-z0-9-]+)\.(ass|srt|vtt)/i)
            const lang = this.tagAttr(tag, "srclang") || (fromUrl ? fromUrl[1] : "") || "en"
            const ext = (this.tagAttr(tag, "data-type") || (fromUrl ? fromUrl[2] : "") || "ass").toLowerCase()
            out.push({ origin: src, lang, ext, label: this.decodeEntities(this.tagAttr(tag, "label")), def: /(?:^|\s)default(?:[\s/>=])/i.test(tag) })
        }
        if (out.length > 0) return out
        const re = /https?:\/\/[^"'\s]+\/subtitles\/[0-9]+_([A-Za-z0-9-]+)\.(ass|srt)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            if (seen[m[0]]) continue
            seen[m[0]] = true
            out.push({ origin: m[0], lang: m[1] || "en", ext: m[2] || "ass", label: "", def: false })
        }
        return out
    }

    private isNonDialogue(label: string): boolean {
        const l = label || ""
        if (/\b(?:full|dialogu?e|dialog|main|complete)\b/i.test(l)) return false
        return /\b(?:forced|forc[eé]s|signs?|songs?|karaoke|kfx|typeset(?:ting)?|commentary)\b/i.test(l) || /\bs\s*[&+\/]\s*s\b/i.test(l) || /\bop\s*[\/&+]\s*ed\b/i.test(l)
    }

    private isMachine(label: string): boolean {
        return /\b(?:ai|mtl)\b/i.test(label || "")
    }

    private isAltDialogue(label: string): boolean {
        return /\b(?:sdh|cc|closed[\s-]?captions?|hearing[\s-]?impaired|dub[\s-]?titles?)\b/i.test(label || "")
    }

    private trackScore(label: string, isEnglish: boolean, def: boolean, nonDialogue?: boolean): number {
        const nd = nonDialogue === undefined ? this.isNonDialogue(label) : nonDialogue
        const base = nd ? (isEnglish ? 3 : 0) : this.isMachine(label) ? (isEnglish ? 4 : 1) : this.isAltDialogue(label) ? (isEnglish ? 5 : 1) : isEnglish ? 6 : 2
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

    private async buildSubs(subs: { origin: string; lang: string; ext: string; label?: string; def?: boolean; forced?: boolean }[], anilistId: number, episode: number): Promise<VideoSubtitle[]> {
        const out: VideoSubtitle[] = []
        const nonDialogue: boolean[] = []
        const seen: { [key: string]: boolean } = {}
        let pick = 0
        let best = -1
        for (const s of subs) {
            const origin = s.origin
            if (!origin || seen[origin]) continue
            seen[origin] = true
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
        const head: VideoSubtitle[] = []
        const tail: VideoSubtitle[] = []
        for (let i = 0; i < out.length; i++) {
            if (i === pick) continue
            if (nonDialogue[i]) tail.push(out[i])
            else head.push(out[i])
        }
        return [out[pick]].concat(head).concat(tail)
    }

    private alOf(id: string): number {
        const m = (id || "").match(/\$al(\d+)/)
        return m ? parseInt(m[1] || "0", 10) : 0
    }

    private audioOf(id: string): string {
        const m = (id || "").match(/\$(dub|sub)$/)
        return m ? m[1] : "sub"
    }

    private async hasEnglishAudio(m3u8: string, shortid: string, n: string): Promise<boolean> {
        const key = `anizone:dub:${shortid}:${n}`
        const cached = this.readCache<boolean>(key, this.srcCacheTtl)
        if (cached !== undefined) return cached
        let ok = false
        try {
            const res = await fetch(m3u8, { headers: this.pageHeaders(), timeout: 8 })
            if (res.ok) {
                const body = res.text()
                ok = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*LANGUAGE="(?:en|eng|en-[a-z]+)"/i.test(body) || /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*(?:english|\bdub\b)/i.test(body)
            }
        } catch (_e) {}
        this.writeCache(key, ok)
        return ok
    }

    private langName(code: string): string {
        const map: { [key: string]: string } = {
            en: "English", ja: "Japanese", ar: "Arabic", de: "German", es: "Spanish", fr: "French",
            it: "Italian", ru: "Russian", pt: "Portuguese", hi: "Hindi", ta: "Tamil", id: "Indonesian",
            ko: "Korean", zh: "Chinese", th: "Thai", vi: "Vietnamese", tr: "Turkish", pl: "Polish", nl: "Dutch",
            my: "Malay", tl: "Tagalog",
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
        const re = new RegExp(`/anime/${shortid}/(\\d+)`, "g")
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const n = parseInt(m[1] || "0", 10)
            if (n > 0) nums[n] = true
        }
    }

    private objLen(o: { [key: number]: boolean }): number {
        let c = 0
        for (const _k in o) c++
        return c
    }

    private firstMatch(html: string, re: RegExp): string {
        const m = html.match(re)
        return m ? m[0] : ""
    }

    private normBase(): string {
        return this.baseUrl.replace(/\/+$/, "")
    }

    private pageHeaders(): { [key: string]: string } {
        return { Referer: `${this.normBase()}/` }
    }

    private reportError(scope: string, message: string): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: this.now(), ext: "aq-anizone-beta", scope: scope, msg: String(message) }))
        } catch (_e) {}
    }

    private fail(scope: string, message: string): string {
        this.reportError(scope, message)
        return message
    }

    private now(): number {
        try {
            return Date.now()
        } catch (_e) {
            return 0
        }
    }

    private readCache<T>(key: string, ttl?: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        const t = this.now()
        const max = ttl === undefined ? this.cacheTtl : ttl
        if (entry && t > 0 && entry.at > 0 && t - entry.at < max) return entry.data
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        const t = this.now()
        if (t > 0) $store.set(key, { at: t, data })
    }
}
