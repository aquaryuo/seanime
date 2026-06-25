class Provider {
    private baseUrl = "{{baseUrl}}"
    private subtitleSource = "{{subtitleSource}}"
    private subEndpoint = "https://sub.ryuo.to"
    private cacheTtl = 900000
    private srcCacheTtl = 300000

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const sq = this.searchQueries(opts)
        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}
        let anyOk = false
        const run = async (queries: string[]): Promise<void> => {
            for (const q of queries) {
                if (!q || results.length >= 12) continue
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
                if (html) this.parseCards(html, opts, seen, results)
            }
        }
        await run(sq.primary)
        if (results.length === 0) await run(sq.fallback)
        if (!anyOk) throw "anizone: search failed (site unreachable)"
        return this.pickBest(results, opts.media, sq.season, sq.part)
    }

    private pickBest(results: SearchResult[], media: Media, season: number, part: number): SearchResult[] {
        if (results.length === 0) return []
        const targets = this.matchTargets(media)
        if (targets.length === 0) return results
        const scored = results.map((r) => ({ r, s: this.scoreTitle(r.title, targets) })).sort((a, b) => b.s - a.s)
        const plausible = scored.filter((x) => x.s >= 0.5)
        if (plausible.length === 0) return []
        const seasoned = this.filterBySeason(plausible, season, part)
        if (seasoned[0].s >= 0.85 && (seasoned.length === 1 || seasoned[0].s - seasoned[1].s >= 0.12)) {
            return [seasoned[0].r]
        }
        return seasoned.map((x) => x.r)
    }

    private matchTargets(media: Media): string[] {
        const out: string[] = []
        const seen: { [key: string]: boolean } = {}
        const push = (s: string): void => {
            const n = this.normTitle(s)
            if (n.length >= 3 && !seen[n]) {
                seen[n] = true
                out.push(n)
            }
        }
        for (const t of [media.romajiTitle, media.englishTitle]) {
            if (!t) continue
            push(t)
            push(t.split(/[:,;~]/)[0])
            try {
                const nz = $scannerUtils.normalizeTitle(t)
                if (nz) {
                    push(nz.cleanBaseTitle)
                    push(nz.denoisedTitle)
                }
            } catch (_e) {}
        }
        if (media.synonyms) for (const s of media.synonyms) push(s)
        return out
    }

    private scoreTitle(title: string, targets: string[]): number {
        const c = this.normTitle(title)
        if (!c) return 0
        let best = 0
        for (const t of targets) {
            const v = this.simNorm(c, t)
            if (v > best) best = v
        }
        return best
    }

    private filterBySeason(scored: { r: SearchResult; s: number }[], season: number, part: number): { r: SearchResult; s: number }[] {
        if (season < 2 && part < 2) return scored
        const matched = scored.filter((x) => {
            let rs = -1
            let rp = -1
            try {
                const n = $scannerUtils.normalizeTitle(x.r.title)
                if (n) {
                    rs = n.season
                    rp = n.part
                }
            } catch (_e) {}
            const seasonOk = season < 2 || rs === season
            const partOk = part < 2 || rp === part
            return seasonOk && partOk
        })
        return matched.length > 0 ? matched : scored
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
        const cacheKey = `anizone:eps:${shortid}${alTag}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.cacheTtl)
        if (cached && cached.length > 0) return cached
        const res = await fetch(`${this.normBase()}/anime/${shortid}`, { headers: this.pageHeaders(), timeout: 12 })
        if (res.status === 404) return []
        if (!res.ok) throw `anizone: series page failed (status ${res.status})`
        const html = res.text()
        const re = new RegExp(`/anime/${shortid}/(\\d+)`, "g")
        const nums: { [key: number]: boolean } = {}
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const n = parseInt(m[1] || "0", 10)
            if (n > 0) nums[n] = true
        }
        const episodes: EpisodeDetails[] = []
        for (const k in nums) {
            const n = parseInt(k, 10)
            episodes.push({ id: `${shortid}$${n}${alTag}`, number: n, url: `${this.normBase()}/anime/${shortid}/${n}` })
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
        const cacheKey = `anizone:src:${shortid}:${n}`
        let html = this.readCache<string>(cacheKey, this.srcCacheTtl)
        if (!html) {
            const res = await fetch(`${this.normBase()}/anime/${shortid}/${n}`, { headers: this.pageHeaders(), timeout: 14 })
            if (!res.ok) throw `anizone: episode page failed (status ${res.status})`
            html = res.text()
            if (html.indexOf("master.m3u8") !== -1) this.writeCache(cacheKey, html)
        }
        const m3u8 = this.firstMatch(html, /https?:\/\/[^"'\s]+\/master\.m3u8/)
        if (!m3u8) throw "anizone: no stream found for this episode"
        const subtitles = this.buildSubs(html, alId, parseInt(n, 10) || episode.number)
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

    private parseCards(html: string, opts: SearchOptions, seen: { [key: string]: boolean }, results: SearchResult[]): void {
        const titleRe = /anmTitles:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/g
        const blocks: { idx: number; titles: string[] }[] = []
        let tm: RegExpExecArray | null
        while ((tm = titleRe.exec(html)) !== null) {
            blocks.push({ idx: tm.index, titles: this.decodeTitles(tm[1] || "") })
        }
        const hrefRe = /href="https?:\/\/[a-z0-9.-]+\/anime\/([a-z0-9]+)"/g
        const hrefs: { idx: number; sid: string }[] = []
        let hm: RegExpExecArray | null
        while ((hm = hrefRe.exec(html)) !== null) {
            hrefs.push({ idx: hm.index, sid: hm[1] })
        }
        const target = opts.media.romajiTitle || opts.media.englishTitle || ""
        for (const b of blocks) {
            let sid = ""
            for (const h of hrefs) {
                if (h.idx > b.idx) {
                    sid = h.sid
                    break
                }
            }
            if (!sid || seen[sid]) continue
            seen[sid] = true
            const alId = opts.media && opts.media.id > 0 ? opts.media.id : 0
            results.push({
                id: alId > 0 ? `${sid}$al${alId}` : sid,
                title: this.bestTitle(b.titles, target),
                url: `${this.normBase()}/anime/${sid}`,
                subOrDub: "sub",
            })
        }
    }

    private decodeTitles(escaped: string): string[] {
        const json = escaped.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m: string, esc: string) => {
            if (esc.charAt(0) === "u") return String.fromCharCode(parseInt(esc.slice(1), 16))
            if (esc === "n") return "\n"
            if (esc === "t") return "\t"
            return esc
        })
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

    private buildSubs(html: string, anilistId: number, episode: number): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const re = /https?:\/\/[^"'\s]+\/subtitles\/[0-9]+_([a-z-]+)\.(ass|srt)/g
        const viaSite = this.subtitleSource === "subryuo" && anilistId > 0 && episode > 0
        const seen: { [key: string]: boolean } = {}
        let englishIdx = -1
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const origin = m[0]
            const lang = (m[1] || "en").toLowerCase().split("-")[0]
            const ext = (m[2] || "ass").toLowerCase()
            if (seen[lang]) continue
            seen[lang] = true
            const idx = out.length
            const url = viaSite ? this.siteSubUrl(anilistId, episode, lang, ext, origin) : origin
            out.push({ id: `${lang}-${idx}`, url, language: this.langName(lang), isDefault: false })
            if (englishIdx === -1 && lang === "en") englishIdx = idx
        }
        if (out.length === 0) return out
        const pick = englishIdx !== -1 ? englishIdx : 0
        out[pick].isDefault = true
        return out.filter((s) => s.isDefault).concat(out.filter((s) => !s.isDefault))
    }

    private siteSubUrl(anilistId: number, episode: number, lang: string, ext: string, origin: string): string {
        const ref = encodeURIComponent(`${this.normBase()}/`)
        return `${this.subEndpoint}/s/${anilistId}/${episode}/${lang}.${ext}?source=anizone&src=${encodeURIComponent(origin)}&ref=${ref}`
    }

    private alOf(id: string): number {
        const m = (id || "").match(/\$al(\d+)/)
        return m ? parseInt(m[1] || "0", 10) : 0
    }

    private langName(code: string): string {
        const map: { [key: string]: string } = {
            en: "English", ja: "Japanese", ar: "Arabic", de: "German", es: "Spanish", fr: "French",
            it: "Italian", ru: "Russian", pt: "Portuguese", hi: "Hindi", ta: "Tamil", id: "Indonesian",
            ko: "Korean", zh: "Chinese", th: "Thai", vi: "Vietnamese", tr: "Turkish", pl: "Polish", nl: "Dutch",
        }
        return map[code] || code.toUpperCase()
    }

    private shortId(id: string): string {
        const i = id.indexOf("$")
        return i === -1 ? id : id.slice(0, i)
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
