declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

type Item = { id: string; num: number; q: string; series: string; base: string; season: number; ep: number; key: string; bare?: boolean }
type Group = { key: string; base: string; season: number; series: string; items: Item[]; eps: number[] }
type Section = { names: string[]; links: { id: string; ep: number }[] }
type Cand = { base: string; season: number; full: boolean; romaji: boolean }
type Got = { ok: boolean; status: number; body: string; why: string }
type Scan = { fetched: number; seen: { [id: string]: boolean } }

class Provider implements AnimeProvider {
    private base = "https://www.hentaicity.com"
    private ttl = 900000
    private src = /<source\s[^>]*src="https:\/\/hls\./
    private placeholder = /[○●◯〇◎]/

    getSettings(): Settings {
        return { episodeServers: ["Hentai City"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (opts.dub) return []
        const given = opts.media || ({ id: 0, synonyms: [], isAdult: true } as Media)
        if (!(given.id > 0)) return this.manual(opts.query || "")
        const ck = `hentaicity:pick:${given.id}`
        const hit = this.readCache<SearchResult[]>(ck, this.ttl)
        if (hit) return hit
        const m: Media = { ...given, synonyms: (given.synonyms || []).concat(await this.synonyms(given.id)) }
        const cands = this.candidates(m)
        const en = m.englishTitle || ""
        const ro = m.romajiTitle || ""
        const queries = [en, ro, this.cut(en), this.cut(ro)]
            .concat(m.synonyms || [])
            .filter((t) => !this.placeholder.test(t))
            .map((t) => this.norm(t).split(" ").slice(0, 8).join("+"))
            .filter((q, i, all) => q.length >= 2 && all.indexOf(q) === i)
            .slice(0, 4)
        const pool: Item[] = []
        const scan: Scan = { fetched: 0, seen: {} }
        let pick: SearchResult | null = null
        for (let i = 0; i < queries.length && !pick; i++) {
            for (const it of await this.find(queries[i], "search")) if (!pool.some((p) => p.id === it.id)) pool.push(it)
            pick = await this.decide(pool, cands, m, scan, i === queries.length - 1)
        }
        const done = m.status === "FINISHED" && m.episodeCount && m.episodeCount > 0 ? `$${m.episodeCount}` : ""
        const out = pick ? [{ ...pick, id: pick.id + done, title: m.englishTitle || m.romajiTitle || pick.title }] : []
        this.writeCache(ck, out)
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const ck = `hentaicity:eps:${id}`
        const hit = this.readCache<EpisodeDetails[]>(ck, this.ttl)
        if (hit) return hit
        const p = (id || "").split("$")
        let rows: { id: string; ep: number; num: number; bare?: boolean }[] = []
        if (p[0] === "g" && (p.length === 4 || p.length === 5)) {
            rows = await this.collect([`${p[2]}#${p[1]}`], p[3])
        } else if (p[0] === "b" && (p.length === 4 || p.length === 5) && /^[A-Za-z0-9]{11}$/.test(p[1])) {
            const sec = (await this.box(p[1], "episodes")).filter((s) => s.links.some((l) => l.id === p[2]))[0]
            if (!sec) throw this.fail("episodes", "hentaicity: the site's series list no longer has this show - match it again", "info")
            const ids = sec.links.map((l) => l.id)
            const keys = (await this.find(p[3], "episodes")).filter((it) => ids.indexOf(it.id) !== -1).map((it) => it.key)
            rows = sec.links.map((l) => ({ id: l.id, ep: l.ep, num: 0 })).concat((await this.collect(keys, p[3])).filter((it) => ids.indexOf(it.id) === -1))
        }
        const max = parseInt(p[4], 10) || 1000
        rows = rows.filter((r) => r.ep <= max && (!r.bare || !rows.some((o) => o.ep === r.ep && !o.bare)))
        const by: { [n: number]: string[] } = {}
        rows.sort((a, b) => b.num - a.num)
        for (const r of rows) {
            const ids = (by[r.ep] = by[r.ep] || [])
            if (ids.indexOf(r.id) === -1) ids.push(r.id)
        }
        const out = Object.keys(by)
            .map(Number)
            .sort((a, b) => a - b)
            .map((n) => ({ id: by[n].join(","), number: n, url: `${this.base}/video/x-${by[n][0]}.html` }))
        if (out.length) this.writeCache(ck, out)
        return out
    }

    private async collect(keys: string[], q: string): Promise<Item[]> {
        let out: Item[] = []
        const queries = [q].concat(keys.map((k) => k.split("#")[0].split(" ").slice(0, 5).join("+")))
        for (const x of queries.filter((y, i) => queries.indexOf(y) === i).slice(0, 3)) out = out.concat((await this.find(x, "episodes")).filter((it) => keys.indexOf(it.key) !== -1))
        return out
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const ids = (episode.id || "").split(",").filter((x) => /^[A-Za-z0-9]{11}$/.test(x)).slice(0, 3)
        if (!ids.length) throw this.fail("server", "hentaicity: unrecognized episode id - refresh the episode list")
        let best: { hls: string; dir: string; num: string; names: string[] } | null = null
        let first: Got | null = null
        for (const id of ids) {
            const r = await this.get(`${this.base}/video/x-${id}.html`, this.src)
            const m = r.ok ? /<source\s[^>]*src="(https:\/\/hls\.hentaicity\.com\/_hls\/flv\/(\d+)\/(\d+)\/,([\w,]+),\.mp4\.urlset\/master\.m3u8\?[^"]+)"/.exec(r.body) : null
            const s = m ? { hls: this.decode(m[1]), dir: m[2], num: m[3], names: m[4].split(",").filter((n) => !!n) } : null
            if (s && (!best || s.names.length > best.names.length)) best = s
            if (!s && (!first || r.status === 0)) first = r
            if (r.status === 0) break
        }
        if (!best) {
            const r = first as Got
            if (r.status === 404) throw this.fail("server", `hentaicity: episode ${episode.number} is no longer on the site - refresh the episode list`, "info")
            throw this.bad(r, "server", `episode ${episode.number}`, "video page")
        }
        const b = best
        const label: { [k: string]: string } = { default: "240p", mobile: "360p" }
        const mp4 = b.names
            .map((n) => ({ n, q: label[n] || n }))
            .filter((x) => /^\d{3,4}p$/.test(x.q))
            .sort((x, y) => parseInt(y.q, 10) - parseInt(x.q, 10))
        const sources: VideoSource[] = [{ url: b.hls, type: "m3u8", quality: "auto", subtitles: [] }]
        return {
            server: "Hentai City",
            headers: { Referer: `${this.base}/` },
            videoSources: sources.concat(mp4.map((x) => ({ url: `${this.base}/flv/${b.dir}/${b.num}/${x.n}.mp4`, type: "mp4" as VideoSourceType, quality: x.q, subtitles: [] }))),
        }
    }

    private async decide(pool: Item[], cands: Cand[], m: Media, scan: Scan, last: boolean): Promise<SearchResult | null> {
        const count = m.episodeCount && m.episodeCount > 0 ? m.episodeCount : 0
        const cap = count + Math.floor(count / 4)
        const low = count >= 4 && m.status === "FINISHED" ? Math.ceil(count / 2) : 0
        const fit = (g: Group) => (count ? Math.abs(g.eps.length - count) : -g.eps.length)
        const all = this.groups(pool).map((g) => ({ g, level: this.level(g, cands) }))
        const ranked = all
            .filter((x) => x.level > 0 && (!cap || Math.max(...x.g.eps) <= cap))
            .sort((a, b) => b.level - a.level || fit(a.g) - fit(b.g) || b.g.base.length - a.g.base.length)
        if (!last && !ranked.some((x) => x.level > 1)) return null
        const strong = ranked.filter((x) => x.level === 3)
        const solid = strong.filter((x) => x.g.eps.indexOf(1) !== -1 && x.g.eps.length >= low)
        if (!(ranked.length === 1 && solid.length === 1)) {
            for (const x of ranked) {
                const rep = x.g.items[0]
                if (scan.fetched >= 3) break
                if (scan.seen[rep.id]) continue
                scan.fetched++
                scan.seen[rep.id] = true
                const secs = await this.box(rep.id, "search")
                const sec = secs.filter((s) => this.named(s, cands) && s.links.length >= low && s.links.some((l) => pool.some((it) => it.id === l.id)) && (!cap || Math.max(...s.links.map((l) => l.ep)) <= cap))[0]
                for (const s of secs) for (const l of s.links) scan.seen[l.id] = true
                if (!sec) continue
                const ids = sec.links.map((l) => l.id)
                const own = pool.filter((it) => ids.indexOf(it.id) !== -1)[0] || rep
                return { id: `b$${rep.id}$${ids[0]}$${own.q}`, title: sec.names[0], url: `${this.base}/video/x-${rep.id}.html`, subOrDub: "sub" }
            }
        }
        const two = all.filter((x) => x.level >= 2)
        if (last && count > 1 && two.length === 1 && ranked.indexOf(two[0]) !== -1 && two[0].g.eps.length === count && two[0].g.eps.indexOf(1) !== -1 && this.subtitled(two[0].g, cands)) return this.result(two[0].g)
        if (solid.length === 0 || (solid.length > 1 && fit(solid[0].g) === fit(solid[1].g))) return null
        return this.result(solid[0].g)
    }

    private async manual(query: string): Promise<SearchResult[]> {
        const q = this.norm(query).split(" ").slice(0, 8).join("+")
        if (q.length < 2) return []
        const words = q.replace(/^(?:the|a|an)\+/, "").split("+")
        return this.groups(await this.find(q, "search"))
            .filter((g) => words.every((w) => ` ${g.base} ${g.season}`.indexOf(` ${w}`) !== -1))
            .map((g) => this.result(g))
    }

    private result(g: Group): SearchResult {
        const q = g.items[0].q
        const title = g.series + (g.season > 1 && !/\s\d+$/.test(g.series) ? ` ${g.season}` : "")
        return { id: `g$${g.season}$${g.base}$${q}`, title, url: `${this.base}/search/video/${q}`, subOrDub: "sub" }
    }

    private candidates(m: Media): Cand[] {
        const out: Cand[] = []
        const add = (t: string, full: boolean, romaji: boolean) => {
            if (this.placeholder.test(t)) return
            const n = this.norm(t)
            for (const v of /\b(?:ova|oad)\b/i.test(t) ? [n, n + " ova"] : [n]) {
                const s = this.split(v)
                if (s.base.length >= 2) out.push({ base: s.base, season: s.season, full, romaji })
            }
        }
        const titles = [m.romajiTitle || "", m.englishTitle || ""].concat(m.synonyms || [])
        titles.forEach((t, i) => {
            add(t, true, i === 0)
            if (this.cut(t) !== t) add(this.cut(t), false, i === 0)
        })
        return out
    }

    private cut(t: string): string {
        return t.split(/:|\s[-–]\s|[~～]/)[0]
    }

    private level(g: Group, cands: Cand[]): number {
        const gs = g.base.replace(/ /g, "")
        let best = 0
        for (const c of cands) {
            const same = c.season === g.season
            if (same && this.near(gs, c.base.replace(/ /g, ""))) best = Math.max(best, c.full ? 3 : 2)
            else if (same && c.full && gs.length >= 5 && c.base.indexOf(g.base + " ") === 0) best = Math.max(best, 2)
            else if (c.romaji && g.eps.length > 1 && c.base.split(" ").some((t) => t.length >= 5 && ` ${g.base} `.indexOf(` ${t} `) !== -1)) best = Math.max(best, 1)
        }
        return best < 2 && this.subtitled(g, cands) ? 2 : best
    }

    private site(series: string): { base: string; season: number } {
        return this.split(this.norm(series) + (/\b(?:ova|oad)\b/i.test(series) ? " ova" : ""))
    }

    private subtitled(g: Group, cands: Cand[]): boolean {
        const k = this.site(this.cut(g.series))
        return k.base !== g.base && cands.some((c) => c.full && c.season === k.season && this.near(k.base.replace(/ /g, ""), c.base.replace(/ /g, "")))
    }

    private named(s: Section, cands: Cand[]): boolean {
        return (
            s.links.length > 0 &&
            s.names.some((a) => {
                const k = this.split(this.norm(a))
                return cands.some((c) => c.full && c.season === k.season && this.near(c.base.replace(/ /g, ""), k.base.replace(/ /g, "")))
            })
        )
    }

    private near(a: string, b: string): boolean {
        if (!a || !b) return false
        if (a === b) return true
        if (Math.min(a.length, b.length) < 12 || Math.abs(a.length - b.length) > 1) return false
        let i = 0
        while (a.charAt(i) === b.charAt(i)) i++
        return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i)
    }

    private norm(s: string): string {
        return (s || "")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[’'‘`]/g, "")
            .replace(/&/g, " and ")
            .replace(/×/g, " x ")
            .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\b(?:the animation|ova|oad|hentai|uncensored)\b/g, " ")
            .replace(/\biii\b/g, "3")
            .replace(/\bii\b/g, "2")
            .replace(/\bwo\b/g, "o")
            .replace(/\s+/g, " ")
            .trim()
    }

    private split(n: string): { base: string; season: number } {
        const t = n.replace(/^(?:the|a|an) (?=\S)/, "")
        const r = /^(.+?) (?:season (\d+)|(\d+)(?:st|nd|rd|th) season|(\d{1,2}))$/.exec(t)
        return r ? { base: r[1], season: parseInt(r[2] || r[3] || r[4], 10) } : { base: t, season: 1 }
    }

    private head(title: string): { series: string; season: number; ep: number; bare: boolean } | null {
        let s = this.decode(title)
        const cut = /\s[-–—]+\s|\d[-–—]\s/.exec(s)
        if (cut) s = s.slice(0, cut.index + (/\d/.test(cut[0].charAt(0)) ? 1 : 0))
        if (/preview|trailer|teaser|\bdub(?:s|bed)?\b/i.test(s)) return null
        s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim()
        let r = /^(.+?)\s*\bS(\d{1,2})\s*E(\d+(?:\.\d+)?)$/i.exec(s) || /^(.+?)\s+(\d{1,2})\s*ep(?:isode)?\.?\s*(\d+(?:\.\d+)?)$/i.exec(s)
        let series = s
        let season = 1
        let ep = 1
        if (r) {
            series = r[1]
            season = parseInt(r[2], 10)
            ep = Number(r[3])
        } else if ((r = /^(.+?)\s+(?:(?:ep(?:isode)?|vol(?:ume)?|part)\.?\s*)?(\d+(?:\.\d+)?)(?:\s*:\D*)?$/i.exec(s))) {
            series = r[1]
            ep = Number(r[2])
        } else if (/\s\d+\s|\b(?:bonus|special|extra|omake)\b/i.test(s)) return null
        return Number.isInteger(ep) && ep > 0 && ep < 1000 ? { series, season, ep, bare: !r } : null
    }

    private items(html: string, q: string): Item[] {
        const out: Item[] = []
        const re = /<a\s[^>]*class="[^"]*\bvideo-title\b[^"]*"[^>]*>/g
        let last = 0
        let a: RegExpExecArray | null
        while ((a = re.exec(html))) {
            const thumbs = html.slice(last, a.index).match(/\/videos\/\d+\/\d+\//g)
            last = re.lastIndex
            const href = (/\bhref="([^"]*)"/.exec(a[0]) || [])[1] || ""
            const id = (/-([A-Za-z0-9]{11})\.html$/.exec(href) || /\/video\/([A-Za-z0-9]{11})(?:\/|$)/.exec(href) || [])[1]
            const h = id ? this.head((/\btitle="([^"]*)"/.exec(a[0]) || [])[1] || "") : null
            if (!id || !h) continue
            const s = this.site(h.series)
            const season = h.season > 1 ? h.season : s.season
            const num = thumbs ? parseInt(thumbs[thumbs.length - 1].split("/")[3], 10) : 0
            out.push({ id, num, q, series: h.series, base: s.base, season, ep: h.ep, key: `${s.base}#${season}`, bare: h.bare })
        }
        return out
    }

    private groups(items: Item[]): Group[] {
        const out: Group[] = []
        for (const it of items) {
            let g = out.filter((x) => x.key === it.key)[0]
            if (!g) out.push((g = { key: it.key, base: it.base, season: it.season, series: it.series, items: [], eps: [] }))
            g.items.push(it)
            if (g.eps.indexOf(it.ep) === -1) g.eps.push(it.ep)
        }
        out.forEach((g) => g.items.sort((a, b) => a.ep - b.ep || b.num - a.num))
        return out
    }

    private sections(html: string, page: string): Section[] {
        const box = /<div class="ubox-text"/g
        let m: RegExpExecArray | null
        while ((m = box.exec(html))) {
            const tag = /<(\/?)div\b/gi
            tag.lastIndex = m.index
            let depth = 0
            let end = html.length
            let t: RegExpExecArray | null
            while ((t = tag.exec(html))) {
                depth += t[1] ? -1 : 1
                if (depth === 0) {
                    end = t.index
                    break
                }
            }
            const body = html.slice(m.index, end)
            if (!/<a\s[^>]*href="https:\/\/www\.hentaicity\.com\/video\//.test(body)) continue
            const link = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
            const out: Section[] = []
            let cur: Section | null = null
            let from = body.indexOf(">") + 1
            let l: RegExpExecArray | null
            const loose: { sec: Section; ep: number }[] = []
            const own = (lines: string[]): string[] => {
                while (cur && lines.length && /^(?:episode|ep|part)\.?\s*\d+$/i.test(lines[0])) loose.push({ sec: cur, ep: parseInt(lines.splice(0, 1)[0].replace(/\D+/g, ""), 10) })
                return lines
            }
            while ((l = link.exec(body))) {
                const gap = body.slice(from, l.index)
                from = link.lastIndex
                const bold: string = cur ? "" : (/<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(gap) || [])[1] || ""
                const name: string | undefined = own(this.lines(bold || gap))[0]
                if (name || !cur) out.push((cur = { names: (name || "").split(/\s+\/\s+/), links: [] }))
                if (name) own(this.lines(gap).slice(-1))
                const href = /\bhref="([^"]*)"/.exec(l[1])
                const id = href ? (/^https:\/\/www\.hentaicity\.com\/video\/[^"]*-([A-Za-z0-9]{11})\.html$/.exec(href[1]) || [])[1] : page
                const text = this.lines(l[2]).join(" ").replace(/\([^)]*\)/g, "").split(/\s[-–—]\s/)[0].trim()
                const plain = /^(?:episode|ep|part)?\.?\s*(\d+)$/i.exec(text)
                const h = plain ? null : this.head(text)
                if (!id || !(plain || h)) continue
                let sec: Section = cur
                if (h) {
                    const nm = h.series + (h.season > 1 ? ` ${h.season}` : "")
                    sec = out.filter((s) => s.names[0] === nm)[0] || out[out.push({ names: [nm], links: [] }) - 1]
                }
                sec.links.push({ id, ep: h ? h.ep : parseInt((plain as RegExpExecArray)[1], 10) })
            }
            own(this.lines(body.slice(from)))
            if (loose.length === 1 && !out.some((s) => s.links.some((x) => x.id === page))) loose[0].sec.links.push({ id: page, ep: loose[0].ep })
            const heads = out[0].names.map((n) => this.split(this.norm(n)).base)
            for (const s of out.slice(1)) {
                const k = this.split(this.norm(s.names[0]))
                if (heads.indexOf(k.base) !== -1) s.names = s.names.concat(out[0].names.map((n) => (k.season > 1 ? `${n} ${k.season}` : n)))
            }
            return out
        }
        return []
    }

    private lines(html: string): string[] {
        return this.decode(html.replace(/<br\s*\/?>|<\/?(?:div|p|b|strong)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""))
            .split("\n")
            .map((x) => x.replace(/\s+/g, " ").trim())
            .filter((x) => !!x)
    }

    private decode(s: string): string {
        const named: { [k: string]: string } = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " " }
        return (s || "").replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt|nbsp);/gi, (_, e: string) => {
            const k = e.toLowerCase()
            if (k.charAt(0) !== "#") return named[k]
            return String.fromCharCode(k.charAt(1) === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10))
        })
    }

    private async find(q: string, scope: string): Promise<Item[]> {
        const ck = `hentaicity:q:${q}`
        const hit = this.readCache<Item[]>(ck, 300000)
        if (hit) return hit
        const r = await this.get(`${this.base}/search/video/${q}`, /class="[^"]*\bvideo-title\b|No files matching your search|class="search-holder"/)
        if (!r.ok) throw this.bad(r, scope, scope === "search" ? "search" : "the episode list", "search page")
        const items = this.items(r.body, q)
        this.writeCache(ck, items)
        return items
    }

    private async box(id: string, scope: string): Promise<Section[]> {
        const ck = `hentaicity:box:${id}`
        const hit = this.readCache<Section[]>(ck, this.ttl)
        if (hit) return hit
        const r = await this.get(`${this.base}/video/x-${id}.html`, this.src)
        if (r.status === 404) {
            if (scope === "search") return []
            throw this.fail(scope, "hentaicity: this show's page is gone from the site - match it again", "info")
        }
        if (!r.ok) throw this.bad(r, scope, scope === "search" ? "search" : "the episode list", "video page")
        const secs = this.sections(r.body, id)
        this.writeCache(ck, secs)
        return secs
    }

    private async synonyms(id: number): Promise<string[]> {
        const ck = `hentaicity:syn:${id}`
        const hit = this.readCache<string[]>(ck, 86400000)
        if (hit) return hit
        try {
            const res = await fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ query: "query($id:Int){Media(id:$id,type:ANIME){synonyms}}", variables: { id } }),
                noCloudflareBypass: true,
            })
            const media = res.status === 200 ? (res.json<any>().data || {}).Media : null
            if (!media || !Array.isArray(media.synonyms)) return []
            const out: string[] = media.synonyms.filter((x: unknown) => typeof x === "string")
            this.writeCache(ck, out)
            return out
        } catch (_e) {
            return []
        }
    }

    private async get(url: string, want: RegExp): Promise<Got> {
        let out: Got = { ok: false, status: 0, body: "", why: "" }
        for (let i = 0; i < 2 && !out.ok && out.status !== 404; i++) {
            try {
                const res = await fetch(url, { noCloudflareBypass: true })
                const body = res.text()
                const busy = res.status === 403 && /<title>\s*Service Unavailable/i.test(body) ? " (Service Unavailable)" : ""
                out = { ok: res.status === 200 && want.test(body), status: res.status, body, why: `answered HTTP ${res.status}${busy}` }
            } catch (e) {
                out = { ok: false, status: 0, body: "", why: this.net(e) }
            }
        }
        return out
    }

    private bad(r: Got, scope: string, what: string, page: string): string {
        if (r.status === 200) return this.fail(scope, `hentaicity: the site changed its ${page} - this extension needs an update`)
        return this.fail(scope, `hentaicity: ${what} failed - the site ${r.why}`)
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
            const line = "SEHERRv1 " + JSON.stringify({ t: Date.now(), ext: "aq-hentaicity", scope: scope, msg: this.plain(message), lvl: lvl })
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
