declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type VibeTrack = { url?: string; lang?: string; label?: string; kind?: string; default?: boolean }
type VibeData = { sources?: { url: string }[]; tracks?: VibeTrack[]; headers?: { [key: string]: string } }
type Availability = { exists: boolean; audio: string; subOrDub: SubOrDub; broken?: boolean }
type VibeResult = { status: "ok" | "notfound" | "nosource" | "fail" | "badshape"; url: string; tracks: VibeTrack[]; headers: { [key: string]: string } }

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "{{baseUrl}}", "https://animelok.live")
    private base = this.baseUrl.replace(/animelok\.(online|net|to)/i, "animelok.live").replace(/\/+$/, "")
    private cacheTtl = 900000
    private srcCacheTtl = 300000
    private availFailTtl = 45000

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
        const av = await this.availability(anilistId, opts.dub)
        if (av.broken) throw this.fail("search", `animelok: ${this.base} answered for AniList id ${anilistId} in a shape this extension does not understand — the site changed its API; this extension needs an update.`)
        if (!av.exists) return []
        const epCount = opts.media.episodeCount && opts.media.episodeCount > 0 ? opts.media.episodeCount : 0
        const title = opts.media.englishTitle || opts.media.romajiTitle || `Anime ${anilistId}`
        return [
            {
                id: this.encode(anilistId, av.audio, epCount),
                title,
                url: `${this.base}/anime/${anilistId}`,
                subOrDub: av.subOrDub,
            },
        ]
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const meta = this.decode(id)
        if (meta.anilistId <= 0) return []
        let count = await this.probeEpisodeCount(meta.anilistId, meta.audio)
        if (count <= 0) count = meta.num
        if (count <= 0) return []
        const episodes: EpisodeDetails[] = []
        for (let n = 1; n <= count; n++) {
            episodes.push({
                id: this.encode(meta.anilistId, meta.audio, n),
                number: n,
                url: `${this.base}/watch/${meta.anilistId}?ep=${n}`,
            })
        }
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this.decode(episode.id)
        const v = await this.getVibe(meta.anilistId, meta.num, meta.audio)
        if (v.status === "ok") {
            return {
                server: "Auto",
                headers: Object.assign({ Referer: `${this.base}/` }, v.headers),
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

    private cfg(name: string, raw: string, fallback: string): string {
        if (raw && raw.indexOf("{{") === -1) return raw
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
    }

    private safeHeaders(apiHeaders: { [key: string]: string }): { [key: string]: string } {
        const allow: { [key: string]: string } = { referer: "Referer", origin: "Origin", "user-agent": "User-Agent" }
        const out: { [key: string]: string } = {}
        for (const k in apiHeaders) {
            const name = allow[String(k).toLowerCase()]
            const v = apiHeaders[k]
            if (!name || typeof v !== "string" || !v || v.length > 512) continue
            if (/[\r\n]/.test(v)) continue
            out[name] = v
        }
        return out
    }

    private buildSubs(tracks: VibeTrack[]): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const seen: { [key: string]: boolean } = {}
        const nonDialogue: boolean[] = []
        let pick = 0
        let best = -1
        for (const t of tracks) {
            if (!t || typeof t.url !== "string" || !/^https?:\/\//i.test(t.url)) continue
            if (t.kind && t.kind !== "captions" && t.kind !== "subtitles") continue
            if (seen["#" + t.url]) continue
            seen["#" + t.url] = true
            const label = (t.label || "").trim()
            const code = this.subCode(t.lang || "", label)
            const idx = out.length
            out.push({ id: `${code}-${idx}`, url: t.url, language: label || this.langName(code), isDefault: false })
            const nd = this.isNonDialogue(label)
            nonDialogue.push(nd)
            const score = this.trackScore(label, code === "en", t.default === true, nd)
            if (score > best) {
                best = score
                pick = idx
            }
        }
        if (out.length === 0) return out
        out[pick].isDefault = true
        return [out[pick]].concat(out.filter((_, i) => i !== pick && !nonDialogue[i]), out.filter((_, i) => i !== pick && nonDialogue[i]))
    }

    private subCode(lang: string, label: string): string {
        const raw = (lang || "").toLowerCase().split("-")[0]
        if (raw && raw.length <= 3 && /^[a-z]+$/.test(raw) && raw !== "und") {
            if (raw === "en" || raw === "eng") return "en"
            if (raw.length === 2) return raw
        }
        const words = (raw || label || "").toLowerCase().split(/[^a-z]+/)
        const map: { [key: string]: string } = {
            eng: "en", english: "en",
            spa: "es", spanish: "es", espanol: "es",
            por: "pt", portuguese: "pt", portugues: "pt",
            fre: "fr", fra: "fr", french: "fr", francais: "fr",
            ger: "de", deu: "de", german: "de", deutsch: "de",
            ita: "it", italian: "it", italiano: "it",
            rus: "ru", russian: "ru",
            ara: "ar", arabic: "ar",
            jpn: "ja", japanese: "ja",
            kor: "ko", korean: "ko",
            chi: "zh", zho: "zh", chinese: "zh",
            tha: "th", thai: "th",
            vie: "vi", vietnamese: "vi",
            tur: "tr", turkish: "tr",
            pol: "pl", polish: "pl",
            ind: "id", indonesian: "id",
            hin: "hi", hindi: "hi",
        }
        for (const w of words) if (map[w]) return map[w]
        return raw || "und"
    }

    private langName(code: string): string {
        const map: { [key: string]: string } = {
            en: "English", ja: "Japanese", ar: "Arabic", de: "German", es: "Spanish", fr: "French",
            it: "Italian", ru: "Russian", pt: "Portuguese", hi: "Hindi", id: "Indonesian",
            ko: "Korean", zh: "Chinese", th: "Thai", vi: "Vietnamese", tr: "Turkish", pl: "Polish", nl: "Dutch",
        }
        const c = (code || "").toLowerCase()
        return map[c] || map[c.split("-")[0]] || (c ? c.toUpperCase() : "Unknown")
    }

    private isNonDialogue(label: string): boolean {
        const l = label || ""
        if (/\b(?:full|dialogu?e|dialog|main|complete)\b/i.test(l)) return false
        return /\b(?:forced|forc[eé]s|signs?|songs?|karaoke|kfx|typeset(?:ting)?|commentary)\b/i.test(l) || /\bs\s*[&+\/]\s*s\b/i.test(l) || /\bop\s*[\/&+]\s*ed\b/i.test(l)
    }

    private trackScore(label: string, isEnglish: boolean, def: boolean, nd: boolean): number {
        const base = nd ? (isEnglish ? 3 : 0) : /\b(?:ai|mtl)\b/i.test(label) ? (isEnglish ? 4 : 1) : /\b(?:sdh|cc|closed[\s-]?captions?|hearing[\s-]?impaired|dub[\s-]?titles?)\b/i.test(label) ? (isEnglish ? 5 : 1) : isEnglish ? 6 : 2
        return def ? base * 10 + 1 : base * 10
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
        const audio = wantDub && dubOk ? "dub" : subOk ? "sub" : "dub"
        const subOrDub: SubOrDub = subOk && dubOk ? "both" : dubOk ? "dub" : "sub"
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
        if (cached) return cached
        for (let i = 0; i < 2; i++) {
            let res: FetchResponse
            try {
                res = await fetch(
                    `${this.base}/api/get-vibeplayer-data?anilistId=${anilistId}&epNum=${ep}&type=${audio}`,
                    { headers: { Referer: `${this.base}/`, Accept: "application/json" } }
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
                if (!data || !Array.isArray(data.sources)) {
                    this.reportError("parse", `animelok: API returned ${res.status} with no sources list for ${anilistId} ep ${ep} (${audio}) — the site changed its API`)
                    return { status: "badshape", url: "", tracks: [], headers: {} }
                }
                const raw = (data.sources[0] && data.sources[0].url) || ""
                if (!/^https?:\/\//i.test(raw)) return { status: "fail", url: "", tracks: [], headers: {} }
                const ok: VibeResult = { status: "ok", url: raw, tracks: data.tracks && data.tracks.length > 0 ? data.tracks : [], headers: this.safeHeaders(data.headers || {}) }
                this.writeCache(cacheKey, ok)
                return ok
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
        for (; hi <= 2048; hi *= 2) {
            const v = await this.probeVibe(anilistId, hi, audio)
            if (v.status === "notfound" || v.status === "nosource") break
            if (v.status !== "ok") return lo
            lo = hi
        }
        if (hi > 2048) return lo
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
        const m = (query || "").match(/anilist\.co\/anime\/(\d+)/i) || (query || "").trim().match(/^(\d+)$/)
        return m ? parseInt(m[1], 10) : 0
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

    private reportError(scope: string, message: string): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-animelok", scope: scope, msg: this.plain(message) }))
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
