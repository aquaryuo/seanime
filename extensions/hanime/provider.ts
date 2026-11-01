declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Row = { name?: unknown; slug?: unknown; search_titles?: unknown; released_at_unix?: unknown; created_at_unix?: unknown; tags?: unknown }
type Ep = { n: number; slug: string; day: number; up: number; unc: boolean; pair: string; bare: boolean }
type Group = { key: string; title: string; n: string; base: string; seq: number; comp: boolean; blob: string; eps: Ep[] }
type Cand = { n: string; t: string; seq: number; cut: boolean; ova: boolean; raw: string }
type Src = { src?: string; label?: string; height?: number; kind?: string }

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
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

class Provider implements AnimeProvider {
    private site = "https://hanime.tv"
    private catalogUrl = "https://guest.freeanimehentai.net/api/v11/search_hvs"
    private handshakeUrl = "https://auth.hanime.tv/api/v11/handshake"
    private catalogTtl = 3600000

    getSettings(): Settings {
        return { episodeServers: ["hanime"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (opts.dub) return []
        const media = opts.media || ({} as Media)
        const groups = await this.groups("search")
        let picks: Group[] = []
        if (media.id > 0) {
            let g = this.pick(groups, media)
            if (!g) {
                const syn = await this.synonyms(media.id)
                const s = syn.length ? this.pick(groups, { ...media, synonyms: (media.synonyms || []).concat(syn) }) : undefined
                if (s && !(media.episodeCount === 1 && s.eps.length > 1)) g = s
            }
            if (g && g.eps.length === 1 && g.eps[0].bare && (media.episodeCount || 0) > 1) throw this.fail("search", `hanime: the site has ${g.title} only as one video, so its ${media.episodeCount} episodes cannot be matched`, "info")
            if (g && g.comp && media.episodeCount !== 1) throw this.fail("search", `hanime: the site has ${g.title} only as one video of the whole season, so its episodes cannot be matched`, "info")
            if (g) picks = [g]
        } else {
            const q = this.norm(opts.query || "").replace(/ /g, "")
            if (q.length < 2) return []
            const named = (g: Group): boolean => g.n.replace(/ /g, "").indexOf(q) !== -1
            picks = groups.filter(named).concat(groups.filter((g) => !named(g) && g.blob.replace(/ /g, "").indexOf(q) !== -1)).slice(0, 40)
        }
        return picks.map((g) => ({ id: g.key, title: g.title, url: `${this.site}/videos/hentai/${g.eps[0].slug}`, subOrDub: "sub" }))
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const g = (await this.groups("episodes")).filter((x) => x.key === id)[0]
        if (!g) throw this.fail("episodes", `hanime: ${id} is no longer in the site's catalog - match the series again`, "info")
        return g.eps.map((e) => {
            const d: EpisodeDetails = { id: e.slug, number: e.n, url: `${this.site}/videos/hentai/${e.slug}` }
            if (e.pair) d.title = `Episodes ${e.pair}`
            return d
        })
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const slug = episode.id
        const num = episode.number
        if (!/^[a-z0-9-]{1,200}$/.test(slug)) throw this.fail("server", "hanime: unrecognized episode id - refresh the episode list")
        const t = Math.floor(Date.now() / 1000) + 60
        let res: FetchResponse
        try {
            res = await fetch(this.handshakeUrl, {
                method: "POST",
                noCloudflareBypass: true,
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Origin: this.site,
                    Referer: `${this.site}/`,
                    "x-signature-version": "web2",
                    "x-time": String(t),
                    "x-signature": this.hex(this.sha256(this.utf8(`${t},Xkdi29,${this.site},mn2,${t}`))),
                },
                body: JSON.stringify({ token: this.seal({ timestamp_unix: t, directive: "htv_player_handshake", slug }) }),
            })
        } catch (e) {
            throw this.fail("server", `hanime: the stream handshake (auth.hanime.tv) ${this.net(e)}`)
        }
        if (res.status === 401 || res.status === 422) {
            let code = ""
            try {
                code = String(res.json<{ error_id?: string }>().error_id || "")
            } catch (_e) {}
            throw this.fail("server", `hanime: the site refused the stream handshake (${code || res.status}) - the site changed its signing and this extension needs an update, or this computer's clock is more than 3 minutes slow`)
        }
        if (res.status === 404) throw this.fail("server", `hanime: episode ${num} is gone from the site`, "info")
        if (!res.ok) throw this.fail("server", `hanime: the stream handshake (auth.hanime.tv) answered HTTP ${res.status}`)
        let sources: Src[] | undefined
        try {
            const k = Object.keys(res.headers || {}).filter((h) => h.toLowerCase() === "x-token")[0]
            sources = this.unseal(res.headers[k]).sources
        } catch (_e) {}
        if (!Array.isArray(sources)) throw this.fail("server", "hanime: the stream handshake answered in a shape this extension does not understand - the site changed its API; this extension needs an update")
        const ok = sources
            .filter((s) => s && s.kind !== "promotion" && typeof s.src === "string" && /^(\/|https:\/\/)/.test(s.src))
            .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0))
        if (ok.length === 0) throw this.fail("server", sources.length ? `hanime: episode ${num} plays only for premium accounts on the site` : `hanime: the site returned no streams for episode ${num} (removed from the site, or not available where you are)`, "info")
        return {
            server: "hanime",
            headers: { Referer: `${this.site}/` },
            videoSources: ok.map((s) => ({ url: (s.src as string).charAt(0) === "/" ? this.site + s.src : (s.src as string), type: "m3u8", quality: String(s.label || `${s.height}p`), subtitles: [] })),
        }
    }

    private async synonyms(id: number): Promise<string[]> {
        const hit = this.readCache<string[]>(`hanime:syn:${id}`, 86400000)
        if (hit) return hit
        try {
            const res = await fetch("https://graphql.anilist.co", {
                method: "POST",
                noCloudflareBypass: true,
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ query: "query($id:Int){Media(id:$id,type:ANIME){synonyms}}", variables: { id } }),
            })
            const m = res.ok ? res.json<{ data?: { Media?: { synonyms?: unknown } } }>().data : undefined
            const list = m && m.Media && m.Media.synonyms
            if (!Array.isArray(list)) return []
            const syn = list.filter((s) => typeof s === "string")
            this.writeCache(`hanime:syn:${id}`, syn)
            return syn
        } catch (_e) {
            return []
        }
    }

    private async groups(scope: string): Promise<Group[]> {
        const hit = this.readCache<Group[]>("hanime:groups", this.catalogTtl)
        if (hit) return hit
        let res: FetchResponse
        try {
            res = await fetch(this.catalogUrl, { noCloudflareBypass: true, headers: { Accept: "application/json" } })
        } catch (e) {
            throw this.fail(scope, `hanime: the catalog (guest.freeanimehentai.net) ${this.net(e)}`)
        }
        if (!res.ok) throw this.fail(scope, `hanime: the catalog (guest.freeanimehentai.net) answered HTTP ${res.status}`)
        let rows: Row[] | undefined
        try {
            rows = res.json<{ data?: Row[] }>().data
        } catch (_e) {}
        const groups = Array.isArray(rows) ? this.group(rows) : []
        if (groups.length === 0) throw this.fail(scope, "hanime: the catalog answered in a shape this extension does not understand - the site changed its API; this extension needs an update")
        this.writeCache("hanime:groups", groups)
        return groups
    }

    private group(rows: Row[]): Group[] {
        const by: { [k: string]: Group } = {}
        const out: Group[] = []
        for (const r of rows) {
            if (!r || typeof r.name !== "string" || typeof r.slug !== "string" || !/^[a-z0-9-]{1,200}$/.test(r.slug)) continue
            const name = this.decode(r.name).replace(/\s+/g, " ").trim()
            const p = this.parse(name)
            if (!p) continue
            const key = p.t.toLowerCase()
            let g = by[key]
            if (!g) {
                const n = this.norm(p.t)
                const s = this.seq(n)
                g = by[key] = { key, title: p.t, n, base: s.base, seq: s.seq, comp: p.comp, blob: "", eps: [] }
                out.push(g)
            }
            const alt = typeof r.search_titles === "string" ? this.norm(this.decode(r.search_titles).replace(/\s+/g, " ").trim().replace(name, "")) : ""
            if (alt && (" " + g.blob + " ").indexOf(" " + alt + " ") === -1) g.blob = (g.blob + " " + alt).trim()
            const e = {
                slug: r.slug,
                day: Math.floor(((Number(r.released_at_unix) || 0) + 32400) / 86400),
                up: Number(r.created_at_unix) || 0,
                unc: Array.isArray(r.tags) && r.tags.indexOf("uncensored") !== -1,
                pair: p.eps.length > 1 ? p.eps.join(" & ") : "",
                bare: !!p.bare,
            }
            for (const n of p.eps) {
                const i = g.eps.map((x) => x.n).indexOf(n)
                const cur = { n, ...e }
                if (i === -1) g.eps.push(cur)
                else if (this.better(cur, g.eps[i])) g.eps[i] = cur
            }
        }
        for (const g of out) g.eps.sort((a, b) => a.n - b.n)
        return out
    }

    private parse(name: string): { t: string; eps: number[]; comp: boolean; bare?: boolean } | undefined {
        if (!name || /\b(?:bonus|extra|preview|trailer)(?: (?:video|episode|scene))?$/i.test(name)) return undefined
        let m = name.match(/^(.+?) (\d+) ?& ?(\d+)$/)
        if (m && +m[3] > +m[2]) return { t: m[1], eps: [+m[2], +m[3]], comp: false }
        m = name.match(/^(.+?) (?:ep|episode)\.? ?(\d+)$/i)
        if (m) return +m[2] > 0 ? { t: m[1], eps: [+m[2]], comp: false } : undefined
        if (/ season \d+$/i.test(name)) return { t: name, eps: [1], comp: true }
        m = name.match(/^(.+?) (\d+(?:\.\d+)?)$/)
        if (m) return /^[1-9]\d*$/.test(m[2]) ? { t: m[1], eps: [+m[2]], comp: false } : undefined
        return { t: name, eps: [1], comp: false, bare: true }
    }

    private better(a: Ep, b: Ep): boolean {
        if (!a.pair !== !b.pair) return !a.pair
        if (a.unc !== b.unc) return a.unc
        return a.up > b.up
    }

    private pick(groups: Group[], media: Media): Group | undefined {
        const cands = this.cands([media.romajiTitle || "", media.englishTitle || ""].concat(media.synonyms || []))
        const d = media.startDate
        const start = d && d.year && d.month && d.day ? Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86400000) : 0
        const tv = media.format === "TV" || media.format === "TV_SHORT"
        const year = d && d.year > 0 ? d.year : 0
        let best = 0
        let top: Group[] = []
        for (const g of groups) {
            const s = this.score(g, cands, start, tv, year)
            if (s > best) {
                best = s
                top = []
            }
            if (s > 0 && s === best) top.push(g)
        }
        const narrow = (f: (g: Group) => boolean): void => {
            const kept = top.filter(f)
            if (top.length > 1 && kept.length > 0) top = kept
        }
        const count = media.episodeCount || 0
        narrow((g) => this.near(g, start))
        narrow((g) => g.eps.length === count)
        narrow((g) => cands.some((c) => c.raw === g.key))
        return top.length === 1 ? top[0] : undefined
    }

    private score(g: Group, cands: Cand[], start: number, tv: boolean, year: number): number {
        let s = 0
        const first = new Date(Math.min(...g.eps.map((e) => e.day)) * 86400000).getUTCFullYear()
        const siteOva = /\bova\b/i.test(g.title)
        for (const c of cands) {
            if (c.seq !== g.seq) continue
            const v = (this.same(c.t, g.base) ? 6 : this.prefix(c.t, g.base) || this.oneEdit(c.t, g.base) ? 4 : (!c.cut || c.n.split(" ").length >= 3) && this.inBlob(c.n, g.blob) ? 2 : 0) - (c.cut ? 1 : 0)
            const tag = c.raw.match(/\(((?:19|20)\d\d)\)/)
            const exact = v === 6 && (!c.ova || siteOva) && !(siteOva && tv) && (c.t === g.base || !year || Math.abs(first - year) <= 1) && (!tag || Math.abs(first - +tag[1]) <= 1)
            if (v > s && (exact || this.near(g, start))) s = v
        }
        return s
    }

    private same(a: string, b: string): boolean {
        return a === b || a.replace(/ /g, "") === b.replace(/ /g, "")
    }

    private prefix(a: string, b: string): boolean {
        return b.indexOf(" ") !== -1 && a.indexOf(b + " ") === 0 && a.slice(b.length + 1).indexOf(" ") !== -1
    }

    private oneEdit(a: string, b: string): boolean {
        const x = a.replace(/ /g, "")
        const y = b.replace(/ /g, "")
        if (Math.min(x.length, y.length) < 16 || Math.abs(x.length - y.length) > 1) return false
        let i = 0
        while (i < x.length && x[i] === y[i]) i++
        let j = 0
        while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++
        return x.length - i - j <= 1 && y.length - i - j <= 1
    }

    private inBlob(a: string, blob: string): boolean {
        if (a.length < 4) return false
        if ((" " + blob + " ").indexOf(" " + a + " ") !== -1) return true
        const s = a.replace(/ /g, "")
        return s.length >= 12 && blob.replace(/ /g, "").indexOf(s) !== -1
    }

    private near(g: Group, start: number): boolean {
        return start > 0 && Math.abs(Math.min(...g.eps.map((e) => e.day)) - start) <= 1
    }

    private cands(titles: string[]): Cand[] {
        const out: Cand[] = []
        const add = (p: string, cut: boolean): void => {
            const n = this.norm(p)
            if (n.length < 3 || out.some((c) => c.n === n)) return
            const s = this.seq(n)
            out.push({ n, t: s.base, seq: s.seq, cut, ova: /\bova\b/i.test(p), raw: p.toLowerCase().replace(/\s+/g, " ").trim() })
        }
        for (const raw of titles) {
            if (!raw || /[○●◯]/.test(raw)) continue
            add(raw, false)
            add(raw.split(/:| - /)[0], true)
        }
        return out
    }

    private seq(n: string): { base: string; seq: number } {
        const m = n.match(/^(.+?) (?:season )?(\d{1,2})$/) || n.match(/^(.+?) (\d{1,2})(?:st|nd|rd|th) season$/)
        return m ? { base: m[1], seq: parseInt(m[2], 10) } : { base: n, seq: 1 }
    }

    private norm(s: string): string {
        return (s || "")
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[’'‘`]/g, "")
            .replace(/&/g, " and ")
            .replace(/[×✕]/g, " x ")
            .replace(/\([^)]*\)/g, " ")
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\b(?:the animation|ova|hentai|uncensored)\b/g, " ")
            .replace(/ animation\s*$/, " ")
            .replace(/\biii\b/g, "3")
            .replace(/\bii\b/g, "2")
            .replace(/\bwo\b/g, "o")
            .replace(/\s+/g, " ")
            .trim()
    }

    private decode(s: string): string {
        const map: { [k: string]: string } = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#039": "'", "#x27": "'" }
        return s.replace(/&(amp|quot|apos|lt|gt|#0?39|#x27);/g, (all, k) => map[k] || all)
    }

    private seal(payload: object): string {
        const iv: number[] = []
        for (let i = 0; i < 12; i++) iv.push(Math.floor(Math.random() * 256))
        const rk = this.aesKeys(this.sha256(this.utf8("htv-insecure-handshake-v1")))
        const data = this.ctr(rk, iv, this.utf8(JSON.stringify(payload)))
        const hk = this.aesBlock(rk, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        const be = (n: number): number[] => [0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
        const aad = this.utf8("htv-insecure-v1")
        let x = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        for (const b of [aad, data, be(aad.length * 8).concat(be(data.length * 8))]) {
            for (let i = 0; i < b.length; i += 16) x = this.gmul(x.map((v, j) => v ^ (b[i + j] || 0)), hk)
        }
        const e0 = this.aesBlock(rk, iv.concat([0, 0, 0, 1]))
        const tag = x.map((v, j) => v ^ e0[j])
        return this.b64u(this.utf8(JSON.stringify({ v: 1, alg: "AES-256-GCM", iv: this.b64u(iv), tag: this.b64u(tag), data: this.b64u(data) })))
    }

    private unseal(token: string): { sources?: Src[] } {
        const env = JSON.parse(this.text(this.unb64(token)))
        const rk = this.aesKeys(this.sha256(this.utf8("htv-insecure-handshake-v1")))
        return JSON.parse(this.text(this.ctr(rk, this.unb64(env.iv), this.unb64(env.data))))
    }

    private ctr(rk: number[], iv: number[], data: number[]): number[] {
        const c = iv.concat([0, 0, 0, 1])
        const out: number[] = []
        for (let i = 0; i < data.length; i += 16) {
            for (let j = 15; j >= 12; j--) if ((c[j] = (c[j] + 1) & 255) !== 0) break
            const ks = this.aesBlock(rk, c)
            for (let j = 0; j < 16 && i + j < data.length; j++) out.push(data[i + j] ^ ks[j])
        }
        return out
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

    private utf8(s: string): number[] {
        const bin = unescape(encodeURIComponent(s))
        const out: number[] = []
        for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i))
        return out
    }

    private text(b: number[]): string {
        let bin = ""
        for (let i = 0; i < b.length; i += 4096) bin += String.fromCharCode.apply(null, b.slice(i, i + 4096))
        return decodeURIComponent(escape(bin))
    }

    private hex(b: number[]): string {
        return b.map((x) => (x < 16 ? "0" : "") + x.toString(16)).join("")
    }

    private b64u(b: number[]): string {
        let out = ""
        for (let i = 0; i < b.length; i += 3) {
            const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0)
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "") + (i + 2 < b.length ? B64[n & 63] : "")
        }
        return out
    }

    private unb64(s: string): number[] {
        const out: number[] = []
        let acc = 0
        let bits = 0
        for (const ch of String(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/[^A-Za-z0-9_-]/g, "")) {
            acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.push((acc >> bits) & 255)
            }
        }
        return out
    }

    private net(e: unknown): string {
        const m = String(e instanceof Error ? e.message : (e && (e as any).message) || e).replace(/^\w+ "[^"]*": /, "")
        if (/did not answer in time|timed? ?out|deadline exceeded/i.test(m)) return "did not answer in time"
        if (/could not be found|cannot resolve|no such host|ENOTFOUND|EAI_AGAIN/i.test(m)) return "could not be found (DNS)"
        if (/TLS|SSL|certificate|x509/i.test(m)) return "failed the TLS handshake"
        return `could not be reached (${m.slice(0, 120)})`
    }

    private reportError(scope: string, message: string, lvl?: "warn" | "info"): void {
        try {
            const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-hanime", scope: scope, msg: this.plain(message), lvl: lvl })
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
            .replace(/[·•]/g, "-")
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
