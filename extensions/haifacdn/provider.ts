declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Series = { id: number; title: string; anilist_id?: number | null; audio?: string[] }
type Episode = { id: string; episode: number; stream: string }
type Season = { season: number; episodes?: Episode[] }
type Track = { label?: string; language?: string; default?: boolean; url?: string }

class Provider implements AnimeProvider {
    private base = "https://cdn.lua.locker/v1"
    // ponytail: a series Haifa removes stays listed up to 6 h and then 404s in findEpisodes; search's live q fallback finds new ones
    private libraryTtl = 6 * 3600000

    getSettings(): Settings {
        return { episodeServers: ["Haifa CDN"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const media = opts.media || ({} as Media)
        const id = media.id > 0 ? media.id : 0
        const lib = id ? await this.library() : []
        let picks = lib.filter((s) => s.anilist_id === id)
        if (picks.length === 0 && id) {
            const names = this.titles(media).map((t) => this.titleKey(t))
            picks = lib.filter((s) => !s.anilist_id && names.indexOf(this.titleKey(s.title)) !== -1)
        }
        if (picks.length === 0 && opts.query) {
            const found = (await this.api<{ series?: Series[] }>(`/series?limit=100&q=${encodeURIComponent(opts.query)}`)).series || []
            const season = Math.max(1, ...this.titles(media).map((t) => this.seasonOf(t)))
            picks = found.filter((s) => !id || s.anilist_id === id || (!s.anilist_id && this.seasonOf(s.title) === season))
        }
        if (picks.length === 0 && id) await this.requestMissing(media)
        const audio = opts.dub ? "dub" : "sub"
        return picks
            .filter((s) => !opts.dub || (s.audio || []).some((a) => this.english(a)))
            .map((s) => ({
                id: `${s.id}$${audio}`,
                title: s.title,
                url: `${this.base}/series/${s.id}`,
                subOrDub: (s.audio || []).some((a) => this.english(a)) ? "both" : "sub",
            }))
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const parts = id.split("$")
        const audio = parts.indexOf("dub") !== -1 ? "dub" : "sub"
        const s = await this.api<{ seasons_detail?: Season[] }>(`/series/${encodeURIComponent(parts[0])}`)
        const all = s.seasons_detail || []
        const tag = parts.filter((x) => /^s\d+$/.test(x))[0]
        const want = tag ? parseInt(tag.slice(1), 10) : 0
        const tagged = want ? all.filter((x) => x.season === want) : []
        if (want >= 2 && tagged.length === 0) throw this.fail("episodes", "Haifa CDN: this match was saved by an older version of the extension - match the series again")
        const main = tagged.length ? tagged : all.filter((x) => x.season > 0)
        // ponytail: an entry whose files disagree on their season (seasons > 1) keeps the biggest group's numbers on a clash; the API calls that a data problem
        const groups = (main.length ? main : all).slice().sort((a, b) => (b.episodes || []).length - (a.episodes || []).length)
        const taken: { [n: number]: boolean } = {}
        const eps: Episode[] = []
        for (const g of groups) {
            for (const e of g.episodes || []) {
                if (taken[e.episode]) continue
                taken[e.episode] = true
                eps.push(e)
            }
        }
        return eps.sort((a, b) => a.episode - b.episode).map((e) => ({ id: `${e.id}$${audio}`, number: e.episode, url: e.stream }))
    }

    private async requestMissing(media: Media): Promise<void> {
        const flag = `haifacdn:requested:${media.id}`
        if (this.pref("requestMissing") === "off" || $store.get(flag)) return
        $store.set(flag, true)
        try {
            const auto = this.pref("autoApprove") === "on"
            const mine = (await this.api<{ requests?: { anilist_id?: number; status?: string }[] }>("/requests?limit=100")).requests || []
            if (mine.some((r) => r.anilist_id === media.id && !(auto && r.status === "pending"))) return
            const code = auto ? await this.api<{ code?: string }>("/autogen", {}).then((r) => r.code || "", () => "") : ""
            const res = await this.api<{
                duplicate?: boolean
                request?: { title?: string; already_in_library?: boolean }
                auto_approve?: { approved?: boolean; episodes_queued?: number; reason?: string | null }
            }>("/request", { anilist_id: media.id, note: (code ? code + " " : "") + "Requested from Seanime" })
            const r = res.request || {}
            const aa = res.auto_approve
            if ((aa && aa.approved) || r.already_in_library) $store.remove("haifacdn:library")
            const name = r.title || media.englishTitle || media.romajiTitle || `AniList ${media.id}`
            if (r.already_in_library) this.notice("search", `Haifa CDN: the library has ${name}, but it could not be matched`, "warn")
            else if (aa && aa.approved) this.notice("search", `Haifa CDN: ${name} isn't in the library yet - requested it and it was approved; ${aa.episodes_queued || 0} episodes are downloading`, "info")
            else this.notice("search", `Haifa CDN: ${name} isn't in the library yet - ${res.duplicate ? "added a vote to its request" : "requested it"}${aa && aa.reason ? ` (held for review: ${aa.reason})` : ""}`, "info")
        } catch (_e) {}
    }

    private titles(media: Media): string[] {
        return [media.englishTitle || "", media.romajiTitle || ""].concat(media.synonyms || []).filter((t) => !!t)
    }

    private seasonOf(t: string): number {
        const m = t.match(/\bseason\s*(\d+)\b/i) || t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/i) || t.match(/\bs(\d+)$/i)
        if (m) return parseInt(m[1], 10)
        const r = t.match(/\s(II|III|IV|V|VI)$/)
        return r ? ["II", "III", "IV", "V", "VI"].indexOf(r[1]) + 2 : 1
    }

    private titleKey(t: string): string {
        return `${this.baseTitle(t)}#${this.seasonOf(t)}`
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
        const eng = (t: Track) => this.english(t.language || "")
        let pick = tracks.findIndex((t) => !!t.default && eng(t))
        if (pick < 0) pick = tracks.findIndex((t) => !!t.default)
        if (pick < 0) pick = Math.max(0, tracks.findIndex(eng))
        const subs = tracks.map((t, i) => ({ id: String(i), url: t.url as string, language: (t.label || "").trim() || t.language || "Unknown", isDefault: i === pick }))
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
            for (const r of rows) out.push({ id: r.id, title: r.title, anilist_id: r.anilist_id, audio: r.audio })
            if (rows.length < 100 || out.length >= (page.total || 0)) break
        }
        $store.set("haifacdn:library", { at: Date.now(), data: out })
        return out
    }

    private async api<T>(path: string, body?: object): Promise<T> {
        const key = this.pref("apiKey")
        if (!key) throw this.fail("auth", "Haifa CDN: add your API key in the extension settings")
        const headers: { [k: string]: string } = { Authorization: `Bearer ${key}`, Accept: "application/json" }
        if (body) headers["Content-Type"] = "application/json"
        let res: FetchResponse
        try {
            res = await fetch(this.base + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers })
        } catch (_e) {
            throw this.fail("network", body ? "Haifa CDN: the request could not be sent" : "Haifa CDN: the library could not be reached")
        }
        if (res.ok) return res.json<T>()
        let code = ""
        try {
            code = res.json<{ error?: string }>().error || ""
        } catch (_e) {}
        if (res.status === 401 || res.status === 403) throw this.fail("auth", `Haifa CDN: the API key was refused (${code || res.status}) - check it in the extension settings`)
        if (res.status === 404) throw this.fail("api", "Haifa CDN: not found in the library")
        throw this.fail("api", `Haifa CDN: the library answered HTTP ${res.status}`)
    }

    private pref(name: string): string {
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v.indexOf("{{") === -1) return v.trim()
        } catch (_e) {}
        return ""
    }

    private english(s: string): boolean {
        return /^(en|eng|english)\b/i.test((s || "").trim())
    }

    private notice(scope: string, message: string, lvl: "warn" | "info"): void {
        try {
            console.warn("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-haifacdn", scope: scope, msg: message.replace(/[\u2018\u2019]/g, "'").replace(/[^\x20-\x7e]/g, ""), lvl: lvl }))
        } catch (_e) {}
    }

    private fail(scope: string, message: string): string {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-haifacdn", scope: scope, msg: message }))
        } catch (_e) {}
        return message
    }
}
