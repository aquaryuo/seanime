declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type LokServer = { source?: string; url?: string }
type Embed = { status: "ok" | "notfound" | "badshape" | "fail"; origin: string; hash: string; why: string }

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "{{baseUrl}}", "https://animelok.cc")
    private base = this.baseUrl.replace(/animelok\.(online|net|to|live|xyz)/i, "animelok.cc").replace(/\/+$/, "")
    private cacheTtl = 900000
    private srcCacheTtl = 300000

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        let anilistId = opts.media.id
        if (!anilistId || anilistId <= 0) anilistId = this.parseAnilistId(opts.query)
        if (!anilistId || anilistId <= 0) {
            const q = (opts.query || "").trim()
            if (q && !/^\d+$/.test(q)) throw this.fail("search", "animelok matches by AniList id — paste the anilist.co URL or its numeric id instead of a title")
            return []
        }
        if (!opts.dub) return []
        const first = await this.probe(anilistId, 1)
        if (first.status === "badshape") throw this.fail("search", `animelok: ${this.base} answered for AniList id ${anilistId} in a shape this extension does not understand — the site changed its API; this extension needs an update.`)
        if (first.status === "fail") throw this.fail("search", `animelok: search failed - the site ${first.why}`)
        if (first.status !== "ok") return []
        const epCount = opts.media.episodeCount && opts.media.episodeCount > 0 ? opts.media.episodeCount : 0
        const title = opts.media.englishTitle || opts.media.romajiTitle || `Anime ${anilistId}`
        return [
            {
                id: this.encode(anilistId, epCount),
                title,
                url: `${this.base}/watch/${anilistId}`,
                subOrDub: "dub",
            },
        ]
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const meta = this.decode(id)
        if (meta.anilistId <= 0) return []
        let count = await this.probeEpisodeCount(meta.anilistId)
        if (count <= 0) count = meta.num
        if (count <= 0) return []
        const episodes: EpisodeDetails[] = []
        for (let n = 1; n <= count; n++) {
            episodes.push({
                id: this.encode(meta.anilistId, n),
                number: n,
                url: `${this.base}/watch/${meta.anilistId}?ep=${n}`,
            })
        }
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this.decode(episode.id)
        const e = await this.probe(meta.anilistId, meta.num)
        if (e.status === "notfound") throw this.fail("server", `animelok: episode ${meta.num} has no multi-language dub on this site`, "info")
        if (e.status === "badshape") throw this.fail("server", `animelok: the site answered for episode ${meta.num} in a shape this extension does not understand — the site changed its API; this extension needs an update.`)
        if (e.status !== "ok") throw this.fail("server", `animelok: episode ${meta.num} lookup failed - the site ${e.why}`)
        const url = await this.video(e.origin, e.hash)
        return {
            server: "Auto",
            headers: { Referer: `${e.origin}/` },
            videoSources: [{ url, type: "m3u8", quality: "auto", subtitles: [] }],
        }
    }

    private cfg(name: string, raw: string, fallback: string): string {
        if (raw && raw.indexOf("{{") === -1) return raw
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
    }

    private async embed(anilistId: number, ep: number): Promise<Embed> {
        const cacheKey = `animelok:embed:${anilistId}:${ep}`
        const cached = this.readCache<Embed>(cacheKey, this.srcCacheTtl)
        if (cached) return cached
        let res: FetchResponse
        try {
            res = await fetch(`${this.base}/api/anilist/${anilistId}/${ep}`, { headers: { Referer: `${this.base}/watch/${anilistId}`, Accept: "application/json" } })
        } catch (e) {
            return { status: "fail", origin: "", hash: "", why: this.net(e) }
        }
        if (res.status === 404) return { status: "notfound", origin: "", hash: "", why: "" }
        if (!res.ok) return { status: "fail", origin: "", hash: "", why: `answered HTTP ${res.status}` }
        let data: { servers?: LokServer[] } | undefined
        try {
            data = res.json<{ servers?: LokServer[] }>()
        } catch (_e) {}
        if (!data || !Array.isArray(data.servers)) return { status: "badshape", origin: "", hash: "", why: "" }
        let out: Embed = { status: "notfound", origin: "", hash: "", why: "" }
        for (const s of data.servers) {
            const m = s && s.source === "animesalt" && typeof s.url === "string" ? s.url.match(/^(https:\/\/[^/?#]+)\/video\/([A-Za-z0-9]+)$/) : null
            if (m) {
                out = { status: "ok", origin: m[1], hash: m[2], why: "" }
                break
            }
        }
        this.writeCache(cacheKey, out)
        return out
    }

    private async probe(anilistId: number, ep: number): Promise<Embed> {
        const first = await this.embed(anilistId, ep)
        return first.status === "fail" ? await this.embed(anilistId, ep) : first
    }

    private async video(origin: string, hash: string): Promise<string> {
        const cacheKey = `animelok:video:${hash}`
        const cached = this.readCache<string>(cacheKey, this.srcCacheTtl)
        if (cached) return cached
        const host = origin.replace(/^https:\/\//, "")
        let res: FetchResponse
        try {
            res = await fetch(`${origin}/player/index.php?data=${hash}&do=getVideo`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: `${origin}/video/${hash}`, Origin: origin },
                body: `hash=${hash}&r=${encodeURIComponent(this.base + "/")}`,
            })
        } catch (e) {
            throw this.fail("server", `animelok: the ${host} player ${this.net(e)}`)
        }
        if (!res.ok) throw this.fail("server", `animelok: the ${host} player answered HTTP ${res.status}`)
        let data: { securedLink?: string; videoSource?: string } | undefined
        try {
            data = res.json<{ securedLink?: string; videoSource?: string }>()
        } catch (_e) {}
        const url = (data && (data.securedLink || data.videoSource)) || ""
        if (!/^https:\/\//i.test(url)) throw this.fail("server", `animelok: the ${host} player answered without a stream link - this extension needs an update`)
        this.writeCache(cacheKey, url)
        return url
    }

    private net(e: unknown): string {
        const m = String(e instanceof Error ? e.message : (e && (e as any).message) || e).replace(/^\w+ "[^"]*": /, "")
        if (/did not answer in time|timed? ?out|deadline exceeded/i.test(m)) return "did not answer in time"
        if (/could not be found|cannot resolve|no such host|ENOTFOUND|EAI_AGAIN/i.test(m)) return "could not be found (DNS)"
        if (/TLS|SSL|certificate|x509/i.test(m)) return "failed the TLS handshake"
        return `could not be reached (${m.slice(0, 120)})`
    }

    private async probeEpisodeCount(anilistId: number): Promise<number> {
        const cacheKey = `animelok:epcount:${anilistId}`
        const cached = this.readCache<number>(cacheKey, this.cacheTtl)
        if (cached !== undefined && cached > 0) return cached
        const first = await this.probe(anilistId, 1)
        if (first.status !== "ok") return 0
        let lo = 1
        let hi = 2
        for (; hi <= 2048; hi *= 2) {
            const v = await this.probe(anilistId, hi)
            if (v.status === "notfound") break
            if (v.status !== "ok") return lo
            lo = hi
        }
        if (hi > 2048) return lo
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2)
            const v = await this.probe(anilistId, mid)
            if (v.status === "ok") lo = mid
            else if (v.status === "notfound") hi = mid
            else return lo
        }
        this.writeCache(cacheKey, lo)
        return lo
    }

    private parseAnilistId(query: string): number {
        const m = (query || "").match(/anilist\.co\/anime\/(\d+)/i) || (query || "").trim().match(/^(\d+)$/)
        return m ? parseInt(m[1], 10) : 0
    }

    private encode(anilistId: number, num: number): string {
        return `${anilistId}$dub$${num}`
    }

    private decode(id: string): { anilistId: number; num: number } {
        const parts = id.split("$")
        return { anilistId: parseInt(parts[0] || "0", 10) || 0, num: parseInt(parts[2] || "0", 10) || 0 }
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-animelok", scope: scope, msg: this.plain(message), lvl: lvl })
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
}
