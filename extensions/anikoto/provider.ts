declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

class Provider {
    private baseUrl = "{{baseUrl}}"
    private loadSubtitles = "{{loadSubtitles}}"
    private useCustomSolver = "{{useCustomSolver}}"
    private solverUrl = "{{solverUrl}}"
    private solverCooldown = 90000
    private mirrors = ["https://anikototv.to", "https://anikoto.cz", "https://anikoto.me", "https://anikoto.net", "https://anikototv.se"]
    private cacheTtl = 900000
    private serverCacheTtl = 300000
    private tokenTtl = 18000000
    private resolveDownTtl = 60000
    private serverBudget = 75000
    private searchBudget = 60000
    private deadline = 0
    private clearanceTtl = 1200000
    private subEndpoint = "https://sub.ryuo.to"

    private normBase(u: string): string {
        return u.replace(/\/+$/, "")
    }

    private candidateBases(): string[] {
        const configured = this.normBase(this.baseUrl)
        const out: string[] = [configured]
        const seen: { [key: string]: boolean } = {}
        seen[configured] = true
        const cached = $store.get<string>("anikoto:base")
        if (cached && !seen[cached]) {
            seen[cached] = true
            out.push(cached)
        }
        for (const m of this.mirrors) {
            const u = this.normBase(m)
            if (!seen[u]) {
                seen[u] = true
                out.push(u)
            }
        }
        return out
    }

    private currentBase(): string {
        const configured = this.normBase(this.baseUrl)
        const cached = $store.get<string>("anikoto:base")
        if (cached && (cached === configured || this.mirrors.indexOf(cached) !== -1)) return cached
        return configured
    }

    private rememberBase(base: string): void {
        this.baseUrl = base
        try {
            $store.set("anikoto:base", base)
        } catch (_e) {}
    }

    private invalidateBase(): void {
        try {
            $store.set("anikoto:base", "")
        } catch (_e) {}
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
                const retryable = res.status === 408 || res.status === 429 || res.status >= 500
                if (!retryable || i === tries - 1) return res
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr || `anikoto: fetch failed (${url})`
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
            episodeServers: ["Auto", "VidPlay-1", "HD-1"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const wantDub = opts.dub
        const audio = wantDub ? "dub" : "sub"
        const sq = this.searchQueries(opts)
        let challenged = false
        let unrecognized = false
        this.deadline = this.now() + this.searchBudget

        for (const base of this.candidateBases()) {
            if (this.outOfTime()) break
            this.baseUrl = base
            const results: SearchResult[] = []
            const seen: { [key: string]: boolean } = {}
            const evidence: { [key: string]: { episodes: number; movie: boolean } } = {}
            let anyOk = false
            let cards = 0
            let emptyList = false

            let hardFail = false
            for (const q of sq.queries) {
                if (this.outOfTime()) break
                let html = ""
                try {
                    const res = await fetch(`${base}/filter?keyword=${encodeURIComponent(q)}`, {
                        headers: this.pageHeaders(),
                    })
                    const body = res.text()
                    if (this.isChallengeResponse(res, body)) {
                        challenged = true
                    } else if (res.ok && this.bodyIsSitePage(body)) {
                        anyOk = true
                        html = body
                    }
                } catch (_e) {
                    hardFail = true
                }
                if (html) {
                    const doc = LoadDoc(html)
                    cards += this.parseSearchInto(doc, audio, wantDub, opts.media.id, seen, results, evidence)
                    if (this.resultListIsEmpty(doc)) emptyList = true
                }
                if (hardFail) break
            }

            if (anyOk) {
                // A restyle makes every card selector miss, which reads as "no results"
                // instead of an error. The site's own result container is what separates
                // the two: a keyword with no matches still ships it, empty.
                if (cards === 0 && !emptyList) {
                    unrecognized = true
                    continue
                }
                this.rememberBase(base)
                const best = this.dominantMatch(results, opts.media)
                if (best) return [best]
                return this.preferByEvidence(this.filterBySeason(results, sq.season, sq.part, opts.media), evidence, opts.media)
            }
        }

        this.invalidateBase()
        if (unrecognized) throw this.fail("search", "the site's search layout was not recognized — the page loaded but carried neither result cards nor an empty result list, so this extension needs updating")
        if (challenged) throw this.fail("search", "search blocked by the site's anti-bot challenge on all mirrors — retry later or switch mirrors (the custom solver does not affect search)")
        throw this.fail("search", "search failed (site unreachable)")
    }

    private baseTitle(s: string): string {
        return this.normTitle(
            (s || "")
                .replace(/\b(?:season|cour|part)\s*\d+\b/gi, " ")
                .replace(/\bfinal\s+season\b/gi, " ")
                .replace(/\b(?:II|III|IV|V|VI)\b/g, " ")
                .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, " ")
        )
    }

    private sameShow(results: SearchResult[], media: Media): SearchResult[] {
        const targets: string[] = []
        for (const t of [media.romajiTitle, media.englishTitle]) {
            const b = this.baseTitle(t || "")
            if (b.length >= 3) targets.push(b)
        }
        if (targets.length === 0) return results
        return results.filter((r) => {
            const b = this.baseTitle(r.title)
            if (!b) return false
            for (const t of targets) if (this.simNorm(b, t) >= 0.8) return true
            return false
        })
    }

    private filterBySeason(results: SearchResult[], season: number, part: number, media: Media): SearchResult[] {
        const show = this.sameShow(results, media)
        const pool = show.length > 0 ? show : results
        if (season < 2 && part < 2) return pool
        const matched = pool.filter((r) => {
            let resultSeason = -1
            let resultPart = -1
            try {
                const n = $scannerUtils.normalizeTitle(r.title)
                if (n) {
                    resultSeason = n.season
                    resultPart = n.part
                }
            } catch (_e) {}
            const seasonOk = season < 2 || resultSeason === season
            const partOk = part < 2 || resultPart === part
            return seasonOk && partOk
        })
        return matched.length > 0 ? matched : pool
    }

    private dominantMatch(results: SearchResult[], media: Media): SearchResult | null {
        const targets: string[] = []
        for (const t of [media.romajiTitle, media.englishTitle]) {
            const n = this.normTitle(t || "")
            if (n) targets.push(n)
        }
        if (targets.length === 0 || results.length === 0) return null
        const isMovie = (media.format || "").toUpperCase() === "MOVIE"
        const scored = results
            .map((r) => {
                const cn = this.normTitle(r.title)
                let s = 0
                for (const t of targets) {
                    const v = this.simNorm(cn, t)
                    if (v > s) s = v
                }
                if (isMovie && /\b(movie|film)\b/i.test(r.title)) s += 0.05
                return { r, s }
            })
            .sort((a, b) => b.s - a.s)
        if (scored[0].s >= 0.85 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.2)) return scored[0].r
        return null
    }

    private normTitle(s: string): string {
        return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }

    private simNorm(a: string, b: string): number {
        const ml = Math.max(a.length, b.length)
        return ml === 0 ? 0 : 1 - this.lev(a, b) / ml
    }

    private lev(a: string, b: string): number {
        const m = a.length
        const n = b.length
        if (!m) return n
        if (!n) return m
        const d: number[] = new Array(n + 1)
        for (let j = 0; j <= n; j++) d[j] = j
        for (let i = 1; i <= m; i++) {
            let prev = d[0]
            d[0] = i
            for (let j = 1; j <= n; j++) {
                const tmp = d[j]
                d[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[j], d[j - 1])
                prev = tmp
            }
        }
        return d[n]
    }

    private searchQueries(opts: SearchOptions): { queries: string[]; season: number; part: number } {
        const raw: string[] = []
        const rawSeen: { [key: string]: boolean } = {}
        for (const t of [opts.query, opts.media.romajiTitle, opts.media.englishTitle]) {
            const q = (t || "").trim()
            if (!q) continue
            const key = q.toLowerCase()
            if (rawSeen[key]) continue
            rawSeen[key] = true
            raw.push(q)
        }

        const queries: string[] = []
        const seen: { [key: string]: boolean } = {}
        const add = (s: string): void => {
            const q = (s || "").trim()
            if (!q) return
            const key = q.toLowerCase()
            if (seen[key]) return
            seen[key] = true
            queries.push(q)
        }

        let season = 0
        let part = 0
        try {
            const smart = $scannerUtils.buildSmartSearchTitles(raw)
            if (smart) {
                season = smart.season || 0
                part = smart.part || 0
                if (smart.titles) {
                    for (const t of smart.titles) add(t)
                }
            }
        } catch (_e) {}

        for (const t of raw) add(t)

        return { queries: queries.slice(0, 3), season, part }
    }

    private parseSearchInto(
        $: DocSelectionFunction,
        audio: string,
        dub: boolean,
        anilistId: number,
        seen: { [key: string]: boolean },
        results: SearchResult[],
        evidence: { [key: string]: { episodes: number; movie: boolean } }
    ): number {
        let cards = 0
        $("div.item").each((_i, card) => {
            cards++
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
            const total = parseInt(card.find(".ep-status.total").first().text().replace(/[^0-9]/g, ""), 10)
            const format = card.find(".ani.poster .meta .right").first().text().trim().toLowerCase()
            evidence[seriesUrl] = {
                episodes: !isNaN(total) && total > 0 && total <= 10000 ? total : 0,
                movie: format === "movie",
            }
            results.push({ id: this.withMeta(seriesUrl, audio, anilistId), title, url: seriesUrl, subOrDub })
        })
        return cards
    }

    // An empty "#list-items" is how the site says "no matches", so its presence with no
    // children is the one reading that must never be mistaken for a layout change.
    private resultListIsEmpty($: DocSelectionFunction): boolean {
        try {
            const list = $("#list-items")
            return list.length() > 0 && list.children().length() === 0
        } catch (_e) {
            return false
        }
    }

    // $scannerUtils reports season -1 when the marker is a word ("The Final Season"), so
    // filterBySeason cannot narrow those and hands back the whole show; the card's own
    // episode count is then the only evidence left that tells the seasons apart.
    private preferByEvidence(
        pool: SearchResult[],
        evidence: { [key: string]: { episodes: number; movie: boolean } },
        media: Media
    ): SearchResult[] {
        if (pool.length < 2) return pool
        // Upstream reports -1 for airing or unknown counts, and a card with no count
        // element carries no signal either — neither may drop a candidate.
        const want = media.episodeCount || 0
        if (want > 0) {
            const byCount = pool.filter((r) => {
                const e = evidence[r.url]
                return !e || e.episodes === 0 || e.episodes === want
            })
            if (byCount.length > 0) return byCount
        }
        const isMovie = (media.format || "").toUpperCase() === "MOVIE"
        const byFormat = pool.filter((r) => {
            const e = evidence[r.url]
            return !e || e.movie === isMovie
        })
        return byFormat.length > 0 ? byFormat : pool
    }

    private async resolveFromServer(anilistId: number, audio: string): Promise<EpisodeDetails[] | null> {
        const cacheKey = `anikoto:resolve:${anilistId}:${audio}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached
        if (this.readCache<boolean>("anikoto:resolvedown", this.resolveDownTtl)) return null
        try {
            const res = await fetch(`${this.subEndpoint}/resolve/${anilistId}`, { timeout: 8 })
            if (!res.ok) {
                this.writeCache("anikoto:resolvedown", true)
                return null
            }
            const data = res.json<{ episodes?: { number: number; dataIds: string; title?: string; hasSub?: boolean; hasDub?: boolean }[]; token?: string }>()
            if (data && typeof data.token === "string" && data.token) this.writeCache(`anikoto:tok:${anilistId}`, data.token)
            const eps = data && data.episodes
            if (!eps || eps.length === 0) return null
            const out: EpisodeDetails[] = []
            for (const e of eps) {
                if (!e || typeof e.number !== "number" || !e.dataIds) continue
                if (audio === "dub" ? e.hasDub === false : e.hasSub === false) continue
                out.push({ id: this.withMeta(e.dataIds, audio, anilistId), number: e.number, url: `${this.baseUrl}/`, title: e.title || undefined })
            }
            out.sort((a, b) => a.number - b.number)
            if (out.length === 0) return null
            this.writeCache(cacheKey, out)
            return out
        } catch (_e) {
            this.writeCache("anikoto:resolvedown", true)
            return null
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this.baseUrl = this.currentBase()
        const parsed = this.splitMeta(id)
        const audio = parsed.audio

        if (parsed.anilistId) {
            const fromServer = await this.resolveFromServer(parsed.anilistId, audio)
            if (fromServer && fromServer.length > 0) return fromServer
        }

        const seriesUrl = this.seriesUrl(this.absoluteUrl(parsed.base))

        const cacheKey = `anikoto:eps:${seriesUrl}:${audio}:${parsed.anilistId}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        let page: FetchResponse
        try {
            page = await this.fetchRetry(seriesUrl, { headers: this.pageHeaders(), timeout: 12 })
        } catch (e) {
            this.invalidateBase()
            throw this.fail("episodes", e instanceof Error ? e.message : String(e))
        }
        const pageHtml = page.text()
        if (this.isChallengeResponse(page, pageHtml)) throw this.fail("episodes", "the site is showing an anti-bot challenge on this mirror — retry later or switch mirrors")
        if (!page.ok) throw this.fail("episodes", `episode page failed (status ${page.status})`)
        let seriesId = this.firstAttr(LoadDoc(pageHtml), ["#watch-main", "[id*='watch'][data-id]", "main [data-id]"], "data-id")
        if (!seriesId) {
            const m = pageHtml.match(/data-id="(\d+)"/)
            if (m) seriesId = m[1]
        }
        if (!seriesId) {
            throw this.fail("episodes", "could not determine series id (site layout may have changed)")
        }

        const listRes = await this.fetchRetry(`${this.baseUrl}/ajax/episode/list/${seriesId}`, {
            headers: this.ajaxHeaders(), timeout: 12,
        })
        if (!listRes.ok) throw this.fail("episodes", `episode list failed (status ${listRes.status})`)
        const listJson = listRes.json<{ status: number; result: string }>()
        if (!listJson || !listJson.result) throw this.fail("episodes", "empty episode list response")

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
            if ((audio === "dub" ? a.attr("data-dub") : a.attr("data-sub")) === "0") return

            const rawNum = a.attr("data-num") || ""
            if (/^\d+\.\d+$/.test(rawNum)) return

            const dedupeKey = epId || dataIds
            if (seen[dedupeKey]) return
            seen[dedupeKey] = true

            const num = parseInt(rawNum, 10)
            const number = !Number.isInteger(num) || num < 1 || num > 10000 ? i + 1 : num
            const slug = a.attr("data-slug") || String(number)

            const title = a.find("span.d-title").first().text().trim()

            episodes.push({
                id: this.withMeta(dataIds, audio, parsed.anilistId),
                number,
                url: `${seriesUrl}/ep-${slug}`,
                title: title || undefined,
            })
        })

        if (episodes.length === 0) throw this.fail("episodes", "no episodes found")

        if (parsed.anilistId) {
            try {
                const metaRes = await fetch(`${this.subEndpoint}/meta/${parsed.anilistId}`, { timeout: 8 })
                if (metaRes.ok) {
                    const meta = metaRes.json<{
                        episodes?: number
                        episodeTitles?: { [key: string]: string }
                        episodeMap?: { [key: string]: { ep: number | null; abs: number | null } }
                    }>()
                    const titles = (meta && meta.episodeTitles) || {}
                    const map = (meta && meta.episodeMap) || {}
                    const aniTotal = meta && typeof meta.episodes === "number" && meta.episodes > 0 ? meta.episodes : 0
                    const mapKeys = Object.keys(map)
                    const mapCoversSeries = aniTotal > 0
                        ? !(mapKeys.length < aniTotal && episodes.length > mapKeys.length)
                        : mapKeys.length >= episodes.length
                    if (mapKeys.length > 0 && mapCoversSeries) {
                        const byNum: { [key: number]: EpisodeDetails } = {}
                        for (const e of episodes) byNum[e.number] = e
                        let maxTarget = 0
                        for (const k of mapKeys) {
                            const m = map[k]
                            maxTarget = Math.max(maxTarget, m.ep || 0)
                        }
                        const perPart = episodes.length < maxTarget
                        const remapped: EpisodeDetails[] = []
                        for (const k of mapKeys) {
                            const K = parseInt(k, 10)
                            if (isNaN(K)) continue
                            const m = map[k]
                            const ep = !perPart && typeof m.ep === "number" && m.ep > 0 ? byNum[m.ep] : undefined
                            const abs = !perPart && typeof m.abs === "number" && m.abs > 0 ? byNum[m.abs] : undefined
                            const src = ep || abs || byNum[K]
                            if (!src) continue
                            remapped.push({ id: src.id, number: K, url: src.url, title: titles[String(K)] || src.title })
                        }
                        if (remapped.length >= Math.ceil(mapKeys.length / 2)) {
                            episodes.length = 0
                            for (const e of remapped) episodes.push(e)
                        }
                    }
                    for (const e of episodes) {
                        const t = titles[String(e.number)]
                        if (!e.title && t) e.title = t
                    }
                }
            } catch (e) {}
        }

        episodes.sort((x, y) => x.number - y.number)
        this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        this.deadline = this.now() + this.serverBudget
        this.baseUrl = this.currentBase()
        const parsed = this.splitMeta(episode.id)
        const dataIds = parsed.base
        const audio = parsed.audio
        const ctx = { anilistId: parsed.anilistId, episode: episode.number }

        if (server === "Auto" || server === "default" || !server) {
            const $ = await this.serverListDoc(dataIds)
            const groups = audio === "dub" ? ["dub"] : ["sub", "hsub"]
            const KNOWN_SERVERS = audio === "dub" ? ["HD-1", "Vidstream-2", "VidCloud-1", "VidPlay-1"] : ["VidPlay-1", "HD-1", "Vidstream-2", "VidCloud-1"]
            const candidates = this.collectServers($, groups)
                .filter((c) => KNOWN_SERVERS.indexOf(c.name) !== -1)
                .sort((a, b) => KNOWN_SERVERS.indexOf(a.name) - KNOWN_SERVERS.indexOf(b.name))
            if (candidates.length === 0) throw this.fail("server", audio === "dub" ? "no dub is available for this episode" : "no server available for this episode")

            const label = server === "Auto" ? "Auto" : ""
            const wantSubs = this.loadSubtitles !== "disabled"
            let firstResolved: EpisodeServer | undefined
            let playableNoSubs: EpisodeServer | undefined
            for (const c of candidates) {
                if (this.outOfTime() && (playableNoSubs || firstResolved)) break
                let resolved: EpisodeServer | undefined
                try {
                    resolved = await this.resolveServer(c.linkId, c.name, ctx, audio)
                } catch (_e) {
                    resolved = undefined
                }
                if (!resolved) continue
                if (label) resolved.server = label
                if (!firstResolved) firstResolved = resolved
                if (await this.isPlayable(resolved, !playableNoSubs)) {
                    const vs = resolved.videoSources[0]
                    if (!wantSubs || (vs && vs.subtitles && vs.subtitles.length > 0)) return resolved
                    if (!playableNoSubs) playableNoSubs = resolved
                }
            }
            if (playableNoSubs) return playableNoSubs
            if (firstResolved) {
                const cl = this.cachedClearance(this.hostOf(firstResolved.videoSources[0].url))
                if (cl) firstResolved.headers = this.withClearance(firstResolved.headers, cl)
                return firstResolved
            }
            throw this.fail("server", "no playable server found for this episode" + (this.solverEnabled() ? "" : "; if sources are Cloudflare-protected, enable the custom solver in settings (run it via Aqua's Utils)"))
        }

        const target = this.parseServerLabel(server, audio)
        if (!target.ok) throw this.fail("server", "that server is not available for this audio track")

        const $ = await this.serverListDoc(dataIds)
        const picked = this.collectServers($, [target.group]).filter((c) => c.name === target.name)[0]
        if (!picked) throw this.fail("server", "that server is not available for this episode")
        const resolved = await this.resolveServer(picked.linkId, target.label, ctx, audio)
        const cl = this.cachedClearance(this.hostOf(resolved.videoSources[0].url))
        if (cl) resolved.headers = this.withClearance(resolved.headers, cl)
        return resolved
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
                { headers: this.ajaxHeaders(), timeout: 12 }
            )
            if (!slRes.ok) throw this.fail("server", `server list failed (status ${slRes.status})`)
            const sl = slRes.json<{ status: number; result: string }>()
            html = (sl && sl.result) || ""
            if (html && html.indexOf("data-link-id") !== -1) this.writeCache(cacheKey, html)
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

    private async resolveServer(linkId: string, serverName: string, ctx: { anilistId: number; episode: number }, audio: string): Promise<EpisodeServer> {
        const got = await this.fetchSources(linkId)
        if (!got || !got.file) throw this.fail("server", "could not resolve the player URL (source may be encrypted or down)")
        if (audio === "dub" && got.embedAudio === "sub") throw this.fail("server", "dub source resolved to the subbed (Japanese) track")
        const subtitles = await this.buildSubtitles(got.tracks, ctx, got.origin)
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

    private async isPlayable(server: EpisodeServer, allowSolver: boolean = true): Promise<boolean> {
        const src = server.videoSources[0]
        if (!src || !src.url) return false
        try {
            const origHeaders = server.headers
            const pre = this.cachedClearance(this.hostOf(src.url))
            if (pre) server.headers = this.withClearance(origHeaders, pre)
            let body = await this.fetchPlaylist(src.url, server.headers)
            if (body === undefined && allowSolver && this.solverEnabled() && !this.outOfTime()) {
                const cl = await this.clearanceForHost(src.url, !!pre)
                if (cl) {
                    server.headers = this.withClearance(origHeaders, cl)
                    body = await this.fetchPlaylist(src.url, server.headers)
                }
            }
            if (body === undefined) return false
            const variants = this.variantLevelUrls(body, src.url)
            if (variants.length === 0) return true
            const checks = await Promise.all(
                variants.map((v) => fetch(v, { headers: server.headers, timeout: 4 }).then((r) => r.ok).catch(() => false))
            )
            return checks.some((ok) => ok)
        } catch (_e) {
            return false
        }
    }

    private async fetchPlaylist(url: string, headers: { [k: string]: string }): Promise<string | undefined> {
        try {
            const res = await fetch(url, { headers: headers, timeout: 4 })
            if (!res.ok) return undefined
            const body = res.text()
            return body.indexOf("#EXTM3U") !== -1 ? body : undefined
        } catch (_e) {
            return undefined
        }
    }

    private solverEnabled(): boolean {
        const down = this.readCache<number>("anikoto:solverdown", this.solverCooldown)
        return (this.useCustomSolver || "").toLowerCase() === "on" && this.solverEndpoint() !== "" && (down === undefined || this.now() >= down)
    }

    private solverEndpoint(): string {
        const u = (this.solverUrl || "").trim()
        if (!/^https?:\/\/[^\s/]+/i.test(u)) return ""
        const base = u.replace(/\/+$/, "")
        return /\/v1$/.test(base) ? base : `${base}/v1`
    }

    private async solverClearance(url: string): Promise<{ cookie: string; ua: string } | undefined> {
        const ep = this.solverEndpoint()
        if (!ep) return undefined
        try {
            const res = await fetch(ep, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cmd: "request.get", url: url, maxTimeout: 32000 }),
                timeout: 35,
            })
            if (!res.ok) {
                if (res.status >= 500) this.writeCache("anikoto:solverdown", this.now() + this.solverCooldown)
                return undefined
            }
            this.writeCache("anikoto:solverdown", 0)
            const data = res.json<{ solution?: { userAgent?: string; cookies?: { name: string; value: string }[] } }>()
            const sol = data && data.solution ? data.solution : undefined
            if (!sol || !Array.isArray(sol.cookies)) return undefined
            const parts: string[] = []
            for (const c of sol.cookies) {
                if (c && c.name && /cf_clearance|^__cf|^cf_|^__ddg/i.test(c.name)) parts.push(`${c.name}=${c.value}`)
            }
            if (parts.length === 0) return undefined
            return { cookie: parts.join("; "), ua: sol.userAgent || "" }
        } catch (_e) {
            this.writeCache("anikoto:solverdown", this.now() + this.solverCooldown)
            return undefined
        }
    }

    private withClearance(headers: { [k: string]: string }, cl: { cookie: string; ua: string }): { [k: string]: string } {
        const out: { [k: string]: string } = {}
        for (const k in headers) out[k] = headers[k]
        const kept: string[] = []
        for (const part of (out.Cookie || "").split(";")) {
            const p = part.trim()
            if (p && !/^(cf_clearance|__cf|cf_|__ddg)/i.test(p)) kept.push(p)
        }
        kept.push(cl.cookie)
        out.Cookie = kept.join("; ")
        if (cl.ua) out["User-Agent"] = cl.ua
        return out
    }

    private hostOf(u: string): string {
        const m = u.match(/^https?:\/\/([^/]+)/i)
        return m ? m[1].toLowerCase() : ""
    }

    private cachedClearance(host: string): { cookie: string; ua: string } | undefined {
        if (!host) return undefined
        return this.readCache<{ cookie: string; ua: string }>(`anikoto:cf:${host}`, this.clearanceTtl)
    }

    private async clearanceForHost(url: string, force: boolean): Promise<{ cookie: string; ua: string } | undefined> {
        const host = this.hostOf(url)
        if (!force) {
            const cached = this.cachedClearance(host)
            if (cached) return cached
        }
        if (!this.solverEnabled()) return undefined
        const cl = await this.solverClearance(url)
        if (!cl || !cl.ua) return undefined
        if (host) this.writeCache(`anikoto:cf:${host}`, cl)
        return cl
    }

    private variantLevelUrls(master: string, masterUrl: string): string[] {
        const out: string[] = []
        const lines = master.split(/\r?\n/)
        const dir = masterUrl.replace(/[?#].*$/, "").replace(/[^/]*$/, "")
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf("#EXT-X-STREAM-INF") === 0) {
                const u = (lines[i + 1] || "").trim()
                if (u && u.charAt(0) !== "#") out.push(/^https?:\/\//i.test(u) ? u : dir + u)
            }
        }
        return out
    }

    private async fetchSources(
        linkId: string
    ): Promise<{ origin: string; file?: string; embedAudio?: string; tracks?: { file: string; label?: string; kind?: string; default?: boolean }[] } | undefined> {
        const cacheKey = `anikoto:src:${linkId}`
        const cachedSrc = this.readCache<{ origin: string; file?: string; embedAudio?: string; tracks?: { file: string; label?: string; kind?: string; default?: boolean }[] }>(cacheKey, this.serverCacheTtl)
        if (cachedSrc) return cachedSrc

        const psRes = await this.fetchRetry(`${this.baseUrl}/ajax/server?get=${encodeURIComponent(linkId)}`, {
            headers: this.ajaxHeaders(), timeout: 3,
        })
        if (!psRes.ok) return undefined
        const ps = psRes.json<{ status: number; result: { url: string } }>()
        let embedUrl = ps && ps.result ? ps.result.url : undefined
        if (!embedUrl) return undefined

        const origin = this.originOf(embedUrl)
        const embedRes = await this.fetchRetry(embedUrl, { headers: { Referer: `${this.baseUrl}/` }, timeout: 3 })
        if (!embedRes.ok) return undefined

        const ehtml = embedRes.text()
        let dataId = this.firstAttr(LoadDoc(ehtml), ["#megaplay-player", "[id*='player'][data-id]"], "data-id")
        if (!dataId) {
            const m = ehtml.match(/data-id="([^"]+)"/)
            if (m) dataId = m[1]
        }
        if (!dataId) {
            const ifr = ehtml.match(/<iframe[^>]+\bsrc="([^"]*\/stream\/[^"]*)"/i)
            const inner = ifr ? this.absoluteUrl(ifr[1]) : ""
            if (inner && this.originOf(inner) === origin) {
                const innerRes = await this.fetchRetry(inner, { headers: { Referer: embedUrl }, timeout: 3 })
                if (innerRes.ok) {
                    const ih = innerRes.text()
                    dataId = this.firstAttr(LoadDoc(ih), ["#megaplay-player", "[id*='player'][data-id]"], "data-id")
                    if (!dataId) {
                        const m2 = ih.match(/data-id="([^"]+)"/)
                        if (m2) dataId = m2[1]
                    }
                    if (dataId) embedUrl = inner
                }
            }
        }
        if (!dataId || !/^[\w.-]{1,256}$/.test(dataId)) return undefined

        const srcRes = await this.fetchRetry(`${origin}/stream/getSources?id=${encodeURIComponent(dataId)}`, {
            headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" }, timeout: 3,
        })
        if (!srcRes.ok) return undefined
        const data = srcRes.json<{
            sources: { file: string } | { file: string }[]
            tracks?: { file: string; label?: string; kind?: string; default?: boolean }[]
        }>()
        if (!data || !data.sources) return undefined
        const raw = Array.isArray(data.sources) ? (data.sources[0] || ({} as any)).file : data.sources.file
        const file = typeof raw === "string" && /^https?:\/\//i.test(raw) ? raw : undefined
        const result = { origin, file, embedAudio: this.embedAudioOf(embedUrl), tracks: Array.isArray(data.tracks) ? data.tracks : undefined }
        if (file) this.writeCache(cacheKey, result)
        return result
    }

    private embedAudioOf(u: string): string {
        const m = (u || "").match(/\/(sub|dub)(?:[/?#]|$)/i)
        return m ? m[1].toLowerCase() : ""
    }

    private extOf(file: string): string {
        const path = file.split(/[?#]/)[0]
        const m = path.match(/\.([a-z0-9]+)$/i)
        const e = m ? m[1].toLowerCase() : ""
        return e === "ass" || e === "srt" ? e : "vtt"
    }

    private async ensureServeToken(anilistId: number): Promise<string | undefined> {
        const key = `anikoto:tok:${anilistId}`
        const cached = this.readCache<string>(key, this.tokenTtl)
        if (cached) return cached
        try {
            const res = await fetch(`${this.subEndpoint}/resolve/${anilistId}`, { timeout: 8 })
            if (!res.ok) return undefined
            const data = res.json<{ token?: string }>()
            if (data && typeof data.token === "string" && data.token) {
                this.writeCache(key, data.token)
                return data.token
            }
        } catch (_e) {}
        return undefined
    }

    private async buildSubtitles(
        tracks: { file: string; label?: string; kind?: string; default?: boolean }[] | undefined,
        ctx: { anilistId: number; episode: number },
        embedOrigin?: string
    ): Promise<VideoSubtitle[]> {
        const collected: VideoSubtitle[] = []
        if (this.loadSubtitles === "disabled") return collected
        if (!tracks || tracks.length === 0) return collected

        const anime = String(ctx.anilistId)
        const ep = String(ctx.episode)
        const refParam = embedOrigin ? `&ref=${encodeURIComponent(embedOrigin)}` : ""
        const valid = tracks.filter((t) => t && typeof t.file === "string" && /^https?:\/\//i.test(t.file) && (!t.kind || t.kind === "captions" || t.kind === "subtitles"))
        if (valid.length === 0) return collected
        const up = ctx.anilistId > 0
        let tokParam = ""
        if (up) {
            let tok = this.readCache<string>(`anikoto:tok:${ctx.anilistId}`, this.tokenTtl)
            if (!tok) tok = await this.ensureServeToken(ctx.anilistId)
            tokParam = tok ? `&t=${encodeURIComponent(tok)}` : ""
        }
        const codes = await this.langCodes(valid.map((t) => t.label || "English"))
        const seenSrc: { [key: string]: boolean } = {}
        const seenSlot: { [key: string]: boolean } = {}
        const nonDialogue: boolean[] = []
        let pick = 0
        let best = -1

        for (let i = 0; i < valid.length; i++) {
            const t = valid[i]
            const lang = codes[i]
            const label = (t.label || "").trim()
            if (seenSrc[t.file]) continue
            seenSrc[t.file] = true
            const idx = collected.length
            const slot = seenSlot[lang] ? `${lang}-${idx}` : lang
            seenSlot[lang] = true
            const url = up
                ? `${this.subEndpoint}/s/${anime}/${ep}/${slot}.${this.extOf(t.file)}?src=${encodeURIComponent(t.file)}${tokParam}${refParam}`
                : t.file
            collected.push({
                id: `${lang}-${idx}`,
                url,
                language: label || this.langName(lang),
                isDefault: false,
            })
            const score = this.trackScore(label, lang === "en", t.default === true)
            nonDialogue.push(this.isNonDialogue(label))
            if (score > best) {
                best = score
                pick = idx
            }
        }

        if (collected.length === 0) return collected
        collected[pick].isDefault = true
        const head: VideoSubtitle[] = []
        const tail: VideoSubtitle[] = []
        for (let i = 0; i < collected.length; i++) {
            if (i === pick) continue
            if (nonDialogue[i]) tail.push(collected[i])
            else head.push(collected[i])
        }
        return [collected[pick]].concat(head).concat(tail)
    }

    private isNonDialogue(label: string): boolean {
        const l = label || ""
        if (/\b(?:full|dialogu?e|dialog|main|complete)\b/i.test(l)) return false
        return /\b(?:forced|forc[eé]s|signs?|songs?|karaoke|kfx|typeset(?:ting)?|commentary)\b/i.test(l) || /\bs\s*[&+\/]\s*s\b/i.test(l) || /\bop\s*[\/&+]\s*ed\b/i.test(l)
    }

    private isMachine(label: string): boolean {
        return /\b(?:ai|mtl)\b/i.test(label || "")
    }

    private isAltDialogue(label: string): boolean {
        return /\b(?:sdh|cc|closed[\s-]?captions?|hearing[\s-]?impaired|dub[\s-]?titles?)\b/i.test(label || "")
    }

    private trackScore(label: string, isEnglish: boolean, def: boolean): number {
        const base = this.isNonDialogue(label) ? (isEnglish ? 3 : 0) : this.isMachine(label) ? (isEnglish ? 4 : 1) : this.isAltDialogue(label) ? (isEnglish ? 5 : 1) : isEnglish ? 6 : 2
        return def ? base * 10 + 1 : base * 10
    }

    private langName(code: string): string {
        const map: { [key: string]: string } = {
            en: "English", ja: "Japanese", ar: "Arabic", de: "German", es: "Spanish", fr: "French",
            it: "Italian", ru: "Russian", pt: "Portuguese", hi: "Hindi", id: "Indonesian",
            ko: "Korean", zh: "Chinese", th: "Thai", vi: "Vietnamese", tr: "Turkish", pl: "Polish", nl: "Dutch",
        }
        return map[code] || code.toUpperCase()
    }

    private async langCodes(labels: string[]): Promise<string[]> {
        const out: string[] = new Array(labels.length)
        const missing: { idx: number; label: string }[] = []
        for (let i = 0; i < labels.length; i++) {
            const cached = this.readCache<string>(`anikoto:lang:${labels[i]}`, 86400000)
            if (cached) out[i] = cached
            else missing.push({ idx: i, label: labels[i] })
        }
        if (missing.length > 0) {
            let codes: string[] = []
            try {
                const res = await fetch(`${this.subEndpoint}/lang`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ labels: missing.map((m) => m.label) }),
                    timeout: 6,
                })
                if (res.ok) {
                    const j = res.json<{ codes: string[] }>()
                    codes = (j && j.codes) || []
                }
            } catch (_e) {}
            for (let k = 0; k < missing.length; k++) {
                const fromServer = codes[k]
                const code = fromServer || this.fallbackCode(missing[k].label)
                out[missing[k].idx] = code
                if (fromServer) this.writeCache(`anikoto:lang:${missing[k].label}`, code)
            }
        }
        return out
    }

    private fallbackCode(label: string): string {
        const words = (label || "english").toLowerCase().split(/[^a-z]+/)
        const map: { [key: string]: string } = {
            eng: "en", english: "en",
            por: "pt", portuguese: "pt", brazilian: "pt",
            spa: "es", esp: "es", spanish: "es", castilian: "es",
            ger: "de", deu: "de", german: "de",
            fre: "fr", fra: "fr", french: "fr",
            dut: "nl", nld: "nl", dutch: "nl",
            chi: "zh", zho: "zh", chinese: "zh", mandarin: "zh",
            jpn: "ja", japanese: "ja",
            kor: "ko", korean: "ko",
            ind: "id", indonesian: "id",
            may: "ms", msa: "ms", malay: "ms",
            gre: "el", ell: "el", greek: "el",
            cze: "cs", ces: "cs", czech: "cs",
            rum: "ro", ron: "ro", romanian: "ro",
            swe: "sv", swedish: "sv",
            ara: "ar", arabic: "ar",
            rus: "ru", russian: "ru",
            ita: "it", italian: "it",
            pol: "pl", polish: "pl",
            tur: "tr", turkish: "tr",
            tha: "th", thai: "th",
            vie: "vi", vietnamese: "vi",
            ukr: "uk", ukrainian: "uk",
            hin: "hi", hindi: "hi",
        }
        for (const w of words) {
            if (map[w]) return map[w]
        }
        return "en"
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

    private reportError(scope: string, message: string): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: this.now(), ext: "aq-anikoto-beta", scope: scope, msg: String(message) }))
        } catch (_e) {}
    }

    private fail(scope: string, message: string): string {
        this.reportError(scope, message)
        return message
    }

    private challengeToken(body: string): string {
        if (!body) return ""
        const b = body.toLowerCase()
        const toks = ["cf-mitigated", "cf-browser-verification", "/cdn-cgi/challenge-platform", "ddos-guard", "just a moment...</title>", "attention required! | cloudflare"]
        for (let i = 0; i < toks.length; i++) if (b.indexOf(toks[i]) !== -1) return toks[i]
        return ""
    }

    private isChallengeResponse(res: FetchResponse, body: string): boolean {
        const h = res.headers || {}
        for (const k in h) {
            if (k.toLowerCase() === "cf-mitigated" && String(h[k]).toLowerCase().indexOf("challenge") !== -1) return true
        }
        if (res.status === 403 || res.status === 503) return !this.bodyIsSitePage(body)
        return this.bodyIsChallenge(body) && !this.bodyIsSitePage(body)
    }

    private bodyIsChallenge(body: string): boolean {
        return this.challengeToken(body) !== ""
    }

    private bodyIsSitePage(body: string): boolean {
        if (!body) return false
        try {
            const $ = LoadDoc(body)
            return $("footer").length() > 0 || $("div.item").length() > 0
        } catch (_e) {
            return false
        }
    }

    private outOfTime(): boolean {
        const t = this.now()
        return this.deadline > 0 && t > 0 && t > this.deadline
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
        if (u && u.indexOf("//") === 0) u = `https:${u}`
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.baseUrl
    }
}
