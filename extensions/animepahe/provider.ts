declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "https://animepahe.pw")
    private solverUrl = this.cfg("solverUrl", "http://127.0.0.1:8191/v1")
    private solverSession = this.cfg("solverSession", "seanime")
    private lastSolverReason = ""
    private challenged = false
    private cookieTtl = 10800000
    private baseTtl = 21600000
    private epCacheTtl = 900000
    private serverCacheTtl = 300000

    getSettings(): Settings {
        return {
            episodeServers: ["Auto"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        await this.init()
        const audio = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)

        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}
        let blocked = false
        let lastErr = ""

        for (const q of queries) {
            let data: AnimeData[] | undefined
            let shapeErr = ""
            this.challenged = false
            const ckey = `apahe:srch:${q.toLowerCase()}`
            const cachedData = this.readCache<AnimeData[]>(ckey, 300000)
            if (cachedData && cachedData.length > 0) {
                data = cachedData
            } else {
                try {
                    const json = await this.getJson<SearchResponse>(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(q)}`)
                    shapeErr = this.searchShapeError(json)
                    data = json && json.data ? json.data : []
                    if (data.length > 0) this.writeCache(ckey, data)
                } catch (e) {
                    data = undefined
                    lastErr = typeof e === "string" ? e : e && (e as any).message ? (e as any).message : "request failed"
                    blocked = this.challenged
                    if (blocked || typeof e === "string") break
                }
            }
            if (shapeErr) throw this.fail("parse", shapeErr)
            if (!data) continue
            for (const item of data) {
                if (!item || !item.session || seen[item.session]) continue
                seen[item.session] = true
                results.push({
                    id: `${item.session}$${audio}`,
                    title: item.title,
                    url: `${this.baseUrl}/anime/${item.session}`,
                    subOrDub: "both",
                })
            }
        }

        if (results.length === 0 && lastErr) throw blocked ? `${this.blockedMessage()} (${lastErr})` : lastErr
        return this.filterBySeason(results, opts)
    }

    private cfg(name: string, fallback: string): string {
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
    }

    private searchShapeError(json: SearchResponse | undefined): string {
        const what = "AnimePahe's search API answered, but "
        const tail = " — the site changed its API; this extension needs an update."
        if (!json) return what + "with nothing readable" + tail
        if (!Array.isArray(json.data)) return what + "without a result list" + tail
        const total = typeof json.total === "number" ? json.total : -1
        if (json.data.length === 0) {
            if (total < 0) return what + "without a result count" + tail
            if (total > 0) return what + "listed " + total + " matches while returning none" + tail
            return ""
        }
        for (const item of json.data) {
            if (item && typeof item.session === "string" && item.session) return ""
        }
        return what + "none of its " + json.data.length + " results carry an id" + tail
    }

    private filterBySeason(results: SearchResult[], opts: SearchOptions): SearchResult[] {
        const pool = this.sameShow(results, opts.media)
        const target = this.targetOrdinals(opts)
        if (target.season < 2 && target.part < 2) return pool
        const matched = pool.filter((r) => {
            const n = this.ordinalsOf(r.title)
            const seasonOk = target.season < 2 || n.season === target.season
            const partOk = target.part < 2 || n.part === target.part
            return seasonOk && partOk
        })
        return matched.length > 0 ? matched : pool
    }

    private sameShow(results: SearchResult[], media: Media): SearchResult[] {
        const targets: string[] = []
        for (const t of [media.romajiTitle, media.englishTitle]) {
            const b = this.normTitle(this.baseTitle(t || ""))
            if (b.length >= 3) targets.push(b)
        }
        if (targets.length === 0) return results
        const kept = results.filter((r) => {
            const b = this.normTitle(this.baseTitle(r.title))
            if (b.length < 3) return false
            for (const t of targets) {
                if (this.simNorm(b, t) >= 0.8) return true
                if (b.indexOf(t) === 0 || t.indexOf(b) === 0) return true
            }
            return false
        })
        return kept.length > 0 ? kept : results
    }

    private targetOrdinals(opts: SearchOptions): { season: number; part: number } {
        let season = 1
        let part = 1
        for (const s of [opts.query, opts.media.romajiTitle, opts.media.englishTitle]) {
            if (!s) continue
            const n = this.ordinalsOf(s)
            if (n.season > season) season = n.season
            if (n.part > part) part = n.part
        }
        return { season, part }
    }

    private ordinalsOf(title: string): { season: number; part: number } {
        if (!title) return { season: 1, part: 1 }
        try {
            const n = $scannerUtils.normalizeTitle(title)
            if (n) return { season: n.season >= 2 ? n.season : 1, part: n.part >= 2 ? n.part : 1 }
        } catch (_e) {}
        return { season: 1, part: 1 }
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
        await this.init()
        const parts = id.split("$")
        const animeSession = parts[0]
        const audio = parts[1] === "dub" ? "dub" : "sub"
        if (!animeSession) throw this.fail("episodes", "invalid anime id")

        const cacheKey = `apahe:eps2:${animeSession}:${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.epCacheTtl)
        if (cached && cached.length > 0) return cached

        const first = await this.getJson<ReleaseResponse>(`${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=1`)
        if (!first) throw this.fail("episodes", "empty episode list response")

        const all: EpisodeData[] = []
        if (first.data) for (const d of first.data) all.push(d)

        const lastPage = first.last_page && first.last_page > 1 ? first.last_page : 1
        for (let page = 2; page <= lastPage; page++) {
            try {
                const next = await this.getJson<ReleaseResponse>(`${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=${page}`)
                if (next && next.data) for (const d of next.data) all.push(d)
            } catch (_e) {
                throw this.fail("episodes", `only got ${page - 1} of ${lastPage} pages of the episode list — the site is refusing this connection right now, so the list would have been incomplete. Try again.`)
            }
        }

        const collected: { session: string; num: number; title?: string }[] = []
        const seen: { [key: string]: boolean } = {}
        for (const d of all) {
            if (!d || !d.session) continue
            const num = typeof d.episode === "number" ? d.episode : parseFloat(String(d.episode))
            if (isNaN(num) || Math.floor(num) !== num) continue
            if (seen[d.session]) continue
            seen[d.session] = true
            collected.push({ session: d.session, num: num, title: d.title })
        }

        if (collected.length === 0) throw this.fail("episodes", "no episodes found")
        const offset = Math.max(0, collected.reduce((m, c) => Math.min(m, c.num), Infinity) - 1)

        const episodes: EpisodeDetails[] = collected.map((c) => {
            const number = c.num - offset
            return {
                id: `${c.session}$${animeSession}$${audio}`,
                number: number,
                url: `${this.baseUrl}/play/${animeSession}/${c.session}`,
                title: c.title && c.title.length > 0 ? c.title : `Episode ${number}`,
            }
        })

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
        if (!episodeSession || !animeSession) throw this.fail("server", "invalid episode id")

        const playUrl = `${this.baseUrl}/play/${animeSession}/${episodeSession}`
        const candidates = await this.playSources(animeSession, episodeSession, audio, playUrl)
        if (candidates.length === 0) throw this.fail("server", audio === "dub" ? "no dub source for this episode" : "no source found for this episode")

        const sources: EpisodeServer["videoSources"] = []
        const useProxy = !!this.solverEndpoint() && (await this.solverPing()).up
        for (const c of candidates) {
            try {
                const m3u8 = await this.resolveKwik(c.url, playUrl)
                if (m3u8) sources.push({ url: useProxy ? this.proxyM3u8(m3u8, c.url) : m3u8, type: "m3u8", quality: c.label, subtitles: [] })
            } catch (_e) {}
        }
        if (sources.length === 0) throw this.fail("server", "could not resolve any source")

        const origin = this.originOf(candidates[0].url)
        return { server: "Auto", headers: { Referer: `${origin}/`, Origin: origin }, videoSources: sources }
    }

    private async playSources(animeSession: string, episodeSession: string, audio: string, playUrl: string): Promise<PlaySource[]> {
        const cacheKey = `apahe:play2:${animeSession}:${episodeSession}:${audio}`
        const cached = this.readCache<PlaySource[]>(cacheKey, this.serverCacheTtl)
        if (cached && cached.length > 0) return cached
        const html = await this.getText(playUrl, { Referer: `${this.baseUrl}/` }, (b) => this.parsePlaySources(b, audio).length > 0)
        const out = this.parsePlaySources(html || "", audio)
        if (out.length > 0) this.writeCache(cacheKey, out)
        return out
    }

    private searchQueries(opts: SearchOptions): string[] {
        const raw = [opts.query, opts.media.romajiTitle, opts.media.englishTitle]
        const out: string[] = []
        const seen: { [key: string]: boolean } = {}
        const add = (s: string): void => {
            const q = (s || "").trim()
            if (!q) return
            const key = q.toLowerCase()
            if (seen[key]) return
            seen[key] = true
            out.push(q)
        }
        for (const t of raw) add(t || "")
        for (const t of raw) add(this.baseTitle(t || ""))
        return out.slice(0, 6)
    }

    private baseTitle(t: string): string {
        if (!t) return ""
        let s = t
        s = s.replace(/[\(\[][^\)\]]*[\)\]]/g, " ")
        s = s.replace(/\b(?:season|cour|part|saison|stagione|temporada)\s*\d+\b/gi, " ")
        s = s.replace(/\s+(?:\d{1,2}|[ivx]{1,4})\s*$/i, " ")
        s = s.replace(/[._:;,\-!?]+/g, " ")
        s = s.replace(/\s+/g, " ").trim()
        return s
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

    private async resolveKwik(embedUrl: string, playUrl: string): Promise<string | undefined> {
        const ck = `apahe:m3u8:${embedUrl}`
        const cached = this.readCache<string>(ck, this.serverCacheTtl)
        if (cached) return cached
        let html = ""
        try {
            const res = await this.fetchRetry(embedUrl, { headers: { Referer: playUrl } })
            if (res.ok && !this.isBlocked(res)) html = res.text()
        } catch (_e) {}
        if (!html) {
            const solved = await this.solveGet(embedUrl)
            if (solved) html = solved
        }
        if (!html) return undefined

        let found = this.matchM3u8(html)
        if (!found) for (const block of (html.match(/eval\(function\(p,a,c,k,e,[dr](?:,\s*[dr])?\)[\s\S]*?\.split\('\|'\)[\s\S]*?\)\)/g) || []).slice(0, 12)) {
            const clean = (this.unpack(block) || "").replace(/\\/g, "")
            const src = clean.match(/source\s*[:=]\s*['"]?([^'"\s]+\.m3u8[^'"\s]*)/i)
            found = (src && src[1]) || this.matchM3u8(clean)
            if (found) break
        }
        if (found) this.writeCache(ck, found)
        return found
    }

    private matchM3u8(s: string): string | undefined {
        if (!s) return undefined
        const re = /https?:\/\/[^\s'"\\<>]+\.m3u8[^\s'"\\<>]*/gi
        let m: RegExpExecArray | null
        while ((m = re.exec(s)) !== null) {
            if (this.remoteHttps(m[0])) return m[0]
        }
        return undefined
    }

    private remoteHttps(url: string): boolean {
        if (!/^https?:\/\//i.test(url)) return false
        const host = url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].split("@").pop() || ""
        const name = host.split(":")[0].toLowerCase()
        if (!name) return false
        if (name === "localhost" || /\.local$/.test(name) || /\.localhost$/.test(name)) return false
        if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return false
        if (name.indexOf("[") === 0) return false
        return name.indexOf(".") !== -1
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
            if (!Number.isInteger(idx) || idx < 0 || idx >= count) return word
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
        const cached = $store.get<{ at: number; host: string }>("apahe:base2")
        if (cached && cached.host && /animepahe/i.test(cached.host) && Date.now() - cached.at < this.baseTtl) return cached.host
        const pref = this.baseUrl.replace(/\/+$/, "").replace(/^https?:\/\/animepahe\.(com|org)\b/i, "https://animepahe.pw")
        let found = ""
        for (const c of pref === "https://animepahe.pw" ? [pref] : [pref, "https://animepahe.pw"]) {
            try {
                const res = await fetch(`${c}/`, { headers: this.browserHeaders() })
                if (res.ok || (!found && (res.status === 403 || res.status === 503))) {
                    const m = (res.url || "").match(/^(https?:\/\/[^\/?#]+)/i)
                    found = m && /animepahe/i.test(m[1]) ? m[1] : c
                    this.absorbCookies(this.cookiesFrom(res))
                    if (res.ok) break
                }
            } catch (_e) {}
        }
        if (found) $store.set("apahe:base2", { at: Date.now(), host: found })
        return found || pref
    }

    private async harvestCookies(force: boolean): Promise<string> {
        const cached = $store.get<{ at: number; map: { [k: string]: string } }>("apahe:ck")
        if (!force && cached && cached.map && Object.keys(cached.map).length > 0 && Date.now() - cached.at < this.cookieTtl) {
            return this.cookieHeader(cached.map)
        }
        let map = cached && cached.map ? cached.map : {}
        const before = this.cookieHeader(map)
        try {
            const res = await fetch(`${this.baseUrl}/`, { headers: this.browserHeaders() })
            map = Object.assign({}, map, this.cookiesFrom(res))
        } catch (_e) {}
        const after = this.cookieHeader(map)
        const at = (after === before && cached && cached.at && cached.at > 0) ? cached.at : Date.now()
        $store.set("apahe:ck", { at: at, map })
        return after
    }

    private async getText(url: string, extra?: { [k: string]: string }, valid?: (body: string) => boolean): Promise<string> {
        let cookie = await this.harvestCookies(false)
        let res: FetchResponse | undefined
        for (let i = 0; i < 2; i++) {
            try {
                res = await fetch(url, { headers: this.apiHeaders(cookie, extra) })
                this.absorbCookies(this.cookiesFrom(res))
                this.challenged = this.bodyIsChallenge(res.text().slice(0, 8192))
                if (!this.isBlocked(res)) {
                    const body = res.text()
                    if (!valid || valid(body)) return body
                }
            } catch (_e) {}
            cookie = await this.harvestCookies(true)
        }
        const solved = await this.solveGet(url)
        if (solved && (!valid || valid(solved))) return solved
        if (!this.solverEndpoint()) throw this.fail("server", "The solver endpoint in this extension's settings is not a full http:// or https:// address — fix it there and run the solver via Aqua's Utils.")
        const ping = await this.solverPing()
        if (!ping.up) throw this.fail("server", "Aqua's Utils solver isn't reachable at " + this.solverEndpoint() + " — open Aqua's Utils and start it.")
        const why = this.lastSolverReason.replace(/^needs-stronger-solver:\s*/i, "")
        $store.remove("apahe:base2")
        this.challenged = true
        throw this.fail("fetch", "Connected to the solver (v" + (ping.version || "?") + ") but it couldn't clear the site's protection" + (why ? " — " + why : "") + ".")
    }

    private async solverPing(): Promise<{ up: boolean; version?: string }> {
        const ep = this.solverEndpoint()
        if (!ep) return { up: false }
        const cached = $store.get<{ at: number; up: boolean; version?: string }>("apahe:ping")
        const ttl = cached && cached.up ? 30000 : 4000
        if (cached && cached.at > 0 && Date.now() - cached.at < ttl) return { up: cached.up, version: cached.version }
        const d = await this.solverPost(ep, { cmd: "sessions.list" })
        const r = { up: d !== undefined, version: d && d.version ? String(d.version) : undefined }
        $store.set("apahe:ping", { at: Date.now(), up: r.up, version: r.version })
        return r
    }

    private async getJson<T>(url: string): Promise<T> {
        const text = await this.getText(url, { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" }, (body) => this.parseJson<T>(body) !== undefined)
        return this.parseJson<T>(text) as T
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
        return undefined
    }

    private async fetchRetry(url: string, opts?: FetchOptions): Promise<FetchResponse> {
        try {
            const res = await fetch(url, opts)
            if (res.status < 500) return res
        } catch (_e) {}
        return fetch(url, opts)
    }

    private solverEndpoint(): string {
        const u = (this.solverUrl || "").trim()
        if (!/^https?:\/\/[^\s/]+/i.test(u)) return ""
        const base = u.replace(/\/+$/, "")
        return /\/v1$/.test(base) ? base : `${base}/v1`
    }

    private proxyM3u8(m3u8: string, referer: string): string {
        const ep = this.solverEndpoint()
        if (!ep) return m3u8
        const base = ep.replace(/\/v1$/, "")
        return `${base}/m3u8?u=${encodeURIComponent(m3u8)}&r=${encodeURIComponent(referer)}`
    }

    private async solverPost(ep: string, payload: { [k: string]: any }): Promise<any> {
        try {
            const res = await fetch(ep, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                noCloudflareBypass: true,
            })
            if (!res.ok) return undefined
            return res.json<any>()
        } catch (_e) {
            return undefined
        }
    }

    private async solveGet(url: string): Promise<string | undefined> {
        const ep = this.solverEndpoint()
        if (!ep) return undefined
        const data = await this.solverPost(ep, { cmd: "request.get", url, maxTimeout: 30000, session: this.solverSession.trim() || "seanime" })
        const sol = data && data.solution ? data.solution : undefined
        if (sol) this.absorbSolution(sol, /animepahe/i.test(url))
        const body = sol ? sol.response : undefined
        this.lastSolverReason = data && data.message ? String(data.message) : ""
        if (body && !this.bodyIsChallenge(body)) return body
        return undefined
    }

    private reportError(scope: string, message: string): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-animepahe", scope: scope, msg: this.plain(message) }))
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

    private fail(scope: string, message: string): string {
        this.reportError(scope, message)
        return message
    }

    private blockedMessage(): string {
        if (this.solverEndpoint()) {
            return "Cloudflare challenge could not be solved (even via the configured solver); AnimePahe is heavily challenging this connection."
        }
        return "Cloudflare is challenging requests. This connection (mobile/CGNAT or a flagged IP) is being hard-challenged. Set a solver endpoint (run it via Aqua's Utils) in this provider's settings, use a wired/residential connection, or retry later."
    }

    private isBlocked(res: FetchResponse): boolean {
        if (!res) return true
        if (res.status === 403 || res.status === 429 || res.status === 503) return true
        const ct = (res.contentType || "").toLowerCase()
        if (res.ok && ct.indexOf("application/json") === -1 && this.bodyIsChallenge(res.text())) return true
        return false
    }

    private bodyIsChallenge(body: string): boolean {
        const b = (body || "").toLowerCase()
        return ["ddos-guard", "ddg-cookie", "checking your browser", "just a moment", "cf-mitigated", "enable javascript and cookies", "cf-browser-verification", "oncheqresponse", "onrtbfailure"].some((t) => b.indexOf(t) !== -1)
    }

    private solvedUa(): string {
        try { return $store.get<string>("apahe:ua") || "" } catch (_e) { return "" }
    }

    private browserHeaders(): { [key: string]: string } {
        return this.apiHeaders("", { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8", Referer: `${this.baseUrl}/` })
    }

    private apiHeaders(cookie: string, extra?: { [k: string]: string }): { [key: string]: string } {
        const h: { [key: string]: string } = {
            "Accept-Language": "en-US,en;q=0.9",
        }
        if (cookie) h.Cookie = cookie
        const ua = this.solvedUa()
        if (ua) h["User-Agent"] = ua
        if (extra) for (const k in extra) h[k] = extra[k]
        return h
    }

    private cookiesFrom(res: FetchResponse): { [k: string]: string } {
        const out: { [k: string]: string } = {}
        for (const k in res.cookies || {}) if (res.cookies[k]) out[k] = res.cookies[k]
        return out
    }

    private absorbCookies(fresh: { [k: string]: string }): void {
        if (!Object.keys(fresh).length) return
        const cached = $store.get<{ at: number; map: { [k: string]: string } }>("apahe:ck")
        $store.set("apahe:ck", { at: Date.now(), map: Object.assign({}, cached && cached.map, fresh) })
    }

    private absorbSolution(sol: { userAgent?: string; cookies?: { name: string; value: string }[] }, mergeCookies: boolean): void {
        if (mergeCookies && Array.isArray(sol.cookies) && sol.cookies.length) {
            const fresh: { [k: string]: string } = {}
            for (const c of sol.cookies) { if (c && c.name && c.value) fresh[c.name] = c.value }
            this.absorbCookies(fresh)
        }
        if (sol.userAgent) { try { $store.set("apahe:ua", sol.userAgent) } catch (_e) {} }
    }

    private cookieHeader(map: { [k: string]: string }): string {
        return Object.keys(map).map((k) => `${k}=${map[k]}`).join("; ")
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

    private readCache<T>(key: string, ttl: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        if (entry && Date.now() - entry.at < ttl) return entry.data
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

type SearchResponse = {
    total?: number
    data?: AnimeData[]
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
