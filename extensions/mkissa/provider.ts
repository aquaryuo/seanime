declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Show = {
    _id: string
    name?: string | null
    englishName?: string | null
    nativeName?: string | null
    altNames?: string[] | null
    type?: string | null
    aniListId?: string | number | null
    malId?: string | number | null
    airedStart?: { year?: number } | null
    availableEpisodes?: { sub?: number; dub?: number } | null
    availableEpisodesDetail?: { sub?: string[]; dub?: string[] } | null
}
type Source = { sourceUrl: string; sourceName?: string; priority?: number; slow?: boolean }
type Boot = { epoch: number; switchAt: number; key: string }
type Sub = { origin: string; lang: string; label?: string; def?: boolean }

const SBOX: number[] = (() => {
    const s: number[] = new Array(256)
    const rotl = (x: number, n: number): number => ((x << n) | (x >>> (8 - n))) & 255
    let p = 1
    let q = 1
    do {
        p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 255
        q ^= q << 1
        q ^= q << 2
        q ^= q << 4
        q &= 255
        if (q & 0x80) q ^= 0x09
        s[p] = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63
    } while (p !== 1)
    s[0] = 0x63
    return s
})()
const SHA_K = (
    "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 " +
    "e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 " +
    "27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 " +
    "19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2"
).split(" ").map((h) => parseInt(h, 16) | 0)
const SHA_H = "6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19".split(" ").map((h) => parseInt(h, 16) | 0)
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

class Provider implements AnimeProvider {
    private baseUrl = this.cfg("baseUrl", "https://mkissa.to").replace(/\/+$/, "")
    private api = "https://api.mkissa.net"
    private player = "https://filelotion.fyi"
    private build = "179"
    private mask = "b5905da39d2feab87b23661f2d791a560537111e8990186e405ed6cbc7701905"
    private bootPrefix = "KoCGqjW:"
    private lane = "k7"
    private cacheTtl = 900000
    private srcCacheTtl = 300000
    private serverBudget = 15000
    private ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    private busy = "mkissa: too many requests right now - wait a minute and retry"
    private stale = "mkissa: the site changed its player handshake - this extension needs an update"
    private captcha = "mkissa: the site wants a captcha for episode links from this IP right now - wait a while (or open an episode on mkissa.to once) and retry"

    getSettings(): Settings {
        return { episodeServers: ["Auto"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const media = opts.media || ({} as Media)
        const al = media.id > 0 ? media.id : 0
        if (al > 0) {
            const r = await this.gql("search", "query($_id:String!){show(_id:$_id){" + this.showFields() + " availableEpisodesDetail}}", { _id: String(al) })
            const show: Show | null = r && r.show
            if (show && show._id && String(show.aniListId) === String(al)) {
                this.writeCache(`mkissa:show:${show._id}`, show)
                const hit = this.result(show, opts.dub)
                return hit ? [hit] : []
            }
        }
        const queries = this.uniq([media.romajiTitle || "", media.englishTitle || "", opts.query || ""]).slice(0, 3)
        const cands: Show[] = []
        const seen: { [key: string]: boolean } = {}
        for (const q of queries) {
            const r = await this.gql("search", "query($search:SearchInput,$limit:Int,$page:Int,$countryOrigin:VaildCountryOriginEnumType){shows(search:$search,limit:$limit,page:$page,countryOrigin:$countryOrigin){edges{" + this.showFields() + "}}}", {
                search: { query: q, allowAdult: media.isAdult === true, allowUnknown: false },
                limit: 26,
                page: 1,
                countryOrigin: "ALL",
            })
            const edges: Show[] = (r && r.shows && r.shows.edges) || []
            for (const s of edges) {
                if (!s || !s._id || seen["#" + s._id]) continue
                seen["#" + s._id] = true
                if ((al > 0 && String(s.aniListId) === String(al)) || (media.idMal && String(s.malId) === String(media.idMal))) {
                    const hit = this.result(s, opts.dub)
                    return hit ? [hit] : []
                }
                cands.push(s)
            }
            if (this.pickBest(cands, media).length === 1) break
        }
        const out: SearchResult[] = []
        for (const s of this.pickBest(cands, media)) {
            const hit = this.result(s, opts.dub)
            if (hit) out.push(hit)
        }
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const parts = id.split("$")
        const showId = parts[0]
        const audio = parts[1] === "dub" ? "dub" : "sub"
        if (!/^\w{3,40}$/.test(showId)) return []
        let show = this.readCache<Show>(`mkissa:show:${showId}`, this.cacheTtl)
        if (!show || !show.availableEpisodesDetail) {
            const r = await this.gql("episodes", "query($_id:String!){show(_id:$_id){_id availableEpisodesDetail}}", { _id: showId })
            show = r && r.show
            if (!show) return []
            this.writeCache(`mkissa:show:${showId}`, show)
        }
        const list = (show.availableEpisodesDetail && show.availableEpisodesDetail[audio]) || []
        const episodes: EpisodeDetails[] = []
        const seen: { [key: string]: boolean } = {}
        for (const ep of list) {
            const s = String(ep)
            if (!/^\d+$/.test(s) || seen["#" + s] || parseInt(s, 10) < 1) continue
            seen["#" + s] = true
            episodes.push({ id: `${showId}$${audio}$${s}`, number: parseInt(s, 10), url: `${this.baseUrl}/anime/${showId}/p-${s}-${audio}` })
        }
        episodes.sort((a, b) => a.number - b.number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const deadline = Date.now() + this.serverBudget
        const parts = episode.id.split("$")
        const showId = parts[0]
        const audio = parts[1] === "dub" ? "dub" : "sub"
        const ep = parts[2] || String(episode.number)
        const ck = `mkissa:src:${showId}:${audio}:${ep}`
        let sources = this.readCache<Source[]>(ck, this.srcCacheTtl)
        if (!sources) {
            const r = await this.gql(
                "server",
                "query($showId:String!,$translationType:VaildTranslationTypeEnumType!,$episodeString:String!){episode(showId:$showId,translationType:$translationType,episodeString:$episodeString){episodeString sourceUrls show{_id}}}",
                { showId, translationType: audio, episodeString: ep },
                true
            )
            if (!r || !r.episode) throw this.fail("server", `mkissa: episode ${ep} (${audio}) is not on mkissa`, "info")
            sources = (r.episode.sourceUrls || []).filter((s: Source) => s && typeof s.sourceUrl === "string")
            this.writeCache(ck, sources)
        }
        const all = sources || []
        const cands = all.filter((s) => this.rank(s) >= 0).sort((a, b) => (a.slow ? 1 : 0) - (b.slow ? 1 : 0) || this.rank(a) - this.rank(b) || (b.priority || 0) - (a.priority || 0))
        if (cands.length === 0) throw this.fail("server", `mkissa: episode ${ep} only has players this extension cannot play (${all.map((s) => s.sourceName).join(", ") || "none"})`)
        const tried: string[] = []
        for (const s of cands) {
            if (Date.now() > deadline) break
            tried.push(s.sourceName || "source")
            try {
                const got = await this.resolve(s, Math.max(1, Math.min(10, Math.floor((deadline - Date.now()) / 1000))))
                if (got) return got
            } catch (_e) {}
            if (Date.now() > deadline) s.slow = true
        }
        const untried = cands.slice(tried.length).map((s) => s.sourceName || "source")
        if (untried.length) {
            this.writeCache(ck, all)
            throw this.fail("server", `mkissa: episode ${ep} ran out of time${tried.length ? ` on ${tried.join(", ")}` : ""} - retry to try ${untried.join(", ")}`)
        }
        try {
            $store.remove(ck)
        } catch (_e) {}
        const other = all.filter((s) => this.rank(s) < 0).map((s) => s.sourceName)
        throw this.fail("server", `mkissa: no playable source for episode ${ep} - ${tried.join(", ")} had no stream (removed or blocked)${other.length ? "; not supported: " + other.join(", ") : ""}`)
    }

    private rank(s: Source): number {
        const u = s.sourceUrl || ""
        if (u.indexOf("--") === 0) return 0
        if (/^https?:\/\/(?:www\.)?mp4upload\.com\/embed-/i.test(u)) return 1
        if (/^https?:\/\/(?:www\.)?ok\.ru\/videoembed\//i.test(u)) return 2
        return -1
    }

    private async resolve(s: Source, timeout: number): Promise<EpisodeServer | undefined> {
        const u = s.sourceUrl
        if (u.indexOf("--") === 0) {
            const path = this.unhex(u.slice(2))
            if (!/^\/apivtwo\/clock\?id=/.test(path)) return undefined
            const res = await fetch(this.player + path.replace("/clock?", "/clock.json?"), { headers: { Referer: `${this.player}/player.html` }, timeout })
            if (!res.ok) return undefined
            const links: any[] = (res.json<any>() || {}).links || []
            const videoSources: VideoSource[] = []
            for (const l of links) {
                const url = l && typeof l.link === "string" ? l.link : ""
                if (!/^https?:\/\//.test(url)) continue
                const hls = l.hls === true || /\.m3u8(?:$|\?)/.test(url)
                const subs: Sub[] = (l.subtitles || []).filter((t: any) => t && typeof t.src === "string").map((t: any) => ({ origin: t.src, lang: String(t.lang || "en"), label: t.label, def: t.default === "default" || t.default === true }))
                videoSources.push({ url, type: hls ? "m3u8" : /\.mp4/.test(url) ? "mp4" : "unknown", quality: hls || !l.resolutionStr ? "auto" : String(l.resolutionStr), subtitles: this.buildSubs(subs) })
            }
            return videoSources.length ? { server: "Auto", headers: {}, videoSources } : undefined
        }
        if (/mp4upload\.com/i.test(u)) {
            const html = await this.page(u.replace(/:\/\/mp4upload\.com/i, "://www.mp4upload.com"), timeout)
            const m = /src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/.exec(html)
            if (!m) return undefined
            return { server: "Auto", headers: { Referer: "https://www.mp4upload.com/" }, videoSources: [{ url: m[1], type: "mp4", quality: "auto", subtitles: [] }] }
        }
        const html = await this.page(u, timeout)
        const m = /data-options="([^"]+)"/.exec(html)
        if (!m) return undefined
        const opts = JSON.parse(this.decodeEntities(m[1]))
        const raw = opts && opts.flashvars && opts.flashvars.metadata
        const meta = typeof raw === "string" ? JSON.parse(raw) : raw || {}
        const hls = meta.ondemandHls || meta.hlsManifestUrl || ""
        if (hls) return { server: "Auto", headers: { Referer: "https://ok.ru/", "User-Agent": this.ua }, videoSources: [{ url: hls, type: "m3u8", quality: "auto", subtitles: [] }] }
        return undefined
    }

    private async page(url: string, timeout: number): Promise<string> {
        const res = await fetch(url, { headers: { Referer: `${this.baseUrl}/`, "User-Agent": this.ua }, timeout })
        return res.ok ? res.text() : ""
    }

    private result(s: Show, wantDub: boolean): SearchResult | undefined {
        const n = s.availableEpisodes || {}
        const sub = (n.sub || 0) > 0
        const dub = (n.dub || 0) > 0
        if (!(wantDub ? dub : sub)) return undefined
        return { id: `${s._id}$${wantDub ? "dub" : "sub"}`, title: s.englishName || s.name || s._id, url: `${this.baseUrl}/anime/${s._id}`, subOrDub: sub && dub ? "both" : dub ? "dub" : "sub" }
    }

    private showFields(): string {
        return "_id name englishName nativeName altNames type aniListId malId airedStart availableEpisodes"
    }

    private pickBest(cands: Show[], media: Media): Show[] {
        const targets = this.uniq([media.romajiTitle || "", media.englishTitle || ""].concat(media.synonyms || [])).map((t) => this.normTitle(t)).filter((t) => t.length >= 3)
        if (targets.length === 0) return cands
        const year = (media.startDate && media.startDate.year) || 0
        const f = (media.format || "").toUpperCase()
        const scored = cands
            .map((c) => {
                let best = 0
                for (const t of [c.name, c.englishName, c.nativeName].concat(c.altNames || [])) {
                    const n = this.normTitle(t || "")
                    if (n) for (const x of targets) best = Math.max(best, this.sim(n, x))
                }
                const cy = (c.airedStart && c.airedStart.year) || 0
                const d = cy && year ? Math.abs(cy - year) : 0
                const movie = String(c.type || "").toLowerCase() === "movie"
                const clash = (f === "MOVIE" && c.type && !movie) || ((f === "TV" || f === "TV_SHORT") && movie)
                return { c, s: best - (d <= 1 ? 0 : d === 2 ? 0.1 : 0.35) - (clash ? 0.3 : 0) }
            })
            .filter((x) => x.s >= 0.5)
            .sort((a, b) => b.s - a.s)
        if (scored.length > 0 && scored[0].s >= 0.85 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.12)) return [scored[0].c]
        return scored.slice(0, 5).map((x) => x.c)
    }

    private normTitle(s: string): string {
        return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }

    private sim(a: string, b: string): number {
        const m = a.length
        const n = b.length
        if (!m || !n) return 0
        const d: number[] = []
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
        return 1 - d[n] / Math.max(m, n)
    }

    private uniq(list: string[]): string[] {
        const out: string[] = []
        for (const s of list) {
            const v = (s || "").trim()
            if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v)
        }
        return out
    }

    private async gql(scope: string, query: string, variables: any, sealed?: boolean): Promise<any> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const qh = this.hex(this.sha256(this.utf8(query)))
            const extensions: any = { persistedQuery: { version: 1, sha256Hash: qh } }
            let boot: Boot | undefined
            if (sealed) {
                boot = await this.boot(scope, attempt > 0)
                extensions.k = this.lane
                extensions.aaReq = this.aaReq(boot, qh)
            }
            let res: FetchResponse
            try {
                res = await fetch(`${this.api}/api`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-build-id": this.build, Origin: this.baseUrl, Referer: `${this.baseUrl}/`, "User-Agent": this.ua },
                    body: JSON.stringify({ query, variables, extensions }),
                    timeout: 10,
                })
            } catch (e) {
                this.reportError(scope, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
                throw "mkissa: the site did not respond - retry in a moment"
            }
            if (res.status === 429) throw this.fail(scope, this.busy)
            let body: any = null
            try {
                body = res.json()
            } catch (_e) {}
            if (!body || typeof body !== "object") throw this.fail(scope, `mkissa: the site API failed (status ${res.status})`)
            const msgs: string[] = (body.errors || []).map((e: any) => String((e && e.message) || ""))
            if (msgs.some((m) => /too many requests/i.test(m))) throw this.fail(scope, this.busy)
            if (msgs.indexOf("NEED_CAPTCHA") !== -1) throw this.fail(scope, this.captcha)
            if (msgs.some((m) => /^AA_CRYPTO/.test(m))) {
                if (attempt === 0) continue
                throw this.fail(scope, this.stale)
            }
            const data = body.data
            if (data && typeof data.tobeparsed === "string") {
                try {
                    return this.open(boot as Boot, data.tobeparsed)
                } catch (_e) {
                    if (attempt === 0) continue
                    throw this.fail(scope, this.stale)
                }
            }
            if (msgs.length && (!data || Object.keys(data).every((k) => data[k] === null))) throw this.fail(scope, `mkissa: the site API answered with an error (${msgs[0].slice(0, 120)})`)
            return data
        }
        throw this.fail(scope, this.stale)
    }

    private async boot(scope: string, fresh: boolean): Promise<Boot> {
        const ck = `mkissa:boot:${this.lane}`
        if (!fresh) {
            const c = $store.get<Boot>(ck)
            if (c && c.key && Date.now() < c.switchAt - 60000) return c
        }
        const week = 604800000
        const day = 86400000
        const now = Date.now()
        const cur = Math.floor(now / week)
        const host = this.baseUrl.replace(/^[a-z]+:\/\//i, "").replace(/[\/:].*$/, "").replace(/^www\./, "").toLowerCase()
        const mask = this.unhexBytes(this.mask)
        const k1 = this.hmac(mask, this.utf8(this.bootPrefix + this.build))
        for (const epoch of now - cur * week < day && cur > 0 ? [cur - 1, cur] : [cur]) {
            const token = this.hex(this.hmac(k1, this.utf8([this.build, "mkissa", this.lane, epoch, host].join("|"))))
            let res: FetchResponse
            try {
                res = await fetch(`${this.api}/client-crypto/v1/bootstrap?buildId=${this.build}&k=${this.lane}`, {
                    headers: { "x-build-id": this.build, "x-aa-boot": token, Origin: this.baseUrl, Referer: `${this.baseUrl}/`, "User-Agent": this.ua },
                    timeout: 10,
                })
            } catch (e) {
                this.reportError(scope, `transport failure: ${e instanceof Error ? e.message : String(e)}`)
                throw "mkissa: the site did not respond - retry in a moment"
            }
            if (res.status === 429) throw this.fail(scope, this.busy)
            if (!res.ok) {
                this.reportError(scope, `bootstrap for build ${this.build} answered ${res.status}`)
                continue
            }
            const j = res.json<any>()
            const part = j && typeof j.partB === "string" ? this.b64dec(j.partB) : []
            if (part.length < 32) continue
            const key: number[] = []
            for (let i = 0; i < 32; i++) key.push(part[i] ^ mask[i % mask.length])
            const boot: Boot = { epoch: Number(j.epoch) || epoch, switchAt: Number(j.switchAt) || now + day, key: this.hex(key) }
            $store.set(ck, boot)
            return boot
        }
        throw this.fail(scope, this.stale)
    }

    private aaReq(boot: Boot, qh: string): string {
        const ts = Math.floor(Date.now() / 300000) * 300000
        const iv = this.sha256(this.utf8(`${boot.epoch}:${this.build}:${qh}:${ts}:${this.lane}`)).slice(0, 12)
        const plain = JSON.stringify({ v: 1, ts, epoch: boot.epoch, buildId: this.build, qh, k: this.lane })
        return this.b64enc([1].concat(iv, this.gcm(this.unhexBytes(boot.key), iv, this.utf8(plain), true)))
    }

    private open(boot: Boot, sealed: string): any {
        const b = this.b64dec(sealed)
        if (b[0] !== 1 || b.length < 30) throw new Error("bad envelope")
        const plain = this.gcm(this.unhexBytes(boot.key), b.slice(1, 13), b.slice(13, b.length - 16), false)
        let bin = ""
        for (let i = 0; i < plain.length; i += 4096) bin += String.fromCharCode.apply(null, plain.slice(i, i + 4096))
        return JSON.parse(decodeURIComponent(escape(bin)))
    }

    private sha256(data: number[]): number[] {
        const ror = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
        const bytes = data.slice()
        const bits = data.length * 8
        bytes.push(0x80)
        while (bytes.length % 64 !== 56) bytes.push(0)
        for (const v of [Math.floor(bits / 0x100000000), bits >>> 0]) bytes.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)
        const h = SHA_H.slice()
        const w: number[] = new Array(64)
        for (let i = 0; i < bytes.length; i += 64) {
            for (let t = 0; t < 16; t++) w[t] = (bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) | (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3]
            for (let t = 16; t < 64; t++) {
                const x = w[t - 15]
                const y = w[t - 2]
                w[t] = (w[t - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[t - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) | 0
            }
            let [a, b, c, d, e, f, g, k] = h
            for (let t = 0; t < 64; t++) {
                const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[t] + w[t]) | 0
                const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
                k = g
                g = f
                f = e
                e = (d + t1) | 0
                d = c
                c = b
                b = a
                a = (t1 + t2) | 0
            }
            const add = [a, b, c, d, e, f, g, k]
            for (let j = 0; j < 8; j++) h[j] = (h[j] + add[j]) | 0
        }
        const out: number[] = []
        for (const v of h) out.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)
        return out
    }

    private hmac(key: number[], msg: number[]): number[] {
        let k = key.length > 64 ? this.sha256(key) : key.slice()
        while (k.length < 64) k = k.concat([0])
        return this.sha256(k.map((b) => b ^ 0x5c).concat(this.sha256(k.map((b) => b ^ 0x36).concat(msg))))
    }

    private aesKeys(key: number[]): number[] {
        const w = key.slice()
        let rcon = 1
        for (let i = 32; i < 240; i += 4) {
            let t = w.slice(i - 4, i)
            if (i % 32 === 0) {
                t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]
                rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 255
            } else if (i % 32 === 16) t = t.map((b) => SBOX[b])
            for (let j = 0; j < 4; j++) w[i + j] = w[i - 32 + j] ^ t[j]
        }
        return w
    }

    private aesBlock(rk: number[], block: number[]): number[] {
        const x2 = (v: number): number => ((v << 1) ^ (v & 0x80 ? 0x1b : 0)) & 255
        let s = block.map((b, i) => b ^ rk[i])
        for (let round = 1; round <= 14; round++) {
            const t: number[] = new Array(16)
            for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = SBOX[s[((c + r) % 4) * 4 + r]]
            if (round < 14) {
                for (let c = 0; c < 16; c += 4) {
                    const a0 = t[c]
                    const a1 = t[c + 1]
                    const a2 = t[c + 2]
                    const a3 = t[c + 3]
                    t[c] = x2(a0) ^ x2(a1) ^ a1 ^ a2 ^ a3
                    t[c + 1] = a0 ^ x2(a1) ^ x2(a2) ^ a2 ^ a3
                    t[c + 2] = a0 ^ a1 ^ x2(a2) ^ x2(a3) ^ a3
                    t[c + 3] = x2(a0) ^ a0 ^ a1 ^ a2 ^ x2(a3)
                }
            }
            s = t.map((b, i) => b ^ rk[round * 16 + i])
        }
        return s
    }

    private gmul(x: number[], y: number[]): number[] {
        const z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        const v = y.slice()
        for (let i = 0; i < 128; i++) {
            if ((x[i >> 3] >> (7 - (i & 7))) & 1) for (let j = 0; j < 16; j++) z[j] ^= v[j]
            const lsb = v[15] & 1
            for (let j = 15; j > 0; j--) v[j] = (v[j] >>> 1) | ((v[j - 1] & 1) << 7)
            v[0] >>>= 1
            if (lsb) v[0] ^= 0xe1
        }
        return z
    }

    private gcm(key: number[], iv: number[], data: number[], encrypt: boolean): number[] {
        const rk = this.aesKeys(key)
        const ctr = iv.concat([0, 0, 0, 1])
        const j0 = ctr.slice()
        const out: number[] = []
        for (let i = 0; i < data.length; i += 16) {
            for (let j = 15; j >= 12; j--) if ((ctr[j] = (ctr[j] + 1) & 255) !== 0) break
            const ks = this.aesBlock(rk, ctr)
            for (let j = 0; j < 16 && i + j < data.length; j++) out.push(data[i + j] ^ ks[j])
        }
        if (!encrypt) return out
        const hk = this.aesBlock(rk, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        let x = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        for (let i = 0; i < out.length; i += 16) x = this.gmul(x.map((b, j) => b ^ (out[i + j] || 0)), hk)
        const bits = out.length * 8
        const len = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255]
        x = this.gmul(x.map((b, j) => b ^ len[j]), hk)
        const ej0 = this.aesBlock(rk, j0)
        return out.concat(x.map((b, j) => b ^ ej0[j]))
    }

    private utf8(s: string): number[] {
        const bin = unescape(encodeURIComponent(s))
        const out: number[] = []
        for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i))
        return out
    }

    private hex(b: number[]): string {
        return b.map((x) => (x < 16 ? "0" : "") + x.toString(16)).join("")
    }

    private unhexBytes(h: string): number[] {
        const out: number[] = []
        for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16))
        return out
    }

    private unhex(h: string): string {
        return this.unhexBytes(h).map((b) => String.fromCharCode(b ^ 56)).join("")
    }

    private b64enc(b: number[]): string {
        let out = ""
        for (let i = 0; i < b.length; i += 3) {
            const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0)
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=")
        }
        return out
    }

    private b64dec(s: string): number[] {
        const out: number[] = []
        let acc = 0
        let bits = 0
        for (const ch of s.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "")) {
            acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.push((acc >> bits) & 255)
            }
        }
        return out
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

    private buildSubs(subs: Sub[]): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const nonDialogue: boolean[] = []
        const seen: { [key: string]: boolean } = {}
        let pick = 0
        let best = -1
        for (const s of subs) {
            if (!/^https?:\/\//i.test(s.origin) || seen["#" + s.origin]) continue
            seen["#" + s.origin] = true
            const code = (s.lang || "en").toLowerCase()
            const label = (s.label || "").trim()
            const idx = out.length
            out.push({ id: `${code}-${idx}`, url: s.origin, language: label || code, isDefault: false })
            const nd = this.isNonDialogue(label)
            nonDialogue.push(nd)
            const score = this.trackScore(label, /^en(?:g|glish)?\b/.test(code), s.def === true, nd)
            if (score > best) {
                best = score
                pick = idx
            }
        }
        if (out.length === 0) return out
        out[pick].isDefault = true
        return [out[pick]].concat(out.filter((_, i) => i !== pick && !nonDialogue[i]), out.filter((_, i) => i !== pick && nonDialogue[i]))
    }

    private decodeEntities(s: string): string {
        return (s || "").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    }

    private cfg(name: string, fallback: string): string {
        try {
            const v = $getUserPreference(name)
            if (typeof v === "string" && v && v.indexOf("{{") === -1) return v
        } catch (_e) {}
        return fallback
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-mkissa", scope: scope, msg: this.plain(message), lvl: lvl })
            if (lvl) console.warn(line)
            else console.error(line)
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

    private fail(scope: string, message: string, lvl?: "warn" | "info"): string {
        this.reportError(scope, message, lvl)
        return message
    }

    private readCache<T>(key: string, ttl: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        if (entry && entry.at > 0 && Date.now() - entry.at < ttl) return entry.data
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
