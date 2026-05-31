class Provider {
    private baseUrl = "{{baseUrl}}"
    private mirrors = ["https://anikototv.to", "https://anikoto.cz", "https://anikoto.me", "https://anikoto.net", "https://anikototv.se"]
    private cacheTtl = 900000
    private serverCacheTtl = 300000
    private subEndpoint = "https://sub.ryuo.to"

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

    private firstAttr($: DocSelectionFunction, selectors: string[], attr: string): string {
        for (const sel of selectors) {
            const v = $(sel).first().attr(attr)
            if (v) return v
        }
        return ""
    }

    getSettings(): Settings {
        return {
            episodeServers: [
                "Auto",
                "HD-1",
                "Vidstream-2",
                "VidCloud-1",
                "HS: HD-1",
                "HS: Vidstream-2",
                "HS: VidCloud-1",
            ],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        this.baseUrl = await this.resolveBase()
        const audio = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)

        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}
        let anyOk = false

        for (const q of queries) {
            let html = ""
            try {
                const res = await fetch(`${this.baseUrl}/filter?keyword=${encodeURIComponent(q)}`, {
                    headers: this.pageHeaders(),
                })
                if (res.ok) {
                    anyOk = true
                    html = res.text()
                }
            } catch (_e) {
                html = ""
            }
            if (html) this.parseSearchInto(LoadDoc(html), audio, opts.dub, opts.media.id, seen, results)
        }

        if (!anyOk) throw new Error("search failed")
        return results
    }

    private searchQueries(opts: SearchOptions): string[] {
        const raw = [opts.query, opts.media.romajiTitle, opts.media.englishTitle]
        const out: string[] = []
        const seen: { [key: string]: boolean } = {}
        for (const t of raw) {
            const q = (t || "").trim()
            if (!q) continue
            const key = q.toLowerCase()
            if (seen[key]) continue
            seen[key] = true
            out.push(q)
        }
        return out
    }

    private parseSearchInto(
        $: DocSelectionFunction,
        audio: string,
        dub: boolean,
        anilistId: number,
        seen: { [key: string]: boolean },
        results: SearchResult[]
    ): void {
        $("div.item").each((_i, card) => {
            const titleLink = card.find("a.name.d-title").first()
            if (titleLink.length() === 0) return

            const href = titleLink.attr("href") || card.find(".ani.poster.tip a").first().attr("href")
            if (!href) return
            const seriesUrl = this.seriesUrl(href)
            if (seen[seriesUrl]) return

            const title = (
                titleLink.text() ||
                titleLink.attr("data-jp") ||
                card.find("img").first().attr("alt") ||
                ""
            ).trim()
            if (!title) return

            const hasSub = card.find(".ep-status.sub").length() > 0
            const hasDub = card.find(".ep-status.dub").length() > 0
            if (dub && !hasDub) return

            seen[seriesUrl] = true
            const subOrDub: SubOrDub = hasSub && hasDub ? "both" : hasDub ? "dub" : "sub"
            results.push({ id: this.withMeta(seriesUrl, audio, anilistId), title, url: seriesUrl, subOrDub })
        })
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this.baseUrl = await this.resolveBase()
        const parsed = this.splitMeta(id)
        const audio = parsed.audio
        const seriesUrl = this.seriesUrl(this.absoluteUrl(parsed.base))

        const cacheKey = `anikoto:eps:${seriesUrl}:${audio}:${parsed.anilistId}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        const page = await this.fetchRetry(seriesUrl, { headers: this.pageHeaders() })
        if (!page.ok) throw new Error(`findEpisodes failed: status ${page.status}`)

        const pageHtml = page.text()
        let seriesId = this.firstAttr(LoadDoc(pageHtml), ["#watch-main", "[id*='watch'][data-id]", "main [data-id]"], "data-id")
        if (!seriesId) {
            const m = pageHtml.match(/data-id="(\d+)"/)
            if (m) seriesId = m[1]
        }
        if (!seriesId) throw new Error("Could not determine series id (#watch-main[data-id]).")

        const listRes = await this.fetchRetry(`${this.baseUrl}/ajax/episode/list/${seriesId}`, {
            headers: this.ajaxHeaders(),
        })
        if (!listRes.ok) throw new Error(`episode list failed: status ${listRes.status}`)
        const listJson = listRes.json<{ status: number; result: string }>()
        if (!listJson || !listJson.result) throw new Error("Empty episode list response.")

        const $ = LoadDoc(listJson.result)
        const episodes: EpisodeDetails[] = []
        const seen: { [key: string]: boolean } = {}

        let epNodes = $("ul.ep-range li > a")
        if (epNodes.length() === 0) epNodes = $(".ep-range a")
        if (epNodes.length() === 0) epNodes = $("a[data-ids]")
        epNodes.each((i, a) => {
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
                id: this.withMeta(dataIds, audio, parsed.anilistId),
                number,
                url: `${seriesUrl}/ep-${slug}`,
                title: title || undefined,
            })
        })

        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort((x, y) => x.number - y.number)
        this.writeCache(cacheKey, episodes)
        if (parsed.anilistId > 0) {
            for (let k = 0; k < episodes.length - 1; k++) {
                this.writeCache(`anikoto:next:${parsed.anilistId}:${episodes[k].number}`, {
                    id: episodes[k + 1].id,
                    number: episodes[k + 1].number,
                })
            }
        }
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        this.baseUrl = await this.resolveBase()
        const parsed = this.splitMeta(episode.id)
        const dataIds = parsed.base
        const audio = parsed.audio
        const ctx = { anilistId: parsed.anilistId, episode: episode.number }

        if (server === "Auto" || server === "default" || !server) {
            const $ = await this.serverListDoc(dataIds)
            const groups = audio === "dub" ? ["dub"] : ["sub", "hsub"]
            const candidates = this.collectServers($, groups)
            if (candidates.length === 0) throw new Error("No server available for this episode.")

            const label = server === "Auto" ? "Auto" : ""
            let firstResolved: EpisodeServer | undefined
            for (const c of candidates) {
                let resolved: EpisodeServer | undefined
                try {
                    resolved = await this.resolveServer(c.linkId, c.name, ctx)
                } catch (_e) {
                    resolved = undefined
                }
                if (!resolved) continue
                if (label) resolved.server = label
                if (!firstResolved) firstResolved = resolved
                if (await this.isPlayable(resolved)) {
                    this.firePrefetch(ctx)
                    return resolved
                }
            }
            if (firstResolved) {
                this.firePrefetch(ctx)
                return firstResolved
            }
            throw new Error("No playable server found for this episode.")
        }

        const target = this.parseServerLabel(server, audio)
        if (!target.ok) throw new Error("Server not available for this audio.")

        const $ = await this.serverListDoc(dataIds)
        const picked = this.collectServers($, [target.group]).filter((c) => c.name === target.name)[0]
        if (!picked) throw new Error("Server not available for this episode.")
        const result = await this.resolveServer(picked.linkId, target.label, ctx)
        this.firePrefetch(ctx)
        return result
    }

    private parseServerLabel(server: string, audio: string): { group: string; name: string; label: string; ok: boolean } {
        const hs = server.match(/^hs:\s*/i)
        if (hs) return { group: "hsub", name: server.slice(hs[0].length), label: server, ok: audio !== "dub" }
        return { group: audio === "dub" ? "dub" : "sub", name: server, label: server, ok: true }
    }

    private async serverListDoc(dataIds: string): Promise<DocSelectionFunction> {
        const cacheKey = `anikoto:slist:${dataIds}`
        let html = this.readCache<string>(cacheKey, this.serverCacheTtl)
        if (!html) {
            const slRes = await fetch(
                `${this.baseUrl}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`,
                { headers: this.ajaxHeaders() }
            )
            if (!slRes.ok) throw new Error(`server list failed: status ${slRes.status}`)
            html = slRes.json<{ status: number; result: string }>().result || ""
            if (html) this.writeCache(cacheKey, html)
        }
        return LoadDoc(html || "")
    }

    private collectServers($: DocSelectionFunction, groups: string[]): { name: string; linkId: string }[] {
        const out: { name: string; linkId: string }[] = []
        const seen: { [key: string]: boolean } = {}
        for (const t of groups) {
            $(`.servers .type[data-type="${t}"] li[data-link-id]`).each((_i, el) => {
                const linkId = el.attr("data-link-id")
                const name = el.text().trim()
                if (!linkId || !name || seen[linkId]) return
                seen[linkId] = true
                out.push({ name, linkId })
            })
        }
        return out
    }

    private async resolveServer(linkId: string, serverName: string, ctx: { anilistId: number; episode: number }): Promise<EpisodeServer> {
        const got = await this.fetchSources(linkId)
        if (!got || !got.file) throw new Error("Could not resolve the player URL.")
        const subtitles = this.buildSubtitles(got.tracks, ctx)
        return {
            server: serverName,
            headers: { Referer: `${got.origin}/`, Origin: got.origin },
            videoSources: [
                {
                    url: got.file,
                    type: "m3u8",
                    quality: "default",
                    subtitles,
                },
            ],
        }
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

    private async fetchSources(
        linkId: string
    ): Promise<{ origin: string; file?: string; tracks?: { file: string; label?: string; kind?: string; default?: boolean }[] } | undefined> {
        const psRes = await this.fetchRetry(`${this.baseUrl}/ajax/server?get=${encodeURIComponent(linkId)}`, {
            headers: this.ajaxHeaders(),
        })
        if (!psRes.ok) return undefined
        const ps = psRes.json<{ status: number; result: { url: string } }>()
        const embedUrl = ps && ps.result ? ps.result.url : undefined
        if (!embedUrl) return undefined

        const origin = this.originOf(embedUrl)
        const embedRes = await this.fetchRetry(embedUrl, { headers: { Referer: `${this.baseUrl}/` } })
        if (!embedRes.ok) return undefined

        const ehtml = embedRes.text()
        let dataId = this.firstAttr(LoadDoc(ehtml), ["#megaplay-player", "[id*='player'][data-id]"], "data-id")
        if (!dataId) {
            const m = ehtml.match(/data-id="([^"]+)"/)
            if (m) dataId = m[1]
        }
        if (!dataId) return undefined

        const srcRes = await this.fetchRetry(`${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`, {
            headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" },
        })
        if (!srcRes.ok) return undefined
        const data = srcRes.json<{
            sources: { file: string } | { file: string }[]
            tracks?: { file: string; label?: string; kind?: string; default?: boolean }[]
        }>()
        const file = Array.isArray(data.sources) ? (data.sources[0] || ({} as any)).file : data.sources.file
        return { origin, file, tracks: data.tracks }
    }

    private firePrefetch(ctx: { anilistId: number; episode: number }): void {
        try {
            void this.prefetchNext(ctx)
        } catch (_e) {}
    }

    private async prefetchNext(ctx: { anilistId: number; episode: number }): Promise<void> {
        if (ctx.anilistId <= 0 || ctx.episode <= 0) return
        const next = this.readCache<{ id: string; number: number }>(`anikoto:next:${ctx.anilistId}:${ctx.episode}`)
        if (!next || !next.id) return
        const warmKey = `anikoto:warmed:${ctx.anilistId}:${next.number}`
        if (this.readCache<boolean>(warmKey)) return
        this.writeCache(warmKey, true)

        try {
            const parsed = this.splitMeta(next.id)
            const $ = await this.serverListDoc(parsed.base)
            const groups = parsed.audio === "dub" ? ["dub"] : ["sub", "hsub"]
            const candidates = this.collectServers($, groups)

            let tracks: { file: string; label?: string; kind?: string; default?: boolean }[] | undefined
            for (const c of candidates) {
                const got = await this.fetchSources(c.linkId)
                if (got && got.tracks && got.tracks.length > 0) {
                    tracks = got.tracks
                    break
                }
            }
            if (!tracks || tracks.length === 0) return

            const items: { lang: string; src: string }[] = []
            const seen: { [key: string]: boolean } = {}
            for (let i = 0; i < tracks.length; i++) {
                const t = tracks[i]
                if (!t || !t.file) continue
                if (t.kind && t.kind !== "captions" && t.kind !== "subtitles") continue
                const lang = this.subLang(t.label)
                if (seen[lang]) continue
                seen[lang] = true
                items.push({ lang, src: t.file })
            }
            if (items.length === 0) return

            await fetch(`${this.subEndpoint}/warm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anilist: ctx.anilistId, episode: next.number, items }),
            })
        } catch (_e) {}
    }

    private buildSubtitles(
        tracks: { file: string; label?: string; kind?: string; default?: boolean }[] | undefined,
        ctx: { anilistId: number; episode: number }
    ): VideoSubtitle[] {
        const collected: VideoSubtitle[] = []
        if (!tracks || tracks.length === 0) return collected

        const anime = ctx.anilistId > 0 ? String(ctx.anilistId) : "unknown"
        const ep = ctx.episode > 0 ? String(ctx.episode) : "0"
        const seenLang: { [key: string]: boolean } = {}
        let englishIdx = -1
        let defaultIdx = -1

        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i]
            if (!t || !t.file) continue
            if (t.kind && t.kind !== "captions" && t.kind !== "subtitles") continue
            const lang = this.subLang(t.label)
            if (seenLang[lang]) continue
            seenLang[lang] = true
            const idx = collected.length
            collected.push({
                id: `${lang}-${idx}`,
                url: `${this.subEndpoint}/s/${anime}/${ep}/${lang}.vtt?src=${encodeURIComponent(t.file)}`,
                language: t.label || "English",
                isDefault: false,
            })
            if (englishIdx === -1 && lang.indexOf("english") === 0) englishIdx = idx
            if (defaultIdx === -1 && t.default === true) defaultIdx = idx
        }

        if (collected.length === 0) return collected
        const pick = englishIdx !== -1 ? englishIdx : defaultIdx !== -1 ? defaultIdx : 0
        collected[pick].isDefault = true
        return collected.filter((s) => s.isDefault).concat(collected.filter((s) => !s.isDefault))
    }

    private subLang(label: string | undefined): string {
        const l = (label || "english").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
        return l || "english"
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

    private withMeta(base: string, audio: string, anilistId: number): string {
        const a = this.withAudio(base, audio)
        return anilistId > 0 ? `${a}$al${anilistId}` : a
    }

    private splitMeta(id: string): { base: string; audio: string; anilistId: number } {
        let rest = id
        let anilistId = 0
        const m = rest.match(/\$al(\d+)$/)
        if (m) {
            anilistId = parseInt(m[1], 10)
            rest = rest.slice(0, rest.length - m[0].length)
        }
        const sa = this.splitAudio(rest)
        return { base: sa.base, audio: sa.audio, anilistId }
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
