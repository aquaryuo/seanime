class Provider {
    private baseUrl = "{{baseUrl}}"
    private cacheTtl = 900000
    private srcCacheTtl = 300000

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const anilistId = opts.media.id
        if (!anilistId || anilistId <= 0) return []
        const av = await this.availability(anilistId, opts.dub)
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
        const count = meta.num
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
                headers: {},
                videoSources: [
                    {
                        url: v.url,
                        type: "m3u8",
                        quality: "auto",
                        subtitles: [],
                    },
                ],
            }
        }
        if (v.status === "notfound") throw `animelok: episode ${meta.num} is not available on this site`
        throw `animelok: source temporarily unavailable (failed to extract episode ${meta.num}; try again)`
    }

    private async availability(anilistId: number, wantDub: boolean): Promise<{ exists: boolean; audio: string; subOrDub: SubOrDub }> {
        const cacheKey = `animelok:avail:${anilistId}`
        const cached = this.readCache<{ exists: boolean; audio: string; subOrDub: SubOrDub }>(cacheKey, this.cacheTtl)
        if (cached) return cached
        const sub = await this.getVibe(anilistId, 1, "sub")
        const dub = await this.getVibe(anilistId, 1, "dub")
        const subOk = sub.status === "ok"
        const dubOk = dub.status === "ok"
        const exists = sub.status !== "notfound" || dub.status !== "notfound"
        let audio: string
        let subOrDub: SubOrDub
        if (subOk || dubOk) {
            audio = wantDub && dubOk ? "dub" : subOk ? "sub" : "dub"
            subOrDub = subOk && dubOk ? "both" : dubOk ? "dub" : "sub"
        } else {
            audio = wantDub ? "dub" : "sub"
            subOrDub = "both"
        }
        const result = { exists, audio, subOrDub }
        if (subOk || dubOk || sub.status === "notfound" || dub.status === "notfound") this.writeCache(cacheKey, result)
        return result
    }

    private async getVibe(anilistId: number, ep: number, audio: string): Promise<{ status: "ok" | "notfound" | "fail"; url: string }> {
        const cacheKey = `animelok:src:${anilistId}:${ep}:${audio}`
        const cached = this.readCache<{ status: "ok"; url: string }>(cacheKey, this.srcCacheTtl)
        if (cached && cached.status === "ok" && cached.url) return cached
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
            if (res.status === 404) return { status: "notfound", url: "" }
            if (res.ok) {
                let url = ""
                try {
                    const data = res.json<{ sources?: { url: string }[] }>()
                    if (data && data.sources && data.sources.length > 0 && data.sources[0]) url = data.sources[0].url || ""
                } catch (_e) {}
                if (url) {
                    const ok: { status: "ok"; url: string } = { status: "ok", url }
                    this.writeCache(cacheKey, ok)
                    return ok
                }
                return { status: "fail", url: "" }
            }
        }
        return { status: "fail", url: "" }
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
        return this.baseUrl.replace(/\/+$/, "")
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
