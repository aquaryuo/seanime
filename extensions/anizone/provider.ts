class Provider {
    private baseUrl = "{{baseUrl}}"
    private cacheTtl = 900000
    private srcCacheTtl = 300000

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const { primary, fallback } = this.searchQueries(opts)
        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}
        let anyOk = false
        const run = async (queries: string[]): Promise<void> => {
            for (const q of queries) {
                if (!q || results.length >= 6) continue
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
        await run(primary)
        if (results.length === 0) await run(fallback)
        if (!anyOk) throw "anizone: search failed (site unreachable)"
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const shortid = this.shortId(id)
        if (!shortid) return []
        const cacheKey = `anizone:eps:${shortid}`
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
            episodes.push({ id: `${shortid}$${n}`, number: n, url: `${this.normBase()}/anime/${shortid}/${n}` })
        }
        episodes.sort((a, b) => a.number - b.number)
        if (episodes.length > 0) this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("$")
        const shortid = parts[0]
        const n = parts[1] || String(episode.number)
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
        const subtitles = this.buildSubs(html)
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

    private searchQueries(opts: SearchOptions): { primary: string[]; fallback: string[] } {
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
        try {
            const seed: string[] = []
            if (opts.query) seed.push(opts.query)
            if (romaji) seed.push(romaji)
            if (english) seed.push(english)
            const smart = $scannerUtils.buildSmartSearchTitles(seed)
            if (smart && smart.titles) for (const t of smart.titles) add(primary, t)
        } catch (_e) {}
        add(primary, romaji)
        add(primary, english)
        add(fallback, this.firstWords(romaji, 1))
        add(fallback, this.firstWords(english, 2))
        add(fallback, this.firstWords(romaji, 2))
        add(fallback, this.firstWords(english, 1))
        return { primary: primary.slice(0, 3), fallback: fallback.slice(0, 4) }
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
            results.push({
                id: sid,
                title: this.bestTitle(b.titles, target),
                url: `${this.normBase()}/anime/${sid}`,
                subOrDub: "sub",
            })
        }
    }

    private decodeTitles(escaped: string): string[] {
        const json = escaped.replace(/\\u([0-9a-fA-F]{4})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)))
        const out: string[] = []
        const re = /"[^"]*":"([^"]*)"/g
        let m: RegExpExecArray | null
        while ((m = re.exec(json)) !== null) {
            const t = (m[1] || "").replace(/\\/g, "").trim()
            if (t) out.push(t)
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

    private buildSubs(html: string): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const re = /https?:\/\/[^"'\s]+\/subtitles\/[0-9]+_([a-z-]+)\.(?:ass|srt)/g
        const seen: { [key: string]: boolean } = {}
        let englishIdx = -1
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const url = m[0]
            const lang = (m[1] || "en").toLowerCase().split("-")[0]
            if (seen[lang]) continue
            seen[lang] = true
            const idx = out.length
            out.push({ id: `${lang}-${idx}`, url, language: this.langName(lang), isDefault: false })
            if (englishIdx === -1 && lang === "en") englishIdx = idx
        }
        if (out.length === 0) return out
        const pick = englishIdx !== -1 ? englishIdx : 0
        out[pick].isDefault = true
        return out.filter((s) => s.isDefault).concat(out.filter((s) => !s.isDefault))
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
