declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Series = { id: number; title: string; anilist_id?: number | null; audio?: string[] }
type Episode = { id: string; episode: number; title?: string; stream: string }
type Season = { season: number; episodes?: Episode[] }
type Track = { label?: string; language?: string; default?: boolean; url?: string }

class Provider implements AnimeProvider {
    private base = "https://cdn.lua.locker/v1"
    private libraryTtl = 600000

    getSettings(): Settings {
        return { episodeServers: ["Haifa CDN"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const id = opts.media && opts.media.id > 0 ? opts.media.id : 0
        let hits: Series[] = id ? (await this.library()).filter((s) => s.anilist_id === id) : []
        if (hits.length === 0 && opts.query) {
            const found = await this.api<{ series?: Series[] }>(`/series?limit=100&q=${encodeURIComponent(opts.query)}`)
            hits = (found.series || []).filter((s) => !id || !s.anilist_id || s.anilist_id === id)
        }
        const audio = opts.dub ? "dub" : "sub"
        return hits
            .filter((s) => !opts.dub || (s.audio || []).some((a) => this.english(a)))
            .map((s) => ({
                id: `${s.id}$${audio}`,
                title: s.title,
                url: `${this.base}/series/${s.id}`,
                subOrDub: (s.audio || []).some((a) => this.english(a)) ? "both" : "sub",
            }))
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const [sid, audio] = id.split("$")
        const s = await this.api<{ seasons_detail?: Season[] }>(`/series/${encodeURIComponent(sid)}`)
        let seasons = (s.seasons_detail || []).slice().sort((a, b) => a.season - b.season)
        const main = seasons.filter((x) => x.season > 0)
        if (main.length > 0) seasons = main
        const eps = seasons.reduce((all: Episode[], x) => all.concat((x.episodes || []).slice().sort((a, b) => a.episode - b.episode)), [])
        if (eps.length === 0) throw this.fail("episodes", "Haifa CDN: this series has no episodes yet")
        return eps.map((e, i) => ({
            id: `${e.id}$${audio || "sub"}`,
            number: seasons.length > 1 ? i + 1 : e.episode,
            url: e.stream,
            title: e.title,
        }))
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const [eid, audio] = episode.id.split("$")
        const e = await this.api<{ stream?: string; audio?: Track[]; subtitles?: Track[] }>(`/episodes/${encodeURIComponent(eid)}`)
        if (!e.stream) throw this.fail("server", "Haifa CDN: this episode has no stream")
        if (audio === "dub" && !(e.audio || []).some((a) => this.english(a.language || a.label || ""))) {
            throw this.fail("server", "Haifa CDN: this episode has no English audio")
        }
        const subs = (e.subtitles || [])
            .filter((t) => !!t.url)
            .map((t, i) => ({ id: String(i), url: t.url as string, language: t.label || t.language || "Unknown", isDefault: !!t.default }))
        return {
            server: "Haifa CDN",
            headers: {},
            videoSources: [{ url: e.stream, type: "m3u8", quality: "auto", subtitles: subs.filter((t) => t.isDefault).concat(subs.filter((t) => !t.isDefault)) }],
        }
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
