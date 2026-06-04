class Provider {
    private baseUrl = "{{baseUrl}}"
    private mirrors = ["https://animepahe.pw", "https://animepahe.com", "https://animepahe.org"]
    private browserFallback = ("{{browserFallback}}" as string) === "true"
    private cookieTtl = 10800000
    private epCacheTtl = 900000

    getSettings(): Settings {
        return {
            episodeServers: ["Auto", "1080p", "720p", "480p", "360p"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        await this.init()
        const audio = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)

        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}
        let anyOk = false

        for (const q of queries) {
            let json: { data?: AnimeData[] } | undefined
            try {
                json = await this.getJson<{ data?: AnimeData[] }>(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(q)}`)
                anyOk = true
            } catch (_e) {
                json = undefined
            }
            if (!json || !json.data) continue
            for (const item of json.data) {
                if (!item || !item.session || seen[item.session]) continue
                seen[item.session] = true
                results.push({
                    id: `${item.session}$${audio}`,
                    title: this.titleWithMeta(item),
                    url: `${this.baseUrl}/anime/${item.session}`,
                    subOrDub: audio === "dub" ? "dub" : "sub",
                })
            }
        }

        if (!anyOk) throw new Error("search failed")
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        await this.init()
        const parts = id.split("$")
        const animeSession = parts[0]
        const audio = parts[1] === "dub" ? "dub" : "sub"
        if (!animeSession) throw new Error("Invalid anime id.")

        const cacheKey = `apahe:eps:${animeSession}:${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.epCacheTtl)
        if (cached && cached.length > 0) return cached

        const first = await this.getJson<ReleaseResponse>(`${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=1`)
        if (!first) throw new Error("Empty episode response.")

        const all: EpisodeData[] = []
        if (first.data) for (const d of first.data) all.push(d)

        const lastPage = first.last_page && first.last_page > 1 ? first.last_page : 1
        for (let page = 2; page <= lastPage; page++) {
            try {
                const next = await this.getJson<ReleaseResponse>(`${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=${page}`)
                if (next && next.data) for (const d of next.data) all.push(d)
            } catch (_e) {}
        }

        const episodes: EpisodeDetails[] = []
        const seen: { [key: string]: boolean } = {}
        for (const d of all) {
            if (!d || !d.session) continue
            const num = typeof d.episode === "number" ? d.episode : parseFloat(String(d.episode))
            if (isNaN(num) || !this.isWhole(num)) continue
            if (seen[d.session]) continue
            seen[d.session] = true
            episodes.push({
                id: `${d.session}$${animeSession}$${audio}`,
                number: num,
                url: `${this.baseUrl}/play/${animeSession}/${d.session}`,
                title: d.title && d.title.length > 0 ? d.title : `Episode ${num}`,
            })
        }

        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort((a, b) => a.number - b.number)
        this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        await this.init()
        const parts = episode.id.split("$")
        const episodeSession = parts[0]
        const animeSession = parts[1]
        const audio = parts[2] === "dub" ? "dub" : "sub"
        if (!episodeSession || !animeSession) throw new Error("Invalid episode id.")

        const playUrl = `${this.baseUrl}/play/${animeSession}/${episodeSession}`
        const html = await this.getText(playUrl, { Referer: `${this.baseUrl}/` })
        const candidates = this.parsePlaySources(html, audio)
        if (candidates.length === 0) {
            if (audio === "dub") throw new Error("No dub source for this episode.")
            throw new Error("No source found for this episode.")
        }

        const wantAuto = server === "Auto" || server === "default" || !server
        const ordered = this.orderForRequest(candidates, server, wantAuto)

        let lastErr: any
        for (const c of ordered) {
            try {
                const m3u8 = await this.resolveKwik(c.url, playUrl)
                if (!m3u8) continue
                const label = wantAuto ? "Auto" : server
                const origin = this.originOf(c.url)
                return {
                    server: label,
                    headers: { Referer: `${origin}/`, Origin: origin },
                    videoSources: [
                        {
                            url: m3u8,
                            type: "m3u8",
                            quality: c.label,
                            subtitles: [],
                        },
                    ],
                }
            } catch (e) {
                lastErr = e
            }
        }
        throw new Error(lastErr ? `Could not resolve source: ${lastErr}` : "Could not resolve any source.")
    }

    private searchQueries(opts: SearchOptions): string[] {
        const raw = [opts.query, opts.media.romajiTitle, opts.media.englishTitle]
        const out: string[] = []
        const seen: { [key: string]: boolean } = {}
        for (const t of raw) {
            const q = (t || "").trim()
            if (!q) continue
            const key = q.toLowerCase()
            if (seen[key]) continue
            seen[key] = true
            out.push(q)
        }
        return out
    }

    private titleWithMeta(item: AnimeData): string {
        const bits: string[] = []
        if (item.type) bits.push(item.type)
        if (item.year) bits.push(String(item.year))
        return bits.length > 0 ? `${item.title} (${bits.join(", ")})` : item.title
    }

    private parsePlaySources(html: string, audio: string): PlaySource[] {
        const $ = LoadDoc(html)
        let nodes = $("#resolutionMenu button[data-src]")
        if (nodes.length() === 0) nodes = $("button[data-src]")

        const wantDub = audio === "dub"
        const out: PlaySource[] = []
        const seen: { [key: string]: boolean } = {}

        nodes.each((_i, el) => {
            const url = el.attr("data-src")
            if (!url || seen[url]) return
            const isEng = (el.attr("data-audio") || "").toLowerCase() === "eng"
            if (wantDub !== isEng) return
            seen[url] = true
            const res = el.attr("data-resolution") || ""
            const fansub = el.attr("data-fansub") || ""
            const num = parseInt(res, 10)
            const label = `${res ? res + "p" : "default"}${fansub ? " · " + fansub : ""}${isEng ? " (Eng)" : ""}`.trim()
            out.push({ url, resolution: isNaN(num) ? 0 : num, label })
        })

        out.sort((a, b) => b.resolution - a.resolution)
        return out
    }

    private orderForRequest(candidates: PlaySource[], server: string, wantAuto: boolean): PlaySource[] {
        if (wantAuto) return candidates
        const want = parseInt(server, 10)
        if (isNaN(want)) return candidates
        const exact = candidates.filter((c) => c.resolution === want)
        const rest = candidates.filter((c) => c.resolution !== want)
        return exact.concat(rest)
    }

    private async resolveKwik(embedUrl: string, playUrl: string): Promise<string | undefined> {
        const res = await this.fetchRetry(embedUrl, { headers: { Referer: playUrl } })
        if (!res.ok) return undefined
        const html = res.text()

        const direct = this.matchM3u8(html)
        if (direct) return direct

        for (const block of this.extractPacked(html)) {
            const unpacked = this.unpack(block)
            if (!unpacked) continue
            const clean = unpacked.replace(/\\/g, "")
            const fromSource = clean.match(/source\s*[:=]\s*['"]?([^'"\s]+\.m3u8[^'"\s]*)/i)
            if (fromSource && fromSource[1]) return fromSource[1]
            const generic = this.matchM3u8(clean)
            if (generic) return generic
        }
        return undefined
    }

    private matchM3u8(s: string): string | undefined {
        if (!s) return undefined
        const m = s.match(/https?:\/\/[^\s'"\\<>]+\.m3u8[^\s'"\\<>]*/i)
        return m ? m[0] : undefined
    }

    private extractPacked(html: string): string[] {
        const out: string[] = []
        const re = /eval\(function\(p,a,c,k,e,[dr](?:,\s*[dr])?\)[\s\S]*?\.split\('\|'\)[\s\S]*?\)\)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            out.push(m[0])
            if (out.length >= 12) break
        }
        return out
    }

    private unpack(src: string): string | undefined {
        const m = src.match(/\}\s*\(\s*'([\s\S]*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*(?:\\'[^']*)*)'\.split\('\|'\)/)
        if (!m) return undefined
        const payload = m[1]
        const radix = parseInt(m[2], 10)
        const count = parseInt(m[3], 10)
        const symtab = m[4].split("|")
        if (symtab.length < count) return undefined
        const unbase = this.makeUnbase(radix)
        return payload.replace(/\b\w+\b/g, (word) => {
            const idx = unbase(word)
            const v = symtab[idx]
            return v !== undefined && v !== "" ? v : word
        })
    }

    private makeUnbase(radix: number): (s: string) => number {
        if (radix <= 36) return (s) => parseInt(s, radix)
        const a62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        const a95 = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
        const alphabet = radix < 62 ? a62.slice(0, radix) : radix === 62 ? a62 : a95.slice(0, radix)
        const dict: { [c: string]: number } = {}
        for (let i = 0; i < alphabet.length; i++) dict[alphabet.charAt(i)] = i
        return (s) => {
            let n = 0
            for (let i = 0; i < s.length; i++) {
                const d = dict[s.charAt(i)]
                n = n * radix + (d === undefined ? 0 : d)
            }
            return n
        }
    }

    private async init(): Promise<void> {
        this.baseUrl = await this.resolveBase()
        await this.harvestCookies(false)
    }

    private async resolveBase(): Promise<string> {
        const all = [this.baseUrl].concat(this.mirrors).map((u) => u.replace(/\/+$/, ""))
        const candidates = all.filter((u, i) => all.indexOf(u) === i)
        if (candidates.length === 1) return candidates[0]
        const cached = $store.get<string>("apahe:base")
        if (cached && candidates.indexOf(cached) !== -1) return cached
        let fallback = ""
        for (const c of candidates) {
            try {
                const res = await fetch(`${c}/`, { headers: this.browserHeaders(), timeout: 10 })
                if (res && res.ok) {
                    this.absorbCookies(res)
                    $store.set("apahe:base", c)
                    return c
                }
                if (res && !fallback && (res.status === 403 || res.status === 503)) {
                    fallback = c
                    this.absorbCookies(res)
                }
            } catch (_e) {}
        }
        if (fallback) {
            $store.set("apahe:base", fallback)
            return fallback
        }
        return candidates[0]
    }

    private async harvestCookies(force: boolean): Promise<string> {
        const cached = $store.get<{ at: number; map: { [k: string]: string } }>("apahe:ck")
        const t = this.now()
        if (!force && cached && cached.map && this.mapSize(cached.map) > 0 && t > 0 && t - cached.at < this.cookieTtl) {
            return this.cookieHeader(cached.map)
        }
        let map = cached && cached.map ? cached.map : {}
        try {
            const res = await fetch(`${this.baseUrl}/`, { headers: this.browserHeaders(), timeout: 15 })
            map = this.mergeCookieMap(map, this.cookiesFrom(res))
        } catch (_e) {}
        $store.set("apahe:ck", { at: this.now(), map })
        return this.cookieHeader(map)
    }

    private async getText(url: string, extra?: { [k: string]: string }): Promise<string> {
        let cookie = await this.harvestCookies(false)
        let res: FetchResponse | undefined
        for (let i = 0; i < 3; i++) {
            try {
                res = await fetch(url, { headers: this.apiHeaders(cookie, extra) })
                this.absorbCookies(res)
                if (!this.isBlocked(res)) return res.text()
            } catch (e) {
                if (i === 2 && !this.browserFallback) throw e
            }
            cookie = await this.harvestCookies(true)
        }
        if (this.browserFallback) {
            const html = await this.scrapeWithBrowser(url)
            if (html) return html
        }
        if (res && !this.isBlocked(res)) return res.text()
        throw new Error("request blocked by DDoS-Guard; enable the headless browser fallback in this provider's settings if it persists")
    }

    private async getJson<T>(url: string): Promise<T> {
        const text = await this.getText(url, { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" })
        const parsed = this.parseJson<T>(text)
        if (parsed === undefined) throw new Error("invalid JSON response")
        return parsed
    }

    private parseJson<T>(text: string): T | undefined {
        if (!text) return undefined
        try {
            return JSON.parse(text) as T
        } catch (_e) {}
        const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
        if (pre && pre[1]) {
            try {
                return JSON.parse(this.unescapeHtml(pre[1].trim())) as T
            } catch (_e) {}
        }
        const obj = text.match(/[\[{][\s\S]*[\]}]/)
        if (obj) {
            try {
                return JSON.parse(obj[0]) as T
            } catch (_e) {}
        }
        return undefined
    }

    private async fetchRetry(url: string, opts?: FetchOptions, tries = 2): Promise<FetchResponse> {
        let lastErr: any
        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url, opts)
                if (res.ok || res.status < 500 || i === tries - 1) return res
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr
    }

    private async scrapeWithBrowser(url: string): Promise<string | undefined> {
        try {
            return await ChromeDP.scrape(url, { timeout: 45, waitDuration: 4000, headless: true })
        } catch (_e) {
            return undefined
        }
    }

    private isBlocked(res: FetchResponse): boolean {
        if (!res) return true
        if (res.status === 403 || res.status === 429 || res.status === 503) return true
        if (res.ok) {
            const body = res.text()
            if (body.indexOf("DDoS-Guard") !== -1 || body.indexOf("ddg-cookie") !== -1 || body.indexOf("Checking your browser") !== -1) return true
        }
        return false
    }

    private browserHeaders(): { [key: string]: string } {
        return {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: `${this.baseUrl}/`,
        }
    }

    private apiHeaders(cookie: string, extra?: { [k: string]: string }): { [key: string]: string } {
        const h: { [key: string]: string } = {
            "Accept-Language": "en-US,en;q=0.9",
        }
        if (cookie) h.Cookie = cookie
        if (extra) for (const k in extra) h[k] = extra[k]
        return h
    }

    private cookiesFrom(res: FetchResponse): { [k: string]: string } {
        const out: { [k: string]: string } = {}
        if (res && res.cookies) {
            for (const k in res.cookies) {
                if (res.cookies[k]) out[k] = res.cookies[k]
            }
        }
        const rh = res ? res.rawHeaders : undefined
        if (rh) {
            for (const key in rh) {
                if (key.toLowerCase() !== "set-cookie") continue
                const lines = rh[key]
                if (!lines) continue
                for (const line of lines) {
                    const seg = line.split(";")[0]
                    const eq = seg.indexOf("=")
                    if (eq > 0) {
                        const name = seg.slice(0, eq).trim()
                        const value = seg.slice(eq + 1).trim()
                        if (name && value) out[name] = value
                    }
                }
            }
        }
        return out
    }

    private absorbCookies(res: FetchResponse): void {
        const fresh = this.cookiesFrom(res)
        if (this.mapSize(fresh) === 0) return
        const cached = $store.get<{ at: number; map: { [k: string]: string } }>("apahe:ck")
        const base = cached && cached.map ? cached.map : {}
        const map = this.mergeCookieMap(base, fresh)
        $store.set("apahe:ck", { at: this.now(), map })
    }

    private mergeCookieMap(base: { [k: string]: string }, add: { [k: string]: string }): { [k: string]: string } {
        const out: { [k: string]: string } = {}
        for (const k in base) out[k] = base[k]
        for (const k in add) if (add[k]) out[k] = add[k]
        return out
    }

    private cookieHeader(map: { [k: string]: string }): string {
        const parts: string[] = []
        for (const k in map) parts.push(`${k}=${map[k]}`)
        return parts.join("; ")
    }

    private mapSize(map: { [k: string]: string }): number {
        let n = 0
        for (const _k in map) n++
        return n
    }

    private isWhole(n: number): boolean {
        return Math.floor(n) === n
    }

    private unescapeHtml(s: string): string {
        return s
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
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
        const max = ttl === undefined ? this.epCacheTtl : ttl
        if (entry && t > 0 && entry.at > 0 && t - entry.at < max) return entry.data
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        const t = this.now()
        if (t > 0) $store.set(key, { at: t, data })
    }

    private originOf(u: string): string {
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.baseUrl
    }
}

type AnimeData = {
    id?: number
    title: string
    type?: string
    year?: number
    poster?: string
    session: string
}

type EpisodeData = {
    id?: number
    episode: number
    title?: string
    session: string
    audio?: string
}

type ReleaseResponse = {
    last_page?: number
    data?: EpisodeData[]
}

type PlaySource = {
    url: string
    resolution: number
    label: string
}
