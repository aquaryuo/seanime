declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type SourcePayload = {
    sources?: { file: string } | { file: string }[]
    tracks?: { file: string; label?: string; kind?: string; default?: boolean }[]
    enc?: string
}

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "https://anikototv.to")
    private loadSubtitles = this.cfg("loadSubtitles", "enabled")
    private useCustomSolver = this.cfg("useCustomSolver", "off")
    private solverUrl = this.cfg("solverUrl", "http://127.0.0.1:8191/v1")
    private solverCooldown = 90000
    private badgeReported = false
    private alt: { [key: string]: string } = {}
    private mirrors = ["https://anikototv.to", "https://anikoto.cz", "https://anikoto.me", "https://anikoto.net", "https://anikototv.se"]
    private cacheTtl = 900000
    private serverCacheTtl = 300000
    private tokenTtl = 18000000
    private idCacheTtl = 86400000
    private resolveDownTtl = 60000
    private serverBudget = 75000
    private searchBudget = 60000
    private episodeBudget = 30000
    private searchCacheTtl = 60000
    private deadline = 0
    private clearanceTtl = 1200000

    private cfg(name: string, fallback: string): string {
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
    }

    private normBase(u: string): string {
        return u.replace(/\/+$/, "")
    }

    private candidateBases(): string[] {
        const configured = this.normBase(this.baseUrl)
        const out: string[] = []
        const push = (u: string): void => {
            if (u && out.indexOf(u) === -1) out.push(u)
        }
        const cached = this.normBase($store.get<string>("anikoto:base") || "")
        if (cached && (cached === configured || this.mirrors.indexOf(cached) !== -1)) push(cached)
        push(configured)
        for (const m of this.mirrors) push(m)
        return out
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

    private parseJson<T>(text: string): T | undefined {
        if (!text) return undefined
        try {
            return JSON.parse(text) as T
        } catch (_e) {
            return undefined
        }
    }

    private async guarded(scope: string, url: string, opts?: FetchOptions): Promise<FetchResponse> {
        try {
            return await this.fetchRetry(url, opts)
        } catch (e) {
            this.invalidateBase()
            this.reportError(scope, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
            throw "the site could not be reached — check your connection or retry in a moment"
        }
    }

    private ajaxHeaders(): { [key: string]: string } {
        return { Referer: `${this.baseUrl}/`, "X-Requested-With": "XMLHttpRequest" }
    }

    private async fetchRetry(url: string, opts?: FetchOptions): Promise<FetchResponse> {
        try {
            const res = await fetch(url, opts)
            if (!(res.status === 408 || res.status === 429 || res.status >= 500) || this.outOfTime()) return res
        } catch (e) {
            if (this.outOfTime()) throw e
        }
        return fetch(url, opts)
    }

    private dataIdIn(html: string, selectors: string[], re: RegExp): string {
        const $ = LoadDoc(html)
        for (const sel of selectors) {
            const v = $(sel).first().attr("data-id")
            if (v) return v
        }
        return (html.match(re) || [])[1] || ""
    }

    getSettings(): Settings {
        return {
            episodeServers: ["Auto"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const wantDub = opts.dub
        const audio = wantDub ? "dub" : "sub"
        const sq = this.searchQueries(opts)
        const wantCount = opts.media.episodeCount && opts.media.episodeCount > 0 ? opts.media.episodeCount : 0
        let challenged = false
        let unrecognized = false
        this.deadline = Date.now() + this.searchBudget

        const sKey = `anikoto:srch:${audio}:${opts.media.id || 0}:${sq.season}:${sq.part}:${sq.queries.slice().sort().join("|").toLowerCase()}`
        const sCached = this.readCache<SearchResult[]>(sKey, this.searchCacheTtl)
        if (sCached && sCached.length > 0) return sCached

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
                let pageDoc: DocSelectionFunction | undefined = undefined
                try {
                    const res = await fetch(`${base}/filter?keyword=${encodeURIComponent(q)}`, {
                        headers: { Referer: `${base}/` },
                    })
                    const body = res.text()
                    const doc = body ? LoadDoc(body) : undefined
                    if (this.isChallengeResponse(res, body, doc)) {
                        challenged = true
                    } else if (res.ok && doc && this.bodyIsSitePage(body, doc)) {
                        anyOk = true
                        pageDoc = doc
                    }
                } catch (_e) {
                    hardFail = true
                }
                if (pageDoc) {
                    cards += this.parseSearchInto(pageDoc, audio, wantDub, opts.media.id, seen, results, evidence, wantCount, sq.part || 0)
                    if (this.resultListIsEmpty(pageDoc)) emptyList = true
                }
                if (hardFail) break
            }

            if (anyOk) {
                if (cards === 0 && !emptyList) {
                    unrecognized = true
                    continue
                }
                this.rememberBase(base)
                let best = this.dominantMatch(results, opts.media)
                if (best && sq.season >= 2) {
                    const bs = this.titleNums(best.title).season
                    if (bs > 0 && bs !== sq.season) best = null
                }
                let out = best
                    ? [best]
                    : this.preferByEvidence(this.filterBySeason(results, sq.season, sq.part, opts.media), evidence, opts.media)
                if ((opts.media.format || "").toUpperCase() === "MOVIE" && out.length > 0 && out.every((r) => evidence[r.url] && !evidence[r.url].movie && evidence[r.url].episodes > 1)) {
                    const w = this.wordDice(results.filter((r) => evidence[r.url] && evidence[r.url].movie), opts.media)
                    if (w && w.s >= 0.5) out = [w.r]
                }
                if (out.length > 0) this.writeCache(sKey, out)
                return out
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
        const targets = [media.romajiTitle, media.englishTitle].map((t) => this.baseTitle(t || "")).filter((b) => b.length >= 3)
        if (targets.length === 0) return results
        const hits = (r: SearchResult, match: (b: string, t: string) => boolean): boolean =>
            [r.title, this.alt[r.url] || ""].some((x) => {
                const b = this.baseTitle(x)
                return b.length >= 3 && targets.some((t) => match(b, t))
            })
        const same = results.filter((r) => hits(r, (b, t) => this.simNorm(b, t) >= 0.8))
        return same.length > 0 ? same : results.filter((r) => hits(r, (b, t) => b.indexOf(t) === 0 || t.indexOf(b) === 0))
    }

    private filterBySeason(results: SearchResult[], season: number, part: number, media: Media): SearchResult[] {
        const pool = this.sameShow(results, media)
        if (season < 2 && part < 2) return pool
        const matched = pool.filter((r) => {
            const n = this.titleNums(r.title)
            return (season < 2 || n.season === season) && (part < 2 || n.part === part)
        })
        if (matched.length > 0) return matched
        const known = pool.map((r) => this.titleNums(r.title).season).filter((s) => s > 0)
        if (season >= 2 && known.length > 0 && Math.max(...known) < season) return []
        return pool
    }

    private titleNums(t: string): { season: number; part: number } {
        try {
            return $scannerUtils.normalizeTitle(t) || { season: -1, part: -1 }
        } catch (_e) {
            return { season: -1, part: -1 }
        }
    }

    private wordDice(results: SearchResult[], media: Media): { r: SearchResult; s: number } | null {
        const toks = (s: string): string[] => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w, i, a) => w.length > 0 && a.indexOf(w) === i)
        const targets = [media.romajiTitle, media.englishTitle].map((t) => toks(t || "")).filter((t) => t.length > 0)
        let top: { r: SearchResult; s: number } | null = null
        for (const r of results) {
            const c = toks(r.title)
            for (const t of targets) {
                let n = 0
                for (const w of c) if (t.indexOf(w) !== -1) n++
                const s = (2 * n) / (c.length + t.length)
                if (!top || s > top.s) top = { r, s }
            }
        }
        return top
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
                let s = 0
                for (const title of [r.title, this.alt[r.url] || ""]) {
                    const cn = this.normTitle(title)
                    if (!cn) continue
                    for (const t of targets) {
                        const v = this.simNorm(cn, t)
                        if (v > s) s = v
                    }
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
        const uniq = (list: (string | undefined)[]): string[] => {
            const out: string[] = []
            for (const s of list) {
                const q = (s || "").trim()
                if (q && !out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q)
            }
            return out
        }
        const raw = uniq([opts.query, opts.media.romajiTitle, opts.media.englishTitle])
        let smart: $scannerUtils.SmartSearchTitlesResult | undefined
        try {
            smart = $scannerUtils.buildSmartSearchTitles(raw)
        } catch (_e) {}
        return { queries: uniq(((smart && smart.titles) || []).concat(raw)).slice(0, 3), season: (smart && smart.season) || 0, part: (smart && smart.part) || 0 }
    }

    private parseSearchInto(
        $: DocSelectionFunction,
        audio: string,
        dub: boolean,
        anilistId: number,
        seen: { [key: string]: boolean },
        results: SearchResult[],
        evidence: { [key: string]: { episodes: number; movie: boolean } },
        epCount: number,
        part: number
    ): number {
        let cards = 0
        let badges = 0
        $("div.item").each((_i, card) => {
            cards++
            const titleLink = card.find("a.name.d-title").first()
            if (titleLink.length() === 0) return

            const href = titleLink.attr("href") || card.find(".ani.poster.tip a").first().attr("href")
            if (!href) return
            const seriesUrl = this.seriesUrl(href)
            const hasSub = card.find(".ep-status.sub").length() > 0
            const hasDub = card.find(".ep-status.dub").length() > 0
            if (hasSub || hasDub) badges++
            if (seen[seriesUrl]) return

            const title = (
                titleLink.text() ||
                titleLink.attr("data-jp") ||
                card.find("img").first().attr("alt") ||
                ""
            ).trim()
            if (!title) return

            if (dub && !hasDub) return

            seen[seriesUrl] = true
            this.alt[seriesUrl] = (titleLink.attr("data-jp") || "").trim()
            const subOrDub: SubOrDub = hasSub && hasDub ? "both" : hasDub ? "dub" : "sub"
            const total = parseInt(card.find(".ep-status.total").first().text().replace(/[^0-9]/g, ""), 10)
            const format = card.find(".ani.poster .meta .right").first().text().trim().toLowerCase()
            evidence[seriesUrl] = {
                episodes: !isNaN(total) && total > 0 && total <= 10000 ? total : 0,
                movie: format === "movie",
            }
            if (anilistId > 0) this.writeCache(`anikoto:al:${seriesUrl}`, anilistId)
            results.push({ id: this.withMeta(seriesUrl, audio, anilistId, epCount, part), title, url: seriesUrl, subOrDub })
        })
        if (cards > 0 && badges === 0 && !this.badgeReported) {
            this.badgeReported = true
            this.reportError("search", `the site listed ${cards} results but no sub/dub badges on any of them, so every result is assumed sub-only${dub ? " and a dub search returns nothing" : ""} — the site layout may have changed`)
        }
        return cards
    }

    private resultListIsEmpty($: DocSelectionFunction): boolean {
        try {
            const list = $("#list-items")
            return list.length() > 0 && list.children().length() === 0
        } catch (_e) {
            return false
        }
    }

    private preferByEvidence(
        pool: SearchResult[],
        evidence: { [key: string]: { episodes: number; movie: boolean } },
        media: Media
    ): SearchResult[] {
        if (pool.length < 2) return pool
        const want = media.episodeCount || 0
        if (want > 0) {
            const byCount = pool.filter((r) => {
                const e = evidence[r.url]
                return !e || e.episodes === 0 || e.episodes === want
            })
            if (byCount.length > 0) return byCount
        }
        if (!media.format) return pool
        const isMovie = (media.format || "").toUpperCase() === "MOVIE"
        const byFormat = pool.filter((r) => {
            const e = evidence[r.url]
            return !e || e.movie === isMovie
        })
        return byFormat.length > 0 ? byFormat : pool
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this.deadline = Date.now() + this.episodeBudget
        this.baseUrl = this.candidateBases()[0]
        const parsed = this.splitMeta(id)
        const audio = parsed.audio

        const idUrl = this.seriesUrl(this.absoluteUrl(parsed.base))
        const path = idUrl.replace(/^https?:\/\/[^/]+/i, "")

        const cacheKey = `anikoto:eps2:${path}:${audio}:${parsed.anilistId}:${parsed.epCount}:${parsed.part}`
        const cached = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        const bases = this.candidateBases()
        const idOrigin = this.normBase(this.originOf(idUrl))
        if (bases.indexOf(idOrigin) === -1) bases.push(idOrigin)
        let page: FetchResponse | undefined = undefined
        let pageHtml = ""
        let lastErr: unknown = undefined
        let fails = 0
        for (const base of bases) {
            if (this.outOfTime() && (page || fails >= 2)) break
            try {
                page = await this.guarded("episodes", `${base}${path}`, { headers: { Referer: `${base}/` } })
            } catch (e) {
                lastErr = e
                fails++
                continue
            }
            this.baseUrl = base
            pageHtml = page.text()
            if (page.status === 429 || this.bodyIsSitePage(pageHtml)) {
                if (page.ok) this.rememberBase(base)
                break
            }
        }
        if (!page) throw lastErr
        const seriesUrl = `${this.baseUrl}${path}`
        if (this.isChallengeResponse(page, pageHtml)) throw this.fail("episodes", "the site is showing an anti-bot challenge on this mirror — retry later or switch mirrors")
        if (!page.ok) throw this.fail("episodes", `episode page failed (status ${page.status})`)
        const seriesId = this.dataIdIn(pageHtml, ["#watch-main", "[id*='watch'][data-id]", "main [data-id]"], /data-id="(\d+)"/)
        if (!seriesId) {
            throw this.fail("episodes", "could not determine series id (site layout may have changed)")
        }

        const listRes = await this.guarded("episodes", `${this.baseUrl}/ajax/episode/list/${seriesId}`, {
            headers: this.ajaxHeaders(),
        })
        const listHtml = listRes.text()
        if (this.isChallengeResponse(listRes, listHtml)) throw this.fail("episodes", "the site is showing an anti-bot challenge on this mirror — retry later or switch mirrors")
        if (!listRes.ok) throw this.fail("episodes", `episode list failed (status ${listRes.status})`)
        const listJson = this.parseJson<{ status: number; result: string }>(listHtml)
        if (!listJson || !listJson.result) throw this.fail("episodes", "empty episode list response")

        const $ = LoadDoc(listJson.result)
        const episodes: EpisodeDetails[] = []
        const seen: { [key: string]: boolean } = {}
        let maxNum = 0

        let epNodes = $("ul.ep-range li > a")
        if (epNodes.length() === 0) epNodes = $(".ep-range a")
        if (epNodes.length() === 0) epNodes = $("a[data-ids]")
        epNodes.each((_i, a) => {
            const epId = a.attr("data-id") || ""
            const dataIds = a.attr("data-ids")
            if (!dataIds) return
            const rawNum = a.attr("data-num") || ""
            const num = parseInt(rawNum, 10)
            if (Number.isInteger(num) && num > maxNum && num <= 10000) maxNum = num
            if ((audio === "dub" ? a.attr("data-dub") : a.attr("data-sub")) === "0") return

            if (/^\d+\.\d+$/.test(rawNum)) return

            const dedupeKey = epId || dataIds
            if (seen[dedupeKey]) return
            seen[dedupeKey] = true

            const number = !Number.isInteger(num) || num < 1 || num > 10000 ? episodes.length + 1 : num
            const slug = a.attr("data-slug") || String(number)

            const rawTitle = a.find("span.d-title").first().text().trim()
            const title = /^episode\s*\d+$/i.test(rawTitle) ? "" : rawTitle

            episodes.push({
                id: this.withMeta(dataIds, audio, parsed.anilistId, parsed.epCount, parsed.part),
                number,
                url: `${seriesUrl}/ep-${slug}`,
                title: title || undefined,
            })
        })

        if (episodes.length === 0) throw this.fail("episodes", "no episodes found")

        episodes.sort((x, y) => x.number - y.number)
        const planned = parseInt((pageHtml.match(/Episodes:\s*<span>\s*(\d+)/) || [])[1] || "", 10) || 0
        this.applySeasonWindow(episodes, parsed.epCount, parsed.part, Math.max(planned, maxNum))
        if (episodes.length === 0) throw this.fail("episodes", `none of this part's episodes are out yet in ${audio}`)
        this.writeCache(cacheKey, episodes)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        this.deadline = Date.now() + this.serverBudget
        this.baseUrl = this.candidateBases()[0]
        const parsed = this.splitMeta(episode.id)
        const dataIds = parsed.base
        const audio = parsed.audio

        const $ = await this.serverListDoc(dataIds)
        const groups = audio === "dub" ? ["dub"] : ["sub", "hsub"]
        const KNOWN_SERVERS = ["HD-2", "HD-1", "Vidstream-2"]
        const candidates = this.collectServers($, groups)
            .filter((c) => KNOWN_SERVERS.indexOf(c.name) !== -1)
            .sort((a, b) => KNOWN_SERVERS.indexOf(a.name) - KNOWN_SERVERS.indexOf(b.name))
        if (candidates.length === 0) throw this.fail("server", audio === "dub" ? "no dub is available for this episode" : "no server available for this episode")

        const wantSubs = this.loadSubtitles !== "disabled"
        let playableNoSubs: EpisodeServer | undefined
        let lastReason = ""
        const seenUrl: { [key: string]: boolean } = {}
        const tried: string[] = []
        for (const c of candidates) {
            if (this.outOfTime()) break
            tried.push(c.linkId)
            let resolved: EpisodeServer | undefined
            try {
                resolved = await this.resolveServer(c.linkId, c.name, audio)
            } catch (e) {
                lastReason = typeof e === "string" ? e : e instanceof Error ? e.message : ""
            }
            if (!resolved) continue
            const sourceUrl = resolved.videoSources[0].url
            if (seenUrl[`#${sourceUrl}`]) continue
            seenUrl[`#${sourceUrl}`] = true
            resolved.server = "Auto"
            const playable = await this.isPlayable(resolved, !playableNoSubs)
            if (playable) {
                if (!wantSubs || resolved.videoSources[0].subtitles.length > 0) {
                    await this.alignSubtitleHost(resolved)
                    return resolved
                }
                if (!playableNoSubs) playableNoSubs = resolved
            }
        }
        if (playableNoSubs) return playableNoSubs
        try {
            for (const id of tried) $store.remove(`anikoto:src:${id}`)
            $store.remove(`anikoto:slist:${dataIds}`)
        } catch (_e) {}
        const hint = this.solverEnabled() ? "" : "; if sources are Cloudflare-protected, enable the custom solver in settings (run it via Aqua's Utils)"
        throw this.fail("server", "no playable server found for this episode" + (lastReason ? ` — ${lastReason}` : hint))
    }

    private sourcePaths(origin: string): string[] {
        const out: string[] = []
        const learned = this.readCache<string>(`anikoto:srcpath:${origin}`, this.tokenTtl)
        if (learned) out.push(learned)
        for (const p of ["stream/getSourcesNew", "stream/getSources"]) {
            if (out.indexOf(p) === -1) out.push(p)
        }
        return out
    }

    private async trySourcePath(origin: string, path: string, dataId: string, embedUrl: string, cdn: string, decode: boolean): Promise<SourcePayload | undefined> {
        try {
            const res = await this.fetchRetry(`${origin}/${path}?id=${encodeURIComponent(dataId)}${cdn ? `&s=${encodeURIComponent(cdn)}` : ""}`, {
                headers: { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest" },
            })
            if (!res.ok) return undefined
            const body = res.json<SourcePayload>()
            if (decode && body && !body.sources && body.enc) {
                const plain = await this.decodeEnc(origin, embedUrl, String(body.enc))
                if (plain && plain.file) body.sources = { file: plain.file }
            }
            if (!body || !body.sources) return undefined
            this.writeCache(`anikoto:srcpath:${origin}`, path)
            return body
        } catch (_e) {
            return undefined
        }
    }

    private async embedScripts(guard: string, origin: string, embedUrl: string, visit: (body: string) => boolean): Promise<void> {
        if (this.readCache<number>(guard, this.resolveDownTtl)) return
        this.writeCache(guard, 1)
        try {
            const page = await this.fetchRetry(embedUrl, { headers: { Referer: `${this.baseUrl}/` } })
            if (!page.ok) return
            const html = page.text()
            const re = /<script[^>]+src="([^"]+)"/g
            const scripts: string[] = []
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                const u = this.absoluteUrl(m[1])
                if (u.indexOf(origin) === 0 && scripts.length < 12) scripts.push(u)
            }
            for (const s of scripts) {
                if (this.outOfTime()) break
                let js: FetchResponse
                try {
                    js = await this.fetchRetry(s, { headers: { Referer: embedUrl } })
                } catch (_e) {
                    continue
                }
                if (js.ok && visit(js.text())) break
            }
        } catch (_e) {}
    }

    private async discoverSourcePaths(origin: string, embedUrl: string): Promise<string[]> {
        const out: string[] = []
        await this.embedScripts(`anikoto:srcscan:${origin}`, origin, embedUrl, (body) => {
            const pr = /["']((?:[\w-]+\/)+getSources[\w]*)["']/g
            let pm: RegExpExecArray | null
            while ((pm = pr.exec(body)) !== null) if (out.indexOf(pm[1]) === -1) out.push(pm[1])
            return false
        })
        const known = this.sourcePaths(origin)
        const fresh = out.filter((p) => known.indexOf(p) === -1)
        if (fresh.length > 0) this.reportError("server", "the source endpoint moved; found " + fresh.join(", "), "warn")
        return out
    }

    private async serverListDoc(dataIds: string): Promise<DocSelectionFunction> {
        const cacheKey = `anikoto:slist:${dataIds}`
        let html = this.readCache<string>(cacheKey, this.serverCacheTtl)
        if (!html) {
            const slRes = await this.guarded(
                "server",
                `${this.baseUrl}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`,
                { headers: this.ajaxHeaders() }
            )
            const slHtml = slRes.text()
            if (this.isChallengeResponse(slRes, slHtml)) throw this.fail("server", "the site is showing an anti-bot challenge on this mirror — retry later or switch mirrors")
            if (!slRes.ok) throw this.fail("server", `server list failed (status ${slRes.status})`)
            const sl = this.parseJson<{ status: number; result: string }>(slHtml)
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

    private async resolveServer(linkId: string, serverName: string, audio: string): Promise<EpisodeServer> {
        const got = await this.fetchSources(linkId)
        if (!got || !got.file) throw `${serverName} could not resolve the player URL (source may be encrypted or down)`
        if (audio === "dub" && got.embedAudio === "sub") throw `${serverName} offered the subbed (Japanese) track for a dub request`
        if (audio !== "dub" && got.embedAudio === "dub") throw `${serverName} offered the dubbed track for a sub request`
        const subtitles = this.buildSubtitles(got.tracks)
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
            const pre = this.readCache<{ cookie: string; ua: string }>(`anikoto:cf:${this.hostOf(src.url)}`, this.clearanceTtl)
            if (pre) server.headers = this.withClearance(origHeaders, pre)
            let body = await this.fetchPlaylist(src.url, server.headers)
            if (body === undefined && allowSolver && this.solverEnabled() && !this.outOfTime()) {
                const cl = await this.solverClearance(src.url)
                if (cl) {
                    server.headers = this.withClearance(origHeaders, cl)
                    body = await this.fetchPlaylist(src.url, server.headers)
                }
            }
            if (body === undefined) {
                const swapped = await this.playableOnKnownHost(src.url, server.headers)
                if (swapped) {
                    src.url = swapped.url
                    body = swapped.body
                }
            }
            if (body === undefined) return false
            if (/^https?:\/\/[^/]+\/anime\//.test(src.url)) this.rememberCdnHost(this.hostOf(src.url))
            const variants = this.variantLevelUrls(body, src.url)
            if (variants.length === 0) return true
            for (const v of variants) {
                if (this.outOfTime()) return v === variants[0]
                try {
                    const r = await fetch(v, { headers: server.headers })
                    if (r.ok) return true
                } catch (_e) {}
            }
            return false
        } catch (_e) {
            return false
        }
    }

    private async decodeEnc(origin: string, embedUrl: string, enc: string): Promise<{ file?: string } | undefined> {
        if (!enc || enc.length > 65536) return undefined
        let b64 = enc.replace(/-/g, "+").replace(/_/g, "/")
        const pad = b64.length % 4
        if (pad) b64 = b64 + "====".slice(pad)
        const hit = this.tryKeys(origin, b64, this.knownKeys(origin))
        if (hit) return hit
        return this.tryKeys(origin, b64, await this.scanEncKeys(origin, embedUrl))
    }

    private tryKeys(origin: string, b64: string, pairs: { key: string; iv: string }[]): { file?: string } | undefined {
        for (const pair of pairs) {
            try {
                const keyBytes = new Uint8Array(32)
                const raw = $toBytes(pair.key)
                for (let i = 0; i < raw.length && i < 32; i++) keyBytes[i] = raw[i]
                const out = CryptoJS.AES.decrypt(b64, keyBytes, { iv: $toBytes(pair.iv) })
                const text = out.toString(CryptoJS.enc.Utf8)
                if (!text || text.indexOf("http") === -1) continue
                const obj = JSON.parse(text)
                if (obj && typeof obj.file === "string") {
                    this.writeCache(`anikoto:enckey:${origin}`, pair)
                    return obj
                }
            } catch (_e) {}
        }
        return undefined
    }

    private knownKeys(origin: string): { key: string; iv: string }[] {
        const out: { key: string; iv: string }[] = []
        const learned = this.readCache<{ key: string; iv: string }>(`anikoto:enckey:${origin}`, this.tokenTtl)
        if (learned && learned.key && learned.iv) out.push(learned)
        out.push({ key: "i?LMTAx0Q6,:}50U", iv: "W0;27ToaUpl_P%'c" })
        return out
    }

    private async scanEncKeys(origin: string, embedUrl: string): Promise<{ key: string; iv: string }[]> {
        const out: { key: string; iv: string }[] = []
        await this.embedScripts(`anikoto:encscan:${origin}`, origin, embedUrl, (body) => {
            const re = /=\s*"([^"\\]{16,32})"\s*,\s*\w+\s*=\s*"([^"\\]{16,32})"/g
            let m: RegExpExecArray | null
            while (out.length < 24 && (m = re.exec(body)) !== null) out.push({ key: m[1], iv: m[2] })
            const lits: string[] = []
            const er = /\.encode\(\s*"([^"\\]{16,32})"\s*\)/g
            while ((m = er.exec(body)) !== null) lits.push(m[1])
            for (let i = 0; i + 1 < lits.length; i += 2) out.push({ key: lits[i], iv: lits[i + 1] })
            return out.length >= 24
        })
        const known = this.knownKeys(origin)
        if (out.some((p) => !known.some((k) => k.key === p.key && k.iv === p.iv))) {
            this.reportError("server", "the source cipher changed; trying recovered keys", "warn")
        }
        return out
    }

    private cdnHosts(): string[] {
        const out: string[] = []
        const learned = this.readCache<string[]>("anikoto:cdnhosts", this.tokenTtl)
        if (learned && typeof learned.length === "number") {
            for (const h of learned) if (h && out.indexOf(h) === -1) out.push(h)
        }
        for (const h of ["ncdn.imgnex.top"]) if (out.indexOf(h) === -1) out.push(h)
        return out
    }

    private rememberCdnHost(host: string): void {
        if (!host) return
        const list = this.cdnHosts()
        if (list.indexOf(host) === 0) return
        const next: string[] = [host]
        for (const h of list) {
            if (h !== host && next.length < 6) next.push(h)
        }
        this.writeCache("anikoto:cdnhosts", next)
    }

    private async alignSubtitleHost(server: EpisodeServer): Promise<void> {
        const src = server.videoSources[0]
        if (!src || !src.url || !src.subtitles || src.subtitles.length === 0) return
        const videoHost = this.hostOf(src.url)
        if (!videoHost) return
        const pick = src.subtitles[0]
        const subHost = this.hostOf(pick.url)
        if (!subHost || subHost === videoHost) return
        if ((await this.fetchPlaylist(pick.url, server.headers, "WEBVTT")) !== undefined) return
        const hosts = [videoHost]
        for (const h of ["ncdn.imgnex.top"].concat(this.cdnHosts())) if (hosts.indexOf(h) === -1) hosts.push(h)
        for (const host of hosts) {
            if (host === subHost) continue
            if (host !== videoHost && host !== "ncdn.imgnex.top" && this.outOfTime()) return
            const swapped = pick.url.replace(`://${subHost}/`, `://${host}/`)
            if (swapped === pick.url) return
            if ((await this.fetchPlaylist(swapped, server.headers, "WEBVTT")) === undefined) continue
            for (const s of src.subtitles) {
                const h = this.hostOf(s.url)
                if (h && h !== host) s.url = s.url.replace(`://${h}/`, `://${host}/`)
            }
            this.reportError("server", `the subtitle host ${subHost} could not be reached; serving subtitles from ${host} instead`, "warn")
            return
        }
    }

    private async playableOnKnownHost(url: string, headers: { [k: string]: string }): Promise<{ url: string; body: string } | undefined> {
        const current = this.hostOf(url)
        if (!current) return undefined
        for (const h of this.cdnHosts()) {
            if (h === current) continue
            const candidate = url.replace("://" + current + "/", "://" + h + "/")
            if (candidate === url) continue
            const body = await this.fetchPlaylist(candidate, headers)
            if (body !== undefined) return { url: candidate, body: body }
            if (this.outOfTime()) break
        }
        return undefined
    }

    private async fetchPlaylist(url: string, headers: { [k: string]: string }, marker = "#EXTM3U"): Promise<string | undefined> {
        try {
            const res = await fetch(url, { headers: headers })
            if (!res.ok) return undefined
            const body = res.text()
            return body.indexOf(marker) !== -1 ? body : undefined
        } catch (_e) {
            return undefined
        }
    }

    private solverEnabled(): boolean {
        const down = this.readCache<number>("anikoto:solverdown", this.solverCooldown)
        return (this.useCustomSolver || "").toLowerCase() === "on" && this.solverEndpoint() !== "" && (down === undefined || Date.now() >= down)
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
                noCloudflareBypass: true,
            })
            if (!res.ok) {
                if (res.status >= 500) this.writeCache("anikoto:solverdown", Date.now() + this.solverCooldown)
                return undefined
            }
            this.writeCache("anikoto:solverdown", 0)
            const data = res.json<{ status?: string; gate?: string; solution?: { userAgent?: string; cookies?: { name: string; value: string }[] } }>()
            if (!data || data.status !== "ok") {
                this.reportError("solver", "the helper did not succeed" + (data && data.gate ? " (" + data.gate + ")" : ""))
                return undefined
            }
            const sol = data.solution
            if (!sol || !Array.isArray(sol.cookies)) return undefined
            const parts: string[] = []
            for (const c of sol.cookies) {
                if (c && c.name && /cf_clearance|^__cf|^cf_|^__ddg/i.test(c.name)) parts.push(`${c.name}=${c.value}`)
            }
            if (parts.length === 0 || !sol.userAgent) return undefined
            const cl = { cookie: parts.join("; "), ua: sol.userAgent }
            this.writeCache(`anikoto:cf:${this.hostOf(url)}`, cl)
            return cl
        } catch (_e) {
            this.writeCache("anikoto:solverdown", Date.now() + this.solverCooldown)
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
            headers: this.ajaxHeaders(),
        })
        if (!psRes.ok) return undefined
        const ps = psRes.json<{ status: number; result: { url: string } }>()
        let embedUrl = ps && ps.result ? ps.result.url : undefined
        if (!embedUrl) return undefined
        const cdn = (embedUrl.match(/[?&]s=([\w-]+)/) || [])[1] || ""

        const origin = this.originOf(embedUrl)
        const embedRes = await this.fetchRetry(embedUrl, { headers: { Referer: `${this.baseUrl}/` } })
        if (!embedRes.ok) return undefined

        const ehtml = embedRes.text()
        let dataId = this.dataIdIn(ehtml, ["#megaplay-player", "[id*='player'][data-id]"], /data-id="([^"]+)"/)
        if (!dataId) {
            const ifr = ehtml.match(/<iframe[^>]+\bsrc="([^"]*\/stream\/[^"]*)"/i)
            const inner = ifr ? this.absoluteUrl(ifr[1]) : ""
            if (inner && this.originOf(inner) === origin) {
                const innerRes = await this.fetchRetry(inner, { headers: { Referer: embedUrl } })
                if (innerRes.ok) {
                    const ih = innerRes.text()
                    dataId = this.dataIdIn(ih, ["#megaplay-player", "[id*='player'][data-id]"], /data-id="([^"]+)"/)
                    if (dataId) embedUrl = inner
                }
            }
        }
        if (!dataId || !/^[\w.-]{1,256}$/.test(dataId)) return undefined

        let data: SourcePayload | undefined
        for (const path of this.sourcePaths(origin)) if ((data = await this.trySourcePath(origin, path, dataId, embedUrl, cdn, true))) break
        if (!data) for (const path of await this.discoverSourcePaths(origin, embedUrl)) if ((data = await this.trySourcePath(origin, path, dataId, embedUrl, cdn, false))) break
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

    private buildSubtitles(tracks: { file: string; label?: string; kind?: string; default?: boolean }[] | undefined): VideoSubtitle[] {
        const collected: VideoSubtitle[] = []
        if (this.loadSubtitles === "disabled") return collected
        if (!tracks || tracks.length === 0) return collected

        const valid = tracks.filter((t) => t && typeof t.file === "string" && /^https?:\/\//i.test(t.file) && (!t.kind || t.kind === "captions" || t.kind === "subtitles"))
        if (valid.length === 0) return collected
        const seenSrc: { [key: string]: boolean } = {}
        const nonDialogue: boolean[] = []
        let pick = 0
        let best = -1

        for (let i = 0; i < valid.length; i++) {
            const t = valid[i]
            const label = (t.label || "").trim()
            const en = this.fallbackCode(label) === "en"
            if (seenSrc[t.file]) continue
            seenSrc[t.file] = true
            const idx = collected.length
            collected.push({
                id: String(idx),
                url: t.file,
                language: this.cleanLabel(label) || "English",
                isDefault: false,
            })
            const score = this.trackScore(label, en, t.default === true)
            nonDialogue.push(this.isNonDialogue(label))
            if (score > best) {
                best = score
                pick = idx
            }
        }

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

    private trackScore(label: string, isEnglish: boolean, def: boolean): number {
        const mtl = /\b(?:ai|mtl)\b/i.test(label || "")
        const alt = /\b(?:sdh|cc|closed[\s-]?captions?|hearing[\s-]?impaired|dub[\s-]?titles?)\b/i.test(label || "")
        const base = this.isNonDialogue(label) ? (isEnglish ? 3 : 0) : mtl ? (isEnglish ? 4 : 1) : alt ? (isEnglish ? 5 : 1) : isEnglish ? 6 : 2
        return def ? base * 10 + 1 : base * 10
    }

    private cleanLabel(label: string): string {
        const l = (label || "").trim()
        if (!l) return l
        const nested = /^(.*?)\s*\(-\s*[^()]*\(([^()]+)\)\s*\)$/.exec(l)
        if (nested) {
            const base = nested[1].trim()
            const region = nested[2].trim()
            if (!region || region.toLowerCase() === base.toLowerCase()) return base
            return `${base} (${region})`
        }
        const flat = /^(.*?)\s*\(-\s*[^()]*\)$/.exec(l)
        if (flat && flat[1].trim()) return flat[1].trim()
        return l
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
            dan: "da", danish: "da",
            nor: "no", norwegian: "no",
            fin: "fi", finnish: "fi",
            hun: "hu", hungarian: "hu",
            heb: "he", hebrew: "he",
            fil: "tl", filipino: "tl", tagalog: "tl",
        }
        for (const w of words) {
            if (map[w]) return map[w]
        }
        return ""
    }

    private applySeasonWindow(episodes: EpisodeDetails[], epCount: number, part: number, total: number): void {
        if (epCount <= 0 || total <= epCount) return
        const offset = part >= 2 ? total - epCount : 0
        const picked = episodes.filter((e) => e.number > offset && e.number <= offset + epCount)
        for (const e of picked) e.number -= offset
        episodes.length = 0
        for (const e of picked) episodes.push(e)
        this.reportError("episodes", `the site lists this season as one run of ${total} episodes; showing the ${part >= 2 ? "last" : "first"} ${epCount} so the numbering matches the tracker`, "info")
    }

    private withMeta(base: string, audio: string, anilistId: number, epCount: number, part: number): string {
        return `${base}$${audio}` + (epCount > 0 ? `$ec${epCount}$pt${part > 0 ? part : 0}` : "") + (anilistId > 0 ? `$al${anilistId}` : "")
    }

    private splitMeta(id: string): { base: string; audio: string; anilistId: number; epCount: number; part: number } {
        const m = /^([\s\S]*?)(?:\$(sub|dub))?(?:\$ec(\d+))?(?:\$pt(\d+))?(?:\$al(\d+))?$/.exec(id)!
        const known = parseInt(m[5] || "0", 10) || this.readCache<number>(`anikoto:al:${this.seriesUrl(m[1])}`, this.idCacheTtl)
        return { base: m[1], audio: m[2] || "sub", anilistId: known && known > 0 ? known : 0, epCount: parseInt(m[3] || "0", 10), part: parseInt(m[4] || "0", 10) }
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            console.error("SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-anikoto", scope: scope, msg: this.plain(message), lvl: lvl }))
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

    private isChallengeResponse(res: FetchResponse, body: string, doc?: DocSelectionFunction): boolean {
        const h = res.headers || {}
        for (const k in h) {
            if (k.toLowerCase() === "cf-mitigated" && String(h[k]).toLowerCase().indexOf("challenge") !== -1) return true
        }
        if (res.status === 403 || res.status === 503) return !this.bodyIsSitePage(body, doc)
        const b = (body || "").toLowerCase()
        return ["cf-mitigated", "cf-browser-verification", "/cdn-cgi/challenge-platform", "ddos-guard", "just a moment...</title>", "attention required! | cloudflare"].some((t) => b.indexOf(t) !== -1) && !this.bodyIsSitePage(body, doc)
    }

    private bodyIsSitePage(body: string, doc?: DocSelectionFunction): boolean {
        if (!body && !doc) return false
        try {
            const $ = doc || LoadDoc(body)
            return $("footer").length() > 0 || $("div.item").length() > 0
        } catch (_e) {
            return false
        }
    }

    private outOfTime(): boolean {
        return this.deadline > 0 && Date.now() > this.deadline
    }

    private readCache<T>(key: string, ttl?: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        const max = ttl === undefined ? this.cacheTtl : ttl
        if (entry && entry.at > 0 && Date.now() - entry.at < max) return entry.data
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

    private seriesUrl(href: string): string {
        return this.absoluteUrl(href).replace(/[?#][\s\S]*$/, "").replace(/\/ep-[^/]+\/?$/i, "")
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
