declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

class Provider {
    private baseUrl = "{{baseUrl}}"
    private mirrors = ["https://animepahe.pw", "https://animepahe.com", "https://animepahe.org"]
    private solverUrl = ("{{solverUrl}}" as string)
    private solverDown = false
    private lastResp: { url: string; status: number; statusText: string; ct: string; len: number; redirected: boolean; finalUrl: string; snippet: string; hit: string } | undefined = undefined
    private lastSolver: { ran: boolean; http: number; snippet: string; reason: string } | undefined = undefined
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
            const ckey = `apahe:srch:${q.toLowerCase()}`
            const cachedData = this.readCache<AnimeData[]>(ckey, 300000)
            if (cachedData && cachedData.length > 0) {
                data = cachedData
            } else {
                try {
                    const json = await this.getJson<{ data?: AnimeData[] }>(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(q)}`)
                    data = json && json.data ? json.data : []
                    if (data.length > 0) this.writeCache(ckey, data)
                } catch (e) {
                    data = undefined
                    const msg = typeof e === "string" ? e : e && (e as any).message ? (e as any).message : "request failed"
                    lastErr = msg
                    if ((this.lastResp && this.lastResp.hit) || msg.indexOf("blocked") !== -1 || msg.indexOf("Cloudflare") !== -1) blocked = true
                    if (blocked || msg.indexOf("reachable") !== -1 || msg.indexOf("endpoint not set") !== -1 || msg.indexOf("protection") !== -1 || msg.indexOf("expected JSON") !== -1) break
                }
            }
            if (!data) continue
            for (const item of data) {
                if (!item || !item.session || seen[item.session]) continue
                seen[item.session] = true
                results.push({
                    id: `${item.session}$${audio}`,
                    title: item.title,
                    url: `${this.baseUrl}/anime/${item.session}`,
                    subOrDub: audio === "dub" ? "dub" : "sub",
                })
            }
        }

        if (results.length === 0 && lastErr) {
            if (blocked) throw new Error(`${this.blockedMessage()} (${lastErr})`)
            throw new Error(lastErr)
        }
        return this.filterBySeason(results, opts)
    }

    private filterBySeason(results: SearchResult[], opts: SearchOptions): SearchResult[] {
        const target = this.targetOrdinal(opts)
        if (target <= 1) return results
        const matched = results.filter((r) => this.ordinalOf(r.title) === target)
        return matched.length > 0 ? matched : results
    }

    private targetOrdinal(opts: SearchOptions): number {
        let target = 1
        for (const s of [opts.query, opts.media.romajiTitle, opts.media.englishTitle]) {
            if (!s) continue
            const n = this.ordinalOf(s)
            if (n > target) target = n
        }
        return target
    }

    private ordinalOf(title: string): number {
        if (!title) return 1
        try {
            const n = $scannerUtils.normalizeTitle(title)
            if (n && n.season >= 2) return n.season
            if (n && n.part >= 2) return n.part
        } catch (_e) {}
        return 1
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        await this.init()
        const parts = id.split("$")
        const animeSession = parts[0]
        const audio = parts[1] === "dub" ? "dub" : "sub"
        if (!animeSession) throw this.fail("episodes", "invalid anime id")

        const cacheKey = `apahe:eps:${animeSession}:${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey, this.epCacheTtl)
        if (cached && cached.length > 0) return cached

        const first = await this.getJson<ReleaseResponse>(`${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=1`)
        if (!first) throw this.fail("episodes", "empty episode list response")

        const all: EpisodeData[] = []
        if (first.data) for (const d of first.data) all.push(d)

        const lastPage = first.last_page && first.last_page > 1 ? first.last_page : 1
        let pageFail = false
        for (let page = 2; page <= lastPage; page++) {
            try {
                const next = await this.getJson<ReleaseResponse>(`${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=${page}`)
                if (next && next.data) for (const d of next.data) all.push(d)
            } catch (_e) { pageFail = true }
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

        if (episodes.length === 0) throw this.fail("episodes", "no episodes found")
        episodes.sort((a, b) => a.number - b.number)
        if (!pageFail) this.writeCache(cacheKey, episodes)
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
        for (const c of candidates) {
            try {
                const m3u8 = await this.resolveKwik(c.url, playUrl)
                if (m3u8) sources.push({ url: this.proxyM3u8(m3u8, c.url), type: "m3u8", quality: c.label, subtitles: [] })
            } catch (_e) {}
        }
        if (sources.length === 0) throw this.fail("server", "could not resolve any source")

        const origin = this.originOf(candidates[0].url)
        return { server: "animepahe", headers: { Referer: `${origin}/`, Origin: origin }, videoSources: sources }
    }

    private async playSources(animeSession: string, episodeSession: string, audio: string, playUrl: string): Promise<PlaySource[]> {
        const cacheKey = `apahe:play:${animeSession}:${episodeSession}`
        let html = this.readCache<string>(cacheKey, this.serverCacheTtl)
        if (!html) {
            html = await this.getText(playUrl, { Referer: `${this.baseUrl}/` }, (b) => this.looksLikePlayPage(b))
            if (this.looksLikePlayPage(html)) this.writeCache(cacheKey, html)
        }
        return this.parsePlaySources(html || "", audio)
    }

    private looksLikePlayPage(html: string): boolean {
        if (!html) return false
        return /resolutionMenu/i.test(html) || /data-src\s*=/i.test(html)
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
            const res = await this.fetchRetry(embedUrl, { headers: { Referer: playUrl }, timeout: 12 })
            if (res.ok && !this.isBlocked(res)) html = res.text()
        } catch (_e) {}
        if (!html) {
            const solved = await this.solveGet(embedUrl)
            if (solved) html = solved
        }
        if (!html) return undefined

        let found = this.matchM3u8(html)
        if (!found) {
            for (const block of this.extractPacked(html)) {
                const unpacked = this.unpack(block)
                if (!unpacked) continue
                const clean = unpacked.replace(/\\/g, "")
                const fromSource = clean.match(/source\s*[:=]\s*['"]?([^'"\s]+\.m3u8[^'"\s]*)/i)
                if (fromSource && fromSource[1]) {
                    found = fromSource[1]
                    break
                }
                const generic = this.matchM3u8(clean)
                if (generic) {
                    found = generic
                    break
                }
            }
        }
        if (found) this.writeCache(ck, found)
        return found
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

    private canonicalOrigin(u: string, fallback: string): string {
        if (!u) return fallback
        const m = u.match(/^(https?:\/\/[^\/?#]+)/i)
        if (!m) return fallback
        return /animepahe/i.test(m[1]) ? m[1].replace(/\/+$/, "") : fallback
    }

    private preferredBase(u: string): string {
        if (!u) return u
        return u.replace(/^https?:\/\/animepahe\.(com|org)\b/i, "https://animepahe.pw")
    }

    private invalidateBase(): void {
        try { $store.set("apahe:base2", { at: 0, host: "" }) } catch (_e) {}
    }

    private async resolveBase(): Promise<string> {
        const all = [this.baseUrl].concat(this.mirrors).map((u) => u.replace(/\/+$/, ""))
        const candidates = all.filter((u, i) => all.indexOf(u) === i)
        const cached = $store.get<{ at: number; host: string }>("apahe:base2")
        const t = this.now()
        if (cached && cached.host && /animepahe/i.test(cached.host) && t > 0 && cached.at > 0 && t - cached.at < this.baseTtl) {
            return this.preferredBase(cached.host)
        }
        let fallback = ""
        for (const c of candidates) {
            try {
                const res = await fetch(`${c}/`, { headers: this.browserHeaders(), timeout: 10 })
                if (res && res.ok) {
                    const canon = this.preferredBase(this.canonicalOrigin(res.url, c))
                    this.absorbCookies(res)
                    $store.set("apahe:base2", { at: this.now(), host: canon })
                    return canon
                }
                if (res && !fallback && (res.status === 403 || res.status === 503)) {
                    fallback = this.preferredBase(this.canonicalOrigin(res.url, c))
                    this.absorbCookies(res)
                }
            } catch (_e) {}
        }
        if (fallback) {
            $store.set("apahe:base2", { at: this.now(), host: fallback })
            return fallback
        }
        return this.preferredBase(candidates[0])
    }

    private async harvestCookies(force: boolean): Promise<string> {
        const cached = $store.get<{ at: number; map: { [k: string]: string } }>("apahe:ck")
        const t = this.now()
        if (!force && cached && cached.map && this.mapSize(cached.map) > 0 && t > 0 && t - cached.at < this.cookieTtl) {
            return this.cookieHeader(cached.map)
        }
        let map = cached && cached.map ? cached.map : {}
        const before = this.cookieHeader(map)
        try {
            const res = await fetch(`${this.baseUrl}/`, { headers: this.browserHeaders(), timeout: 15 })
            map = this.mergeCookieMap(map, this.cookiesFrom(res))
        } catch (_e) {}
        const after = this.cookieHeader(map)
        const at = (after === before && cached && cached.at && cached.at > 0) ? cached.at : this.now()
        $store.set("apahe:ck", { at: at, map })
        return after
    }

    private async getText(url: string, extra?: { [k: string]: string }, valid?: (body: string) => boolean): Promise<string> {
        let cookie = await this.harvestCookies(false)
        let res: FetchResponse | undefined
        for (let i = 0; i < 2; i++) {
            try {
                res = await fetch(url, { headers: this.apiHeaders(cookie, extra), timeout: 10 })
                this.absorbCookies(res)
                this.snapResp(res, url)
                if (!this.isBlocked(res)) {
                    const body = res.text()
                    if (!valid || valid(body)) return body
                }
            } catch (_e) {}
            cookie = await this.harvestCookies(true)
        }
        const solved = await this.solveGet(url)
        if (solved && (!valid || valid(solved))) return solved
        if (!this.solverEndpoint()) throw this.fail("server", "Solver endpoint not set — configure it in the extension settings and run it via Aqua's Utils.")
        const ping = await this.solverPing()
        if (!ping.up) throw this.fail("server", "Aqua's Utils solver isn't reachable at " + this.solverEndpoint() + " — open Aqua's Utils and start it.")
        let why = this.lastSolver && this.lastSolver.reason ? this.lastSolver.reason : ""
        why = why.replace(/^needs-stronger-solver:\s*/i, "")
        this.invalidateBase()
        throw this.fail("fetch", "Connected to the solver (v" + (ping.version || "?") + ") but it couldn't clear the site's protection" + (why ? " — " + why : "") + ".")
    }

    private async solverPing(): Promise<{ up: boolean; version?: string }> {
        const ep = this.solverEndpoint()
        if (!ep) return { up: false }
        const cached = $store.get<{ at: number; up: boolean; version?: string }>("apahe:ping")
        const t = this.now()
        if (cached && t > 0 && cached.at > 0 && t - cached.at < 30000) return { up: cached.up, version: cached.version }
        try {
            const res = await fetch(ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: "sessions.list" }), timeout: 8, noCloudflareBypass: true })
            const up = !!res && res.ok
            let version: string | undefined
            if (up) { try { const d = res.json<any>(); version = d && d.version ? String(d.version) : undefined } catch (_e) {} }
            $store.set("apahe:ping", { at: this.now(), up: up, version: version })
            return { up: up, version: version }
        } catch (_e) {
            $store.set("apahe:ping", { at: this.now(), up: false })
            return { up: false }
        }
    }

    private async getJson<T>(url: string): Promise<T> {
        const text = await this.getText(url, { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" })
        let parsed = this.parseJson<T>(text)
        if (parsed !== undefined) return parsed
        // A non-JSON body where JSON was expected is almost always a bot/ad
        // interstitial that slipped past challenge detection (stale mirror or a
        // flagged IP). Force the solver and re-parse before giving up.
        const solved = await this.solveGet(url)
        if (solved) {
            parsed = this.parseJson<T>(solved)
            if (parsed !== undefined) return parsed
        }
        const diag = this.parseDiag(url)
        this.invalidateBase()
        throw this.fail("parse", diag)
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
                timeout: 60,
                noCloudflareBypass: true,
            })
            if (!res.ok) return undefined
            this.solverDown = false
            return res.json<any>()
        } catch (_e) {
            this.solverDown = true
            return undefined
        }
    }

    private async solveGet(url: string): Promise<string | undefined> {
        const ep = this.solverEndpoint()
        if (!ep) { this.lastSolver = { ran: false, http: 0, snippet: "", reason: "" }; return undefined }
        const data = await this.solverPost(ep, { cmd: "request.get", url, maxTimeout: 32000 })
        const body = data && data.solution ? data.solution.response : undefined
        const http = data && data.solution && typeof data.solution.status === "number" ? data.solution.status : 0
        const reason = data && data.message ? String(data.message) : ""
        this.lastSolver = { ran: true, http: http, snippet: this.snip(body || ""), reason: reason }
        if (body && !this.bodyIsChallenge(body)) return body
        return undefined
    }

    private reportError(scope: string, message: string): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: this.now(), ext: "aq-animepahe-beta", scope: scope, msg: String(message) }))
        } catch (_e) {}
    }

    private fail(scope: string, message: string): Error {
        this.reportError(scope, message)
        return new Error(message)
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
        if (res.ok && this.bodyIsChallenge(res.text())) return true
        return false
    }

    private bodyIsChallenge(body: string): boolean {
        return this.challengeToken(body) !== ""
    }

    private challengeToken(body: string): string {
        if (!body) return ""
        const b = body.toLowerCase()
        const toks = [
            "ddos-guard", "ddg-cookie", "checking your browser", "just a moment",
            "cf-mitigated", "enable javascript and cookies",
            "cf-browser-verification", "oncheqresponse", "onrtbfailure",
        ]
        for (let i = 0; i < toks.length; i++) {
            if (b.indexOf(toks[i]) !== -1) return toks[i]
        }
        return ""
    }

    private snip(s: string): string {
        if (!s) return ""
        return s.replace(/\s+/g, " ").trim().slice(0, 160)
    }

    private snapResp(res: FetchResponse, url: string): void {
        if (!res) return
        let body = ""
        try { body = res.text() } catch (_e) {}
        this.lastResp = {
            url: url,
            status: res.status,
            statusText: res.statusText || "",
            ct: res.contentType || "",
            len: res.contentLength,
            redirected: res.redirected,
            finalUrl: res.url || "",
            snippet: this.snip(body),
            hit: this.challengeToken(body),
        }
    }

    private parseDiag(url: string): string {
        const cb = ($store.get<{ at: number; host: string }>("apahe:base2") || { host: "-" }).host || "-"
        const ck = $store.get<{ at: number; map: { [k: string]: string } }>("apahe:ck")
        const ckSize = ck && ck.map ? this.mapSize(ck.map) : 0
        let ddg = 0
        if (ck && ck.map) {
            for (const k in ck.map) {
                if (/^__ddg/i.test(k)) ddg++
            }
        }
        const r = this.lastResp
        const s = this.lastSolver
        return (
            "expected JSON, got non-JSON from " + url +
            " [base=" + this.baseUrl + " cache=" + cb + "]" +
            " http=" + (r ? r.status + "/" + r.statusText : "?") +
            " ct=" + (r ? r.ct : "?") +
            " len=" + (r ? r.len : "?") +
            " redirected=" + (r ? r.redirected + "->" + r.finalUrl : "?") +
            " ddg=" + ddg + "/" + ckSize +
            " challengeHit=" + (r && r.hit ? r.hit : "none") +
            " solver=" + (s ? (s.ran ? "ran" : "skip") : "skip") +
            " solverHttp=" + (s ? s.http : "-") +
            " solverReason=" + (s && s.reason ? s.reason : "-") +
            " body[" + (r ? r.snippet : "") + "]" +
            " solverBody[" + (s ? s.snippet : "") + "]"
        )
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
