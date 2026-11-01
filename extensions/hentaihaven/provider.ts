declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Post = { id: number; slug: string; title: string; years?: number[] }
type Chapter = { id: number; n: number; slug: string; octo: boolean }
type Form = { flat: string; base: string; seq: number; words: number; full: boolean; pre?: boolean }

class Provider implements AnimeProvider {
    private site = "https://hentaihaven.xxx"
    private api = "https://cms.hentaihaven.xxx/wp-json"
    private ua = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" }
    private catalogTtl = 6 * 3600000
    private langs: { [code: string]: string } = { ar: "Arabic", cs: "Czech", da: "Danish", el: "Greek", fi: "Finnish", he: "Hebrew", hu: "Hungarian", id: "Indonesian", nl: "Dutch", pl: "Polish", ro: "Romanian", sv: "Swedish", th: "Thai", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese" }

    getSettings(): Settings {
        return { episodeServers: ["Hentai Haven"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (opts.dub) return []
        const media = opts.media
        if (!media || !(media.id > 0)) return this.manual(opts.query || "")
        const forms = this.mediaForms(media)
        if (forms.length === 0) return []
        let cands = this.rank(forms, await this.catalog(false))
        if (cands.length === 0) cands = this.rank(forms, await this.catalog(true))
        const pick = await this.choose(cands, media.episodeCount && media.episodeCount > 0 ? media.episodeCount : 0, (media.startDate && media.startDate.year) || 0)
        return pick ? [this.result(pick)] : []
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const [post, slug] = id.split("$")
        if (!/^\d+$/.test(post || "")) throw this.fail("episodes", "Hentai Haven: unrecognized series id - match the series again")
        const eps = await this.episodes(+post, "episodes")
        if (!eps) throw this.fail("episodes", "Hentai Haven: this series is no longer on the site - match it again", "info")
        return eps.map((e) => ({ id: `${post}$${e.id}`, number: e.n, url: slug ? `${this.site}/watch/${slug}/${e.slug}/` : this.site }))
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const [post, chapter] = episode.id.split("$")
        const n = episode.number
        if (!/^\d+$/.test(post || "") || !/^\d+$/.test(chapter || "")) throw this.fail("server", "Hentai Haven: unrecognized episode id - refresh the episode list")
        const list = (await this.raw(+post, "server")) || []
        let ch = list.filter((c) => c && String(c.chapter_id) === chapter && !c.is_deleted)[0]
        if (!ch) {
            const e = this.best(list).filter((x) => x.n === n)[0]
            ch = e && list.filter((c) => c && c.chapter_id === e.id)[0]
        }
        if (!ch) throw this.fail("server", `Hentai Haven: episode ${n} is no longer on the site - refresh the episode list`, "info")
        const url = ch.indexable_content_url
        if (typeof url !== "string" || !/^https:\/\/[^\s"?#]+\.m3u8(?:\?[^\s"]*)?$/.test(url)) throw this.changed("server", "stream links")
        const legacy = Number(ch.is_octopus_import) !== 1
        const master = await this.playlist(url, `episode ${n}'s stream`, legacy ? n : 0)
        if (legacy) await this.alive(url, master, n)
        return { server: "Hentai Haven", headers: {}, videoSources: [{ url, type: "m3u8", quality: "auto", subtitles: this.subtitles(url, master) }] }
    }

    private async manual(query: string): Promise<SearchResult[]> {
        const q = this.squash(this.norm(query))
        if (q.length < 2) return []
        const find = (posts: Post[]) => posts.map((p) => ({ p, f: this.squash(this.norm(p.title)) })).filter((x) => x.f.indexOf(q) !== -1)
        let hits = find(await this.catalog(false))
        if (hits.length === 0) hits = find(await this.catalog(true))
        hits.sort((a, b) => Number(b.f === q) - Number(a.f === q) || a.f.indexOf(q) - b.f.indexOf(q) || a.f.length - b.f.length)
        const list = hits.slice(0, 30).map((x) => x.p)
        return list.map((p) => this.result(p, list.filter((o) => o.title === p.title).length > 1))
    }

    private result(p: Post, tag?: boolean): SearchResult {
        return { id: `${p.id}$${p.slug}`, title: tag ? `${p.title} (${p.slug})` : p.title, url: `${this.site}/watch/${p.slug}/`, subOrDub: "sub" }
    }

    private mediaForms(media: Media): Form[] {
        const main = [media.romajiTitle || "", media.englishTitle || ""].map((t) => t.replace(/\(((?:19|20)\d\d)\)/g, " $1 ")).filter((t) => this.usable(t))
        const lead = this.usable(media.romajiTitle || "") ? this.squash(this.norm(main[0])) : ""
        const special = /\b(?:specials?|bonus|extra|omake|recap)(?: video| episode)?$/.test(this.norm(main[0] || ""))
        const shorts = special ? [] : main.map((t) => this.short(t)).filter((s, i) => s !== main[i] && (!lead || lead.indexOf(this.squash(this.norm(s))) === 0))
        const weak = shorts.map((s) => this.form(s, false)).filter((f) => f).map((f) => this.key(f as Form))
        const out: Form[] = []
        const add = (t: string, full: boolean) => {
            const f = this.usable(t) ? this.form(t, full) : null
            if (!f) return
            if (weak.indexOf(this.key(f)) !== -1) f.full = false
            out.push(f)
        }
        for (const t of main) add(t, true)
        if (lead && out.length) out[0].pre = true
        for (const t of shorts.concat(media.synonyms || [])) add(t, false)
        return out
    }

    private siteForms(p: Post): Form[] {
        const out = p.title.split(/\s+\/\s+/).map((t) => this.form(t, true))
        const s = this.short(p.title)
        if (s !== p.title) out.push(this.form(s, false))
        return out.filter((f) => f) as Form[]
    }

    private rank(forms: Form[], posts: Post[]): { post: Post; score: number }[] {
        const out: { post: Post; score: number }[] = []
        for (const post of posts) {
            let score = 0
            for (const s of this.siteForms(post)) {
                for (const m of forms) {
                    if (m.seq !== s.seq) continue
                    if (m.flat === s.flat) score = Math.max(score, m.full && s.full ? 3 : 2)
                    else if (m.pre && s.full && s.words >= 2 && s.flat.length >= 10 && m.flat.indexOf(s.flat) === 0 && !/^\d/.test(m.flat.slice(s.flat.length)) && !/\b(?:specials?|sp|extra|bonus|omake|gaiden|motto|prequel|another|shinshou|zoku|kanketsu(?:hen)?|kouhen|zenpen|final|recap|plus)$/.test(m.base)) score = Math.max(score, 1)
                }
            }
            if (score) out.push({ post, score })
        }
        return out
    }

    private async choose(cands: { post: Post; score: number }[], eps: number, year: number): Promise<Post | null> {
        for (const tier of [3, 2, 1]) {
            const live: { post: Post; n: number }[] = []
            for (const c of cands.filter((x) => x.score === tier).slice(0, 4)) {
                const years = c.post.years || []
                if (year && years.length && years.indexOf(year) === -1 && (tier === 2 || /(?:^|\s)1(?:\s|$)/.test(c.post.title))) continue
                const n = ((await this.episodes(c.post.id, "search")) || []).length
                const cut = /(?:…|\.\.\.)\s*$/.test(c.post.title)
                if (n > 0 && (tier === 3 || !eps || n === eps || (cut && n < eps))) live.push({ post: c.post, n })
            }
            const exact = live.filter((x) => x.n === eps)
            const pool = exact.length ? exact : live
            if (pool.length === 1) return pool[0].post
            if (pool.length > 1) return null
        }
        return null
    }

    private usable(t: string): boolean {
        return !!t && !/[○●◯〇□■]/.test(t)
    }

    private short(t: string): string {
        return t.split(/\s*(?::|\s[-–—]\s|[~～])\s*/)[0].trim()
    }

    private key(f: Form): string {
        return `${f.flat}#${f.seq}`
    }

    private form(raw: string, full: boolean): Form | null {
        let seq = 1
        let base = this.norm(raw).replace(/\b(?:season (\d+)|(\d+)(?:st|nd|rd|th) season)\b/, (_m: string, a: string, b: string) => {
            seq = parseInt(a || b, 10)
            return " "
        })
        base = base.replace(/\s+/g, " ").trim()
        const t = seq === 1 ? base.match(/^(.+) ([1-9])$/) : null
        if (t) {
            base = t[1]
            seq = parseInt(t[2], 10)
        }
        const flat = this.squash(base)
        return flat ? { flat, base, seq, words: base.split(" ").length, full } : null
    }

    private norm(t: string): string {
        return (t || "")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[’'‘`´]/g, "")
            .replace(/&/g, " and ")
            .replace(/\([^)]*\)/g, " ")
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\bx\b/g, " ")
            .replace(/\b(?:hentai haven|the animation|ova|hentai|uncensored)\b/g, " ")
            .replace(/\bii\b/g, "2")
            .replace(/\biii\b/g, "3")
            .replace(/\bwo\b/g, "o")
            .replace(/\s+/g, " ")
            .trim()
    }

    private squash(s: string): string {
        return s.replace(/\s+/g, "").replace(/ou/g, "o").replace(/(.)\1+/g, "$1")
    }

    private decode(s: string): string {
        const named: { [k: string]: string } = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }
        return s
            .replace(/&#(\d+);/g, (_m: string, d: string) => String.fromCodePoint(parseInt(d, 10)))
            .replace(/&#x([0-9a-f]+);/gi, (_m: string, h: string) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_m: string, k: string) => named[k])
    }

    private async catalog(fresh: boolean): Promise<Post[]> {
        const key = "hentaihaven:catalog"
        const hit = $store.get<{ at: number; top: number; data: Post[]; terms?: { [id: number]: number } } | undefined>(key)
        const now = Date.now()
        const full = !hit || now - hit.at >= this.catalogTtl
        if (hit && !full && (!fresh || now - hit.top < 600000)) return hit.data
        const terms: { [id: number]: number } = (hit && !full && hit.terms) || {}
        if (full) {
            const tu = `${this.api}/wp/v2/wp-manga-release?per_page=100&_fields=id,name`
            const tr = await this.call(tu, "search", "the catalog")
            const rows = tr.ok ? this.body(tr) : null
            if (Array.isArray(rows)) for (const t of rows) if (t && typeof t.id === "number") terms[t.id] = parseInt(t.name, 10) || 0
        }
        const seen: { [id: number]: boolean } = {}
        const out: Post[] = []
        for (let page = 1; page <= (full ? 50 : 1); page++) {
            const url = `${this.api}/wp/v2/wp-manga?per_page=100&page=${page}&_fields=id,slug,title,wp-manga-release`
            const res = await this.call(url, "search", "the catalog")
            if (res.status === 400 && page > 1) break
            const rows = this.body(this.check(res, url, "search", "the catalog"))
            if (!Array.isArray(rows)) throw this.changed("search", "the catalog")
            for (const r of rows) {
                if (!r || typeof r.id !== "number" || !r.title || typeof r.title.rendered !== "string") throw this.changed("search", "the catalog")
                if (!seen[r.id]) out.push({ id: r.id, slug: typeof r.slug === "string" ? r.slug : "", title: this.decode(r.title.rendered).trim(), years: (Array.isArray(r["wp-manga-release"]) ? r["wp-manga-release"] : []).map((i: number) => terms[i]).filter((y: number) => y > 0) })
                seen[r.id] = true
            }
            if (rows.length < 100) break
        }
        if (hit && !full) for (const p of hit.data) if (!seen[p.id]) out.push(p)
        $store.set(key, { at: hit && !full ? hit.at : now, top: now, data: out, terms })
        return out
    }

    private async raw(post: number, scope: string): Promise<any[] | null> {
        const url = `${this.api}/hhaven/v1/manga/${post}/chapters`
        const res = await this.call(url, scope, "the episode list")
        if (res.status === 404 && (this.body(res) || {}).code === "manga_not_found") return null
        const data = this.body(this.check(res, url, scope, "the episode list"))
        if (!Array.isArray(data) || (data.length && !data.some((c) => c && typeof c.chapter_id === "number" && typeof c.episode_slug === "string"))) throw this.changed(scope, "the episode list")
        return data
    }

    private async episodes(post: number, scope: string): Promise<Chapter[] | null> {
        const key = `hentaihaven:eps:${post}`
        const hit = this.readCache<Chapter[]>(key, 120000)
        if (hit) return hit
        const data = await this.raw(post, scope)
        if (!data) return null
        const out = this.best(data)
        this.writeCache(key, out)
        return out
    }

    private best(data: any[]): Chapter[] {
        const best: { [n: number]: Chapter } = {}
        for (const c of data) {
            const m = c && !c.is_deleted && typeof c.chapter_id === "number" && typeof c.episode_slug === "string" ? c.episode_slug.match(/^(?:episode|epsiode)(?:-(\d+))?(?:-uncensored)?$/) : null
            const n = m ? (m[1] ? parseInt(m[1], 10) : 1) : 0
            if (n <= 0) continue
            const ch = { id: c.chapter_id, n, slug: c.episode_slug, octo: Number(c.is_octopus_import) === 1 }
            const old = best[n]
            if (!old || (ch.octo && !old.octo) || (ch.octo === old.octo && ch.id > old.id)) best[n] = ch
        }
        return Object.keys(best).map((k) => best[+k]).sort((a, b) => a.n - b.n)
    }

    private async playlist(url: string, what: string, old: number): Promise<string> {
        const res = await this.call(url, "server", what)
        if (old && res.status === 404) throw this.offline(old, url.split("/")[2], "no longer has it (HTTP 404)")
        const body = this.check(res, url, "server", what).text()
        if (!/^\s*#EXTM3U/.test(body)) throw this.fail("server", `Hentai Haven: ${what} on ${url.split("/")[2]} is not a playlist`)
        return body
    }

    private next(url: string, body: string, n: number): string {
        const line = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== "#")[0]
        if (!line) throw this.fail("server", `Hentai Haven: episode ${n}'s playlist on ${url.split("/")[2]} is empty`)
        return this.resolve(url, line)
    }

    private async alive(master: string, body: string, n: number): Promise<void> {
        const variant = this.next(master, body, n)
        const seg = this.next(variant, await this.playlist(variant, `episode ${n}'s playlist`, n), n)
        const host = seg.split("/")[2] || seg
        let res: FetchResponse | null = null
        let why = ""
        try {
            res = await fetch(seg, { method: "HEAD", headers: this.ua, noCloudflareBypass: true })
        } catch (e) {
            why = `is offline (${this.net(e)})`
        }
        if (res && res.ok) return
        if (res && (res.status === 404 || res.status === 410)) why = `no longer has it (HTTP ${res.status})`
        if (!res || why) throw this.offline(n, host, why)
        throw this.fail("server", `Hentai Haven: could not check episode ${n}'s old mirror - ${host} answered HTTP ${res.status}`)
    }

    private offline(n: number, host: string, why: string): string {
        return this.fail("server", `Hentai Haven: episode ${n} is still on the site's old mirror ${host}, which ${why} - it should play again once the site moves it to its new player`, "info")
    }

    private subtitles(url: string, master: string): VideoSubtitle[] {
        const subs: VideoSubtitle[] = []
        for (const line of master.split(/\r?\n/)) {
            if (line.indexOf("#EXT-X-MEDIA:") !== 0 || !/[:,]TYPE=SUBTITLES\b/.test(line)) continue
            const attr = (k: string) => (line.match(new RegExp(`[:,]${k}="([^"]*)"`)) || [])[1] || ""
            const uri = attr("URI")
            if (!uri) continue
            const lang = attr("LANGUAGE").toLowerCase()
            const name = attr("NAME")
            subs.push({ id: lang || String(subs.length), url: this.resolve(url, uri), language: this.langs[lang] || (name.length > 2 ? name : lang.toUpperCase() || name), isDefault: lang === "en" && !subs.some((s) => s.isDefault) })
        }
        return subs.filter((s) => s.isDefault).concat(subs.filter((s) => !s.isDefault))
    }

    private resolve(base: string, uri: string): string {
        if (/^https?:\/\//i.test(uri)) return uri
        if (uri[0] === "/") return base.replace(/^(https?:\/\/[^/]+).*$/i, "$1") + uri
        return base.replace(/[^/]*$/, "") + uri
    }

    private async call(url: string, scope: string, what: string): Promise<FetchResponse> {
        try {
            return await fetch(url, { headers: this.ua, noCloudflareBypass: true })
        } catch (e) {
            throw this.fail(scope, `Hentai Haven: could not load ${what} - ${url.split("/")[2]} ${this.net(e)}`)
        }
    }

    private check(res: FetchResponse, url: string, scope: string, what: string): FetchResponse {
        if (res.ok) return res
        if (res.status === 404 && (this.body(res) || {}).code === "rest_no_route") throw this.changed(scope, what)
        const wall = res.status === 403 && /challenge/i.test((res.headers && res.headers["Cf-Mitigated"]) || "")
        throw this.fail(scope, `Hentai Haven: could not load ${what} - ${url.split("/")[2]} ${wall ? "put up a Cloudflare challenge" : "answered"} (HTTP ${res.status})`)
    }

    private body(res: FetchResponse): any {
        try {
            return res.json()
        } catch (_e) {
            return null
        }
    }

    private changed(scope: string, what: string): string {
        return this.fail(scope, `Hentai Haven: the site changed how it serves ${what} - this extension needs an update`)
    }

    private net(e: unknown): string {
        const m = String(e instanceof Error ? e.message : (e && (e as any).message) || e).replace(/^\w+ "[^"]*": /, "")
        if (/did not answer in time|timed? ?out|deadline exceeded/i.test(m)) return "did not answer in time"
        if (/could not be found|cannot resolve|no such host|ENOTFOUND|EAI_AGAIN/i.test(m)) return "could not be found in DNS"
        if (/TLS|SSL|certificate|x509/i.test(m)) return "failed the TLS handshake"
        return `could not be reached: ${m.slice(0, 120)}`
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-hentaihaven", scope: scope, msg: this.plain(message), lvl: lvl })
            if (lvl) console.warn(line)
            else console.error(line)
        } catch (_e) {}
    }

    private plain(message: string): string {
        return String(message === undefined || message === null ? "" : message)
            .replace(/…/g, "...")
            .replace(/[—–]/g, "-")
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"')
            .replace(/\s+/g, " ")
            .replace(/[^\x20-\x7e]/g, "?")
            .trim()
    }

    private fail(scope: string, message: string, lvl?: "warn" | "info"): string {
        this.reportError(scope, message, lvl)
        return message
    }

    private readCache<T>(key: string, ttl: number): T | undefined {
        const entry = $store.get<{ at: number; data: T } | undefined>(key)
        if (entry && Date.now() - entry.at < ttl) return entry.data
        if (entry) $store.remove(key)
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        $store.set(key, { at: Date.now(), data })
    }
}
