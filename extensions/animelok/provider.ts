declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type VibeTrack = { url?: string; lang?: string; label?: string; kind?: string; default?: boolean }
type VibeData = { sources?: { url: string }[]; tracks?: VibeTrack[]; headers?: { [key: string]: string } }
type Availability = { exists: boolean; audio: string; subOrDub: SubOrDub; broken?: boolean }
// "badshape" is the one answer the site cannot mean: a 200 whose body is not JSON, or is
// JSON without the `sources` array the player reads from. Absence is a 404 ("notfound")
// and an episode the extractor could not fill is a 500 ("nosource").
type VibeResult = { status: "ok" | "notfound" | "nosource" | "fail" | "badshape"; url: string; tracks: VibeTrack[]; headers: { [key: string]: string } }

class Provider {
    private baseUrl = "{{baseUrl}}"
    private cacheTtl = 900000
    private srcCacheTtl = 300000
    private availFailTtl = 45000

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        let anilistId = opts.media.id
        if (!anilistId || anilistId <= 0) anilistId = this.parseAnilistId(opts.query)
        if (!anilistId || anilistId <= 0) return []
        const av = await this.availability(anilistId, opts.dub)
        // An answer nobody can read is not an absent one, and returning [] for it looks
        // exactly like a title this site does not carry.
        if (av.broken) throw this.fail("search", `animelok: ${this.normBase()} answered for AniList id ${anilistId} in a shape this extension does not understand — the site changed its API; this extension needs an update.`)
        if (!av.exists) return []
        const epCount = opts.media.episodeCount && opts.media.episodeCount > 0 ? opts.media.episodeCount : 0
        const title = opts.media.englishTitle || opts.media.romajiTitle || `Anime ${anilistId}`
        return [
            {
                id: this.encode(anilistId, av.audio, epCount),
                title,
                url: `${this.normBase()}/anime/${anilistId}`,
                subOrDub: av.subOrDub,
            },
        ]
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const meta = this.decode(id)
        if (meta.anilistId <= 0) return []
        // The announced total describes the series, not this site's copy of it, so
        // on its own it invents entries for anything not carried yet and hides any
        // extra. Ask the site; keep the announced figure only for when it cannot
        // answer, which is where it was already being used.
        let count = await this.probeEpisodeCount(meta.anilistId, meta.audio)
        if (count <= 0) count = meta.num
        if (count <= 0) return []
        const episodes: EpisodeDetails[] = []
        for (let n = 1; n <= count; n++) {
            episodes.push({
                id: this.encode(meta.anilistId, meta.audio, n),
                number: n,
                url: `${this.normBase()}/watch/${meta.anilistId}?ep=${n}`,
            })
        }
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this.decode(episode.id)
        const v = await this.getVibe(meta.anilistId, meta.num, meta.audio)
        if (v.status === "ok") {
            return {
                server: server === "Auto" || server === "default" || !server ? "Auto" : server,
                headers: this.streamHeaders(v.headers),
                videoSources: [
                    {
                        url: v.url,
                        type: "m3u8",
                        quality: "auto",
                        subtitles: this.buildSubs(v.tracks),
                    },
                ],
            }
        }
        if (v.status === "notfound") throw this.fail("server", `animelok: episode ${meta.num} is not available on this site`)
        if (v.status === "nosource") throw this.fail("server", `animelok: no source for episode ${meta.num} right now (the site returned an error; try again later)`)
        if (v.status === "badshape") throw this.fail("server", `animelok: the site answered for episode ${meta.num} in a shape this extension does not understand — the site changed its API; this extension needs an update.`)
        throw this.fail("server", `animelok: source temporarily unavailable (failed to extract episode ${meta.num}; try again)`)
    }

    private streamHeaders(apiHeaders: { [key: string]: string }): { [key: string]: string } {
        const out: { [key: string]: string } = {}
        if (apiHeaders) {
            for (const k in apiHeaders) {
                const v = apiHeaders[k]
                if (typeof v === "string" && v) out[k] = v
            }
        }
        if (!out.Referer && !out.referer) out.Referer = `${this.normBase()}/`
        return out
    }

    private buildSubs(tracks: VibeTrack[]): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        if (!tracks || tracks.length === 0) return out
        const seen: { [key: string]: boolean } = {}
        let defaultIdx = -1
        let englishIdx = -1
        for (const t of tracks) {
            if (!t || typeof t.url !== "string" || !/^https?:\/\//i.test(t.url)) continue
            if (t.kind && t.kind !== "captions" && t.kind !== "subtitles") continue
            const lang = (t.lang || t.label || "en").toLowerCase().split("-")[0]
            if (seen[lang]) continue
            seen[lang] = true
            const idx = out.length
            out.push({ id: `${lang}-${idx}`, url: t.url, language: t.label || t.lang || "English", isDefault: false })
            if (defaultIdx === -1 && t.default === true) defaultIdx = idx
            if (englishIdx === -1 && lang === "en") englishIdx = idx
        }
        if (out.length === 0) return out
        const pick = defaultIdx !== -1 ? defaultIdx : englishIdx !== -1 ? englishIdx : 0
        out[pick].isDefault = true
        return out.filter((s) => s.isDefault).concat(out.filter((s) => !s.isDefault))
    }

    private async availability(anilistId: number, wantDub: boolean): Promise<Availability> {
        const cacheKey = `animelok:avail:${anilistId}:${wantDub ? "d" : "s"}`
        const cached = this.readCache<Availability>(cacheKey, this.cacheTtl)
        if (cached) return cached
        const failKey = `animelok:availfail:${anilistId}`
        const negativeCached = this.readCache<Availability>(failKey, this.availFailTtl)
        if (negativeCached) return negativeCached
        const sub = await this.getVibe(anilistId, 1, "sub")
        const dub = await this.getVibe(anilistId, 1, "dub")
        const subOk = sub.status === "ok"
        const dubOk = dub.status === "ok"
        const exists = subOk || dubOk
        let audio: string
        let subOrDub: SubOrDub
        if (exists) {
            audio = wantDub && dubOk ? "dub" : subOk ? "sub" : "dub"
            subOrDub = subOk && dubOk ? "both" : dubOk ? "dub" : "sub"
        } else {
            audio = wantDub ? "dub" : "sub"
            subOrDub = "both"
        }
        const broken = !exists && (sub.status === "badshape" || dub.status === "badshape")
        const result = { exists, audio, subOrDub, broken }
        const definitelyAbsent = sub.status === "notfound" && dub.status === "notfound"
        if (exists || definitelyAbsent) {
            this.writeCache(cacheKey, result)
        } else {
            this.writeCache(failKey, result)
        }
        return result
    }

    private async getVibe(anilistId: number, ep: number, audio: string): Promise<VibeResult> {
        const cacheKey = `animelok:src:${anilistId}:${ep}:${audio}`
        const cached = this.readCache<VibeResult>(cacheKey, this.srcCacheTtl)
        if (cached && cached.status === "ok" && cached.url) return { status: "ok", url: cached.url, tracks: cached.tracks || [], headers: cached.headers || {} }
        for (let i = 0; i < 2; i++) {
            let res: FetchResponse
            try {
                res = await fetch(
                    `${this.normBase()}/api/get-vibeplayer-data?anilistId=${anilistId}&epNum=${ep}&type=${audio}`,
                    { headers: { Referer: `${this.normBase()}/`, Accept: "application/json" }, timeout: 12 }
                )
            } catch (_e) {
                continue
            }
            if (res.status === 404) return { status: "notfound", url: "", tracks: [], headers: {} }
            if (res.status === 500 && this.noSources(res)) return { status: "nosource", url: "", tracks: [], headers: {} }
            if (res.ok) {
                let data: VibeData | undefined
                try {
                    data = res.json<VibeData>()
                } catch (_e) {}
                // Every 200 the site means to send carries a `sources` array — an empty one when
                // it has nothing to offer. A body without one is the API changing shape, which
                // would otherwise reach the user as this episode simply not existing.
                if (!data || !Array.isArray(data.sources)) {
                    this.reportError("parse", `animelok: API returned ${res.status} with no sources list for ${anilistId} ep ${ep} (${audio}) — the site changed its API`)
                    return { status: "badshape", url: "", tracks: [], headers: {} }
                }
                let url = ""
                let tracks: VibeTrack[] = []
                let headers: { [key: string]: string } = {}
                if (data.sources.length > 0 && data.sources[0]) url = data.sources[0].url || ""
                if (data.tracks && data.tracks.length > 0) tracks = data.tracks
                if (data.headers) headers = data.headers
                if (url) {
                    const ok: VibeResult = { status: "ok", url, tracks, headers }
                    this.writeCache(cacheKey, ok)
                    return ok
                }
                return { status: "fail", url: "", tracks: [], headers: {} }
            }
            break
        }
        return { status: "fail", url: "", tracks: [], headers: {} }
    }

    private noSources(res: FetchResponse): boolean {
        try {
            const body = res.json<{ error?: string }>()
            return !!(body && typeof body.error === "string" && /not found|fetching sources/i.test(body.error))
        } catch (_e) {
            return false
        }
    }

    // A transient answer is not an answer: ask again rather than let it move a
    // bound, or one bad moment shortens the list.
    private async probeVibe(anilistId: number, num: number, audio: string): Promise<VibeResult> {
        const first = await this.getVibe(anilistId, num, audio)
        if (first.status === "ok" || first.status === "notfound" || first.status === "nosource") return first
        return await this.getVibe(anilistId, num, audio)
    }

    private async probeEpisodeCount(anilistId: number, audio: string): Promise<number> {
        const cacheKey = `animelok:epcount:${anilistId}:${audio}`
        const cached = this.readCache<number>(cacheKey, this.cacheTtl)
        if (cached !== undefined && cached > 0) return cached
        const first = await this.probeVibe(anilistId, 1, audio)
        if (first.status !== "ok") return 0
        let lo = 1
        let hi = 2
        let bounded = false
        while (hi <= 2048) {
            const v = await this.probeVibe(anilistId, hi, audio)
            if (v.status === "ok") {
                lo = hi
                hi = hi * 2
                continue
            }
            if (v.status === "notfound" || v.status === "nosource") {
                bounded = true
                break
            }
            return lo
        }
        if (!bounded) return lo
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2)
            const v = await this.probeVibe(anilistId, mid, audio)
            if (v.status === "ok") lo = mid
            else if (v.status === "notfound" || v.status === "nosource") hi = mid
            else return lo
        }
        this.writeCache(cacheKey, lo)
        return lo
    }

    private parseAnilistId(query: string): number {
        if (!query) return 0
        const urlMatch = query.match(/anilist\.co\/anime\/(\d+)/i)
        if (urlMatch && urlMatch[1]) return parseInt(urlMatch[1], 10) || 0
        const trimmed = query.trim()
        if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) || 0
        return 0
    }

    private encode(anilistId: number, audio: string, num: number): string {
        return `${anilistId}$${audio}$${num}`
    }

    private decode(id: string): { anilistId: number; audio: string; num: number } {
        const parts = id.split("$")
        const anilistId = parseInt(parts[0] || "0", 10) || 0
        const audio = parts[1] === "dub" ? "dub" : "sub"
        const num = parseInt(parts[2] || "0", 10) || 0
        return { anilistId, audio, num }
    }

    private normBase(): string {
        return this.baseUrl.replace(/animelok\.(online|net|to)/i, "animelok.live").replace(/\/+$/, "")
    }

    private reportError(scope: string, message: string): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: this.now(), ext: "aq-animelok-beta", scope: scope, msg: String(message) }))
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
