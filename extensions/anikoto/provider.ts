class Provider {
    private baseUrl = "{{baseUrl}}"
    private mirrors = ["https://anikototv.to", "https://anikoto.cz", "https://anikoto.me", "https://anikoto.net", "https://anikototv.se"]

    private async resolveBase(): Promise<string> {
        const all = [this.baseUrl].concat(this.mirrors).map((u) => u.replace(/\/+$/, ""))
        const candidates = all.filter((u, idx) => all.indexOf(u) === idx)
        if (candidates.length === 1) return candidates[0]
        const cached = $store.get<string>("anikoto:base")
        if (cached && candidates.indexOf(cached) !== -1) return cached
        for (const c of candidates) {
            try {
                const res = await fetch(c, { method: "HEAD", timeout: 8 })
                if (res.ok) {
                    $store.set("anikoto:base", c)
                    return c
                }
            } catch (_e) {}
        }
        return candidates[0]
    }

    private pageHeaders(): { [key: string]: string } {
        return { Referer: `${this.baseUrl}/` }
    }

    private ajaxHeaders(): { [key: string]: string } {
        return { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest" }
    }

    getSettings(): Settings {
        return {
            episodeServers: ["Auto", "HD-1", "Vidstream-2", "VidCloud-1"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        this.baseUrl = await this.resolveBase()
        const url = `${this.baseUrl}/filter?keyword=${encodeURIComponent(opts.query)}`
        const res = await fetch(url, { headers: this.pageHeaders() })
        if (!res.ok) throw new Error(`search failed: status ${res.status}`)

        const $ = LoadDoc(res.text())
        const results: SearchResult[] = []

        $("div.item").each((_i, card) => {
            const titleLink = card.find("a.name.d-title").first()
            if (titleLink.length() === 0) return

            const href = titleLink.attr("href") || card.find(".ani.poster.tip a").first().attr("href")
            if (!href) return
            const seriesUrl = this.seriesUrl(href)

            const title = (
                titleLink.text() ||
                titleLink.attr("data-jp") ||
                card.find("img").first().attr("alt") ||
                ""
            ).trim()
            if (!title) return

            const hasSub = card.find(".ep-status.sub").length() > 0
            const hasDub = card.find(".ep-status.dub").length() > 0
            if (opts.dub && !hasDub) return
            const subOrDub: SubOrDub = hasSub && hasDub ? "both" : hasDub ? "dub" : "sub"
            const audio = opts.dub ? "dub" : "sub"

            results.push({ id: this.withAudio(seriesUrl, audio), title, url: seriesUrl, subOrDub })
        })

        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this.baseUrl = await this.resolveBase()
        const parsed = this.splitAudio(id)
        const audio = parsed.audio
        const seriesUrl = this.seriesUrl(this.absoluteUrl(parsed.base))

        const page = await fetch(seriesUrl, { headers: this.pageHeaders() })
        if (!page.ok) throw new Error(`findEpisodes failed: status ${page.status}`)

        const seriesId = LoadDoc(page.text())("#watch-main").first().attr("data-id")
        if (!seriesId) throw new Error("Could not determine series id (#watch-main[data-id]).")

        const listRes = await fetch(`${this.baseUrl}/ajax/episode/list/${seriesId}`, {
            headers: this.ajaxHeaders(),
        })
        if (!listRes.ok) throw new Error(`episode list failed: status ${listRes.status}`)
        const listJson = listRes.json<{ status: number; result: string }>()
        if (!listJson || !listJson.result) throw new Error("Empty episode list response.")

        const $ = LoadDoc(listJson.result)
        const episodes: EpisodeDetails[] = []
        const seen: { [key: string]: boolean } = {}

        $("ul.ep-range li > a").each((i, a) => {
            const epId = a.attr("data-id") || ""
            const dataIds = a.attr("data-ids")
            if (!dataIds) return

            const dedupeKey = epId || dataIds
            if (seen[dedupeKey]) return
            seen[dedupeKey] = true

            const num = parseInt(a.attr("data-num") || "", 10)
            const number = isNaN(num) ? i + 1 : num
            const slug = a.attr("data-slug") || String(number)

            const title = a.find("span.d-title").first().text().trim()

            episodes.push({
                id: this.withAudio(dataIds, audio),
                number,
                url: `${seriesUrl}/ep-${slug}`,
                title: title || undefined,
            })
        })

        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort((x, y) => x.number - y.number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        this.baseUrl = await this.resolveBase()
        const parsed = this.splitAudio(episode.id)
        const dataIds = parsed.base
        const audio = parsed.audio

        const slRes = await fetch(
            `${this.baseUrl}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`,
            { headers: this.ajaxHeaders() }
        )
        if (!slRes.ok) throw new Error(`server list failed: status ${slRes.status}`)
        const $ = LoadDoc(slRes.json<{ status: number; result: string }>().result || "")

        const groups = audio === "dub" ? ["dub"] : ["hsub"]
        const candidates = this.collectServers($, groups)
        if (candidates.length === 0) throw new Error("Server not available for this episode.")

        if (server === "Auto" || server === "default" || !server) {
            let firstResolved: EpisodeServer | undefined
            for (const c of candidates) {
                let resolved: EpisodeServer | undefined
                try {
                    resolved = await this.resolveServer(c.linkId, c.name)
                } catch (_e) {
                    resolved = undefined
                }
                if (!resolved) continue
                if (!firstResolved) firstResolved = resolved
                if (await this.isPlayable(resolved)) return resolved
            }
            if (firstResolved) return firstResolved
            throw new Error("No playable server found for this episode.")
        }

        const picked = candidates.filter((c) => c.name === server)[0]
        if (!picked) throw new Error("Server not available for this episode.")
        return this.resolveServer(picked.linkId, picked.name)
    }

    private collectServers($: DocSelectionFunction, groups: string[]): { name: string; linkId: string }[] {
        const out: { name: string; linkId: string }[] = []
        const seen: { [key: string]: boolean } = {}
        for (const t of groups) {
            $(`.servers .type[data-type="${t}"] li[data-link-id]`).each((_i, el) => {
                const linkId = el.attr("data-link-id")
                const name = el.text().trim()
                if (!linkId || !name || seen[name]) return
                seen[name] = true
                out.push({ name, linkId })
            })
        }
        return out
    }

    private async resolveServer(linkId: string, serverName: string): Promise<EpisodeServer> {
        const psRes = await fetch(`${this.baseUrl}/ajax/server?get=${encodeURIComponent(linkId)}`, {
            headers: this.ajaxHeaders(),
        })
        if (!psRes.ok) throw new Error(`server resolve failed: status ${psRes.status}`)
        const ps = psRes.json<{ status: number; result: { url: string } }>()
        const embedUrl = ps && ps.result ? ps.result.url : undefined
        if (!embedUrl) throw new Error("Could not resolve the player URL.")
        return this.extractMegaplay(embedUrl, serverName)
    }

    private async isPlayable(server: EpisodeServer): Promise<boolean> {
        const src = server.videoSources[0]
        if (!src || !src.url) return false
        try {
            const res = await fetch(src.url, { headers: server.headers, timeout: 10 })
            if (!res.ok) return false
            return res.text().indexOf("#EXTM3U") !== -1
        } catch (_e) {
            return false
        }
    }

    private async extractMegaplay(embedUrl: string, serverName: string): Promise<EpisodeServer> {
        const origin = this.originOf(embedUrl)

        const embedRes = await fetch(embedUrl, { headers: { Referer: `${this.baseUrl}/` } })
        if (!embedRes.ok) throw new Error(`embed fetch failed: status ${embedRes.status}`)

        const dataId = LoadDoc(embedRes.text())("#megaplay-player").first().attr("data-id")
        if (!dataId) throw new Error("Could not find #megaplay-player[data-id] in embed.")

        const srcRes = await fetch(`${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`, {
            headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" },
        })
        if (!srcRes.ok) throw new Error(`getSources failed: status ${srcRes.status}`)
        const data = srcRes.json<{ sources: { file: string } | { file: string }[] }>()

        const file = Array.isArray(data.sources) ? (data.sources[0] || ({} as any)).file : data.sources.file
        if (!file) throw new Error("getSources returned no video file.")

        const subtitles: VideoSubtitle[] = []

        return {
            server: serverName,
            headers: { Referer: `${origin}/`, Origin: origin },
            videoSources: [
                {
                    url: file,
                    type: "m3u8",
                    quality: "default",
                    subtitles,
                },
            ],
        }
    }

    private withAudio(base: string, audio: string): string {
        return `${base}$${audio}`
    }

    private splitAudio(id: string): { base: string; audio: string } {
        const i = id.lastIndexOf("$")
        if (i !== -1) {
            const a = id.slice(i + 1)
            if (a === "sub" || a === "dub") return { base: id.slice(0, i), audio: a }
        }
        return { base: id, audio: "sub" }
    }

    private seriesUrl(href: string): string {
        let u = this.absoluteUrl(href)
        const q = u.indexOf("?")
        if (q !== -1) u = u.slice(0, q)
        const h = u.indexOf("#")
        if (h !== -1) u = u.slice(0, h)
        return u.replace(/\/ep-[^/]+\/?$/i, "")
    }

    private absoluteUrl(u: string): string {
        if (!u) return u
        if (u.indexOf("http://") === 0 || u.indexOf("https://") === 0) return u
        if (u.indexOf("//") === 0) return `https:${u}`
        if (u.charAt(0) === "/") return `${this.baseUrl}${u}`
        return `${this.baseUrl}/${u}`
    }

    private originOf(u: string): string {
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.baseUrl
    }
}
