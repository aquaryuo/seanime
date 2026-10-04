declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Series = { id: number; title: string; anilist_id?: number | null; audio?: string[]; seasons?: number }
type Episode = { id: string; episode: number; title?: string; stream: string }
type Season = { season: number; episodes?: Episode[] }
type Track = { label?: string; language?: string; default?: boolean; url?: string }

class Provider implements AnimeProvider {
    private base = "https://cdn.lua.locker/v1"
    private libraryTtl = 600000
    private langs: { [code: string]: string } = {
        eng: "English", jpn: "Japanese", spa: "Spanish", por: "Portuguese", fre: "French", fra: "French", ger: "German", deu: "German",
        ita: "Italian", rus: "Russian", ara: "Arabic", chi: "Chinese", zho: "Chinese", kor: "Korean", ind: "Indonesian", may: "Malay",
        msa: "Malay", tha: "Thai", vie: "Vietnamese", fil: "Filipino", tgl: "Filipino", pol: "Polish", tur: "Turkish", hin: "Hindi",
        en: "English", ja: "Japanese", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian", ru: "Russian",
        ar: "Arabic", zh: "Chinese", ko: "Korean", id: "Indonesian", ms: "Malay", th: "Thai", vi: "Vietnamese", tl: "Filipino",
        pl: "Polish", tr: "Turkish", hi: "Hindi",
    }
    private regions: { [code: string]: string } = {
        "419": "Latin America", es: "Spain", mx: "Mexico", br: "Brazil", pt: "Portugal", us: "US", gb: "UK", ca: "Canada", fr: "France",
        sa: "Saudi Arabia", cn: "China", tw: "Taiwan", hk: "Hong Kong", de: "Germany", it: "Italy", ru: "Russia", jp: "Japan",
    }

    getSettings(): Settings {
        return { episodeServers: ["Haifa CDN"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const media = opts.media || ({} as Media)
        const id = media.id > 0 ? media.id : 0
        const lib = id ? await this.library() : []
        let picks: { s: Series; season: number }[] = lib.filter((s) => s.anilist_id === id).map((s) => ({ s, season: 1 }))
        if (picks.length === 0 && id) {
            const season = this.seasonOf(media)
            const names = this.titles(media).map((t) => this.baseTitle(t))
            picks = lib.filter((s) => names.indexOf(this.baseTitle(s.title)) !== -1).map((s) => ({ s, season }))
        }
        if (picks.length === 0 && opts.query) {
            const found = (await this.api<{ series?: Series[] }>(`/series?limit=100&q=${encodeURIComponent(opts.query)}`)).series || []
            const season = id ? this.seasonOf(media) : 0
            for (const s of found) {
                if (id && s.anilist_id) continue
                for (let n = 1; n <= Math.max(1, s.seasons || 1); n++) if (!season || n === season) picks.push({ s, season: n })
            }
        }
        const audio = opts.dub ? "dub" : "sub"
        return picks
            .filter((p) => p.season <= Math.max(1, p.s.seasons || 1))
            .filter((p) => !opts.dub || (p.s.audio || []).some((a) => this.english(a)))
            .map((p) => ({
                id: `${p.s.id}$s${p.season}$${audio}`,
                title: p.s.title + ((p.s.seasons || 1) > 1 ? ` Season ${p.season}` : ""),
                url: `${this.base}/series/${p.s.id}`,
                subOrDub: (p.s.audio || []).some((a) => this.english(a)) ? "both" : "sub",
            }))
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const parts = id.split("$")
        const tag = parts.filter((x) => /^s\d+$/.test(x))[0]
        const want = tag ? parseInt(tag.slice(1), 10) : 1
        const audio = parts.indexOf("dub") !== -1 ? "dub" : "sub"
        const s = await this.api<{ seasons_detail?: Season[] }>(`/series/${encodeURIComponent(parts[0])}`)
        const season = (s.seasons_detail || []).filter((x) => x.season === want)[0]
        const eps = ((season && season.episodes) || []).slice().sort((a, b) => a.episode - b.episode)
        if (eps.length === 0) throw this.fail("episodes", `Haifa CDN: season ${want} of this series isn't in the library yet`)
        return eps.map((e) => ({ id: `${e.id}$${audio}`, number: e.episode, url: e.stream, title: e.title }))
    }

    private titles(media: Media): string[] {
        return [media.englishTitle || "", media.romajiTitle || ""].concat(media.synonyms || []).filter((t) => !!t)
    }

    private seasonOf(media: Media): number {
        for (const t of this.titles(media)) {
            const m = t.match(/\bseason\s*(\d+)\b/i) || t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/i) || t.match(/\bs(\d+)$/i)
            if (m) return parseInt(m[1], 10)
            const r = t.match(/\s(II|III|IV|V|VI)$/)
            if (r) return ["II", "III", "IV", "V", "VI"].indexOf(r[1]) + 2
        }
        return 1
    }

    private baseTitle(t: string): string {
        return (t || "")
            .toLowerCase()
            .replace(/[’']/g, "")
            .replace(/\bseason\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+season\b|\bs\d+$|\s(?:ii|iii|iv|v|vi)$/g, " ")
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const [eid, audio] = episode.id.split("$")
        const e = await this.api<{ stream?: string; audio?: Track[]; subtitles?: Track[] }>(`/episodes/${encodeURIComponent(eid)}`)
        if (!e.stream) throw this.fail("server", "Haifa CDN: this episode has no stream")
        if (audio === "dub" && !(e.audio || []).some((a) => this.english(a.language || a.label || ""))) {
            throw this.fail("server", "Haifa CDN: this episode has no English audio")
        }
        const tracks = (e.subtitles || []).filter((t) => !!t.url)
        const eng = (t: Track) => this.english(t.language || "") && !/forced|signs/i.test(t.label || "")
        let pick = tracks.findIndex((t) => !!t.default && eng(t))
        if (pick < 0) pick = tracks.findIndex((t) => !!t.default)
        if (pick < 0) pick = Math.max(0, tracks.findIndex(eng))
        const variants: { [lang: string]: string[] } = {}
        for (const t of tracks) {
            const c = (t.language || "").toLowerCase().split(/[-_]/)
            if (!c[1]) continue
            const seen = (variants[c[0]] = variants[c[0]] || [])
            if (seen.indexOf(c[1]) === -1) seen.push(c[1])
        }
        const subs = tracks.map((t, i) => ({ id: String(i), url: t.url as string, language: this.trackName(t, variants), isDefault: i === pick }))
        return {
            server: "Haifa CDN",
            headers: {},
            videoSources: [{ url: e.stream, type: "m3u8", quality: "auto", subtitles: subs.filter((t) => t.isDefault).concat(subs.filter((t) => !t.isDefault)) }],
        }
    }

    private trackName(t: Track, variants: { [lang: string]: string[] }): string {
        const label = (t.label || "").trim()
        const code = (t.language || "").toLowerCase().split(/[-_]/)
        const lang = this.langs[code[0]] || ""
        if (!lang) return label || t.language || "Unknown"
        if (code[1]) {
            const extra: string[] = []
            if ((variants[code[0]] || []).length > 1) extra.push(this.regions[code[1]] || code[1].toUpperCase())
            const q = label.toLowerCase().match(/\b(forced|signs & songs|signs|songs|sdh|cc)\b/)
            if (q) extra.push(({ forced: "Forced", "signs & songs": "Signs & Songs", signs: "Signs", songs: "Songs", sdh: "SDH", cc: "CC" } as { [k: string]: string })[q[1]])
            return extra.length ? `${lang} (${extra.join(", ")})` : lang
        }
        if (!label || /^subtitles?\s*\d*$/i.test(label) || label.toLowerCase() === lang.toLowerCase()) return lang
        if (label.toLowerCase().indexOf(lang.toLowerCase()) === 0) return label
        return `${lang} (${label.replace(/\s*\(([^()]*)\)$/, ", $1")})`
    }

    private async library(): Promise<Series[]> {
        const hit = $store.get<{ at: number; data: Series[] }>("haifacdn:library")
        if (hit && Date.now() - hit.at < this.libraryTtl) return hit.data
        const out: Series[] = []
        for (let offset = 0; offset < 5000; offset += 100) {
            const page = await this.api<{ total?: number; series?: Series[] }>(`/series?limit=100&offset=${offset}`)
            const rows = page.series || []
            for (const r of rows) out.push(r)
            if (rows.length < 100 || out.length >= (page.total || 0)) break
        }
        $store.set("haifacdn:library", { at: Date.now(), data: out })
        return out
    }

    private async api<T>(path: string): Promise<T> {
        const key = this.apiKey()
        if (!key) throw this.fail("auth", "Haifa CDN: add your API key in the extension settings")
        let res: FetchResponse
        try {
            res = await fetch(this.base + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })
        } catch (_e) {
            throw this.fail("network", "Haifa CDN: the library could not be reached")
        }
        if (res.ok) return res.json<T>()
        let code = ""
        try {
            code = res.json<{ error?: string }>().error || ""
        } catch (_e) {}
        if (res.status === 401 || res.status === 403) throw this.fail("auth", `Haifa CDN: the API key was refused (${code || res.status}) - check it in the extension settings`)
        if (res.status === 429) throw this.fail("api", "Haifa CDN: too many requests - try again in a minute")
        if (res.status === 404) throw this.fail("api", "Haifa CDN: not found in the library")
        throw this.fail("api", `Haifa CDN: the library answered HTTP ${res.status}`)
    }

    private apiKey(): string {
        try {
            const v = $getUserPreference("apiKey")
            if (typeof v === "string" && v.indexOf("{{") === -1) return v.trim()
        } catch (_e) {}
        return ""
    }

    private english(s: string): boolean {
        return /^(en|eng|english)\b/i.test((s || "").trim())
    }

    private fail(scope: string, message: string): string {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-haifacdn", scope: scope, msg: message }))
        } catch (_e) {}
        return message
    }
}
