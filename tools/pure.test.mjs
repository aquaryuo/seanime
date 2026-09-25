import fs from "fs"
import { execFileSync } from "child_process"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

let failures = 0
let checks = 0
let skipped = 0

const run = (what, fn) => fn(what)
const pending = (what) => { skipped++; console.log(`  skip ${what}`) }

function eq(actual, expected, what) {
    checks++
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) {
        failures++
        console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`)
    }
}

function compile(src) {
    return execFileSync("npx", ["esbuild", "--loader=ts", "--target=es2018"], {
        input: fs.readFileSync(src),
        encoding: "utf8",
        shell: true,
        stdio: ["pipe", "pipe", "ignore"],
    })
}

function load(name, overrides) {
    const js = compile(`${ROOT}/extensions/${name}/provider.ts`)
    const boom = (who) => () => { throw new Error(`pure test touched ${who}`) }
    const g = {
        fetch: boom("fetch"),
        LoadDoc: boom("LoadDoc"),
        $getUserPreference: () => undefined,
        $store: { get: () => undefined, set: () => {}, remove: () => {}, has: () => false },
        $scannerUtils: { normalizeTitle: () => null, buildSmartSearchTitles: () => null },
        $toBytes: (s) => new Uint8Array(Buffer.from(String(s), "utf8")),
        CryptoJS: {},
        console: { log() {}, info() {}, warn() {}, error() {} },
    }
    for (const k in overrides || {}) g[k] = overrides[k]
    const keys = Object.keys(g)
    const Provider = new Function(...keys, `${js}\nreturn Provider`)(...keys.map((k) => g[k]))
    return new Provider()
}

let aquatilsJs = ""
function bootPlugin(fakes = {}) {
    aquatilsJs = aquatilsJs || compile(`${ROOT}/plugins/aquatils/plugin.ts`)
    const h = {
        now: 1767225600000,
        storage: new Map(Object.entries(fakes.storage || {})),
        files: Object.assign({}, fakes.files),
        handlers: {}, polls: {}, cmds: [], timers: [], notes: [], toasts: [], reported: [], downloads: [],
    }
    const bytes = (s) => new Uint8Array(Buffer.from(s))
    const under = (p) => Object.keys(h.files).filter((f) => f === p || f.startsWith(p + "/"))
    const running = {}
    const tray = new Proxy({
        update() {},
        updateBadge() {},
        render: (fn) => { h.render = fn },
        onOpen() {},
        onClose() {},
    }, { get: (o, k) => o[k] || ((a, b) => ({ t: k, a, b })) })
    const ctx = {
        state: (v) => { const s = { value: v, get: () => s.value, set: (x) => { s.value = x } }; return s },
        fieldRef: (v) => ({ current: v, onValueChange() {} }),
        newTray: () => tray,
        dom: { observe() {} },
        downloader: { download: (url) => h.downloads.push(url), watch: () => () => {}, cancel() {} },
        fetch: (url, o) => {
            const r = (fakes.fetch || (() => null))(url, o && o.body ? JSON.parse(o.body) : {})
            return r ? Promise.resolve({ ok: !r.status || r.status < 400, status: r.status || 200, json: () => r.json, text: () => r.text || "" }) : Promise.reject(new Error("connection refused"))
        },
        jobs: {
            poll: (key, fn, ms, o) => { h.polls[key] = fn; if (o && o.immediate) fn() },
            singleflight: (key, fn) => running[key] || (running[key] = Promise.resolve(fn()).finally(() => { delete running[key] })),
        },
        registerEventHandler: (id, fn) => { h.handlers[id] = fn },
        setTimeout: (fn) => h.timers.push(fn),
        notification: { send: (m) => h.notes.push(m) },
        toast: new Proxy({}, { get: (_, k) => (m) => h.toasts.push(k + ": " + m) }),
    }
    const os = {
        platform: "linux",
        arch: "amd64",
        ...fakes.os,
        cacheDir: () => "/cache",
        stat: (p) => { if (!under(p).length) throw new Error("not found"); return { size: () => (h.files[p] || "").length } },
        readFile: (p) => { if (!(p in h.files)) throw new Error("not found"); return bytes(h.files[p]) },
        readDir: () => [],
        removeAll: (p) => under(p).forEach((f) => delete h.files[f]),
        mkdirAll() {},
        truncate: (p) => { h.files[p] = "" },
    }
    const osExtra = {
        asyncCmd: (...args) => {
            const c = { args: args.join(" ") }
            h.cmds.push(c)
            const cmd = { environ: () => [], process: { kill() {} } }
            return {
                getCommand: () => (c.cmd = cmd),
                run: (cb) => {
                    c.line = (s) => cb(bytes(s), undefined, undefined, undefined)
                    c.fail = (s) => cb(undefined, bytes(s), undefined, undefined)
                    c.exit = (code) => cb(undefined, undefined, code, "")
                    if (c.cmd) return
                    const r = (fakes.sh || (() => ({})))(c.args) || {}
                    setImmediate(() => { (r.out || []).forEach(c.line); c.exit(r.code || 0) })
                },
            }
        },
    }
    class FakeDate extends Date {
        constructor(...a) { super(...(a.length ? a : [h.now])) }
        static now() { return h.now }
    }
    const g = {
        $ui: { register: (cb) => cb(ctx) },
        $storage: { get: (k) => h.storage.get(k), set: (k, v) => h.storage.set(k, v), remove: (k) => h.storage.delete(k) },
        $os: os,
        $osExtra: osExtra,
        $filepath: { join: (...p) => p.join("/") },
        $toString: (b) => (typeof b === "string" ? b : Buffer.from(b).toString("utf8")),
        Date: FakeDate,
        console: { log() {}, info() {}, warn() {}, error: (s) => { if (String(s).startsWith("SEHERRv1 ")) h.reported.push(JSON.parse(s.slice(9)).msg) } },
    }
    new Function(...Object.keys(g), `${aquatilsJs}\ninit()`)(...Object.values(g))
    h.fire = (id) => h.handlers[id]()
    h.tick = (key) => h.polls[key]()
    h.settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)) }
    h.spawns = () => h.cmds.filter((c) => c.cmd)
    h.status = () => ({ Running: "up", Starting: "starting", Off: "down", Checking: "unknown" })[(/"a":"(Running|Starting|Off|Checking)"/.exec(JSON.stringify(h.render())) || [])[1]]
    return h
}

console.log("anikoto")
{
    const p = load("anikoto")

    const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: "e" + (i + 1), number: i + 1, url: "u" + (i + 1) }))

    let eps = mk(22)
    p.applySeasonWindow(eps, 12, 0, 22)
    eq(eps.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "season window: part 1 of 22 takes the first 12")
    eq(eps[0].id, "e1", "season window: part 1 keeps the leading source episodes")

    eps = mk(22)
    p.applySeasonWindow(eps, 10, 2, 22)
    eq(eps.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "season window: part 2 of 22 renumbers the last 10 from 1")
    eq(eps[0].id, "e13", "season window: part 2 starts at the site's episode 13")

    eps = mk(12)
    p.applySeasonWindow(eps, 12, 0, 12)
    eq(eps.length, 12, "season window: untouched when the counts already agree")

    eps = mk(1177)
    p.applySeasonWindow(eps, -1, 0, 1177)
    eq(eps.length, 1177, "season window: skipped when the tracker reports -1 episodes")

    eps = mk(18)
    p.applySeasonWindow(eps, 10, 2, 22)
    eq(eps.map((e) => e.id + ":" + e.number), ["e13:1", "e14:2", "e15:3", "e16:4", "e17:5", "e18:6"], "season window: a part 2 with only 18 of 22 out is cut by the site's numbers, not the list length")

    eps = mk(12)
    p.applySeasonWindow(eps, 10, 2, 22)
    eq(eps.length, 0, "season window: a part 2 with none of its episodes out yet is left empty, not filled with part 1")

    const epKeys = []
    const epNode = { attr: (k) => ({ "data-id": "d1", "data-ids": "i1", "data-num": "1" })[k], find: () => ({ first: () => ({ text: () => "" }) }) }
    const epDoc = () => (sel) => ({ length: () => (sel === "footer" || sel === "ul.ep-range li > a" ? 1 : 0), first: () => ({ attr: () => "" }), each: (fn) => fn(0, epNode) })
    const epPage = (url) => Promise.resolve({ ok: true, status: 200, headers: {}, text: () => url.indexOf("/ajax/") !== -1 ? JSON.stringify({ result: "x" }) : '<footer></footer><div id="watch-main" data-id="7"></div>' })
    const ep = load("anikoto", {
        $store: { get: (k) => { epKeys.push(k); return k.indexOf("anikoto:al:") === 0 ? { at: Date.now(), data: 5 } : undefined }, set() {}, remove() {}, has: () => false },
        LoadDoc: epDoc,
        fetch: (url) => url.indexOf("://anikototv.to/") !== -1 ? Promise.reject(new Error("no such host")) : epPage(url),
    })
    eq((await ep.findEpisodes("https://anikototv.to/watch/show-1$sub"))[0].url, "https://anikoto.cz/watch/show-1/ep-1", "episodes: an id whose mirror is down is served from the next mirror")
    await ep.findEpisodes("https://anikototv.to/watch/show-1$sub$ec10$pt2$al5")
    const ek = epKeys.filter((x) => x.indexOf("anikoto:eps2:") === 0)
    eq(ek.length === 2 && ek[0] !== ek[1], true, "episodes cache: a manual id and a windowed id for the same show do not share a cached list")

    const hung = load("anikoto", {
        LoadDoc: epDoc,
        fetch: (url) => {
            if (url.indexOf("://anikototv.to/") === -1) return epPage(url)
            hung.deadline = 1
            return Promise.reject(new Error("i/o timeout"))
        },
    })
    eq((await hung.findEpisodes("https://anikototv.to/watch/show-1$sub"))[0].url, "https://anikoto.cz/watch/show-1/ep-1", "episodes: a mirror that hangs past the budget still falls over to the next one")

    let limited = 0
    const rl = load("anikoto", { LoadDoc: epDoc, fetch: () => { limited++; return Promise.resolve({ ok: false, status: 429, headers: {}, text: () => "" }) } })
    await rl.findEpisodes("https://anikototv.to/watch/show-1$sub").catch(() => {})
    eq(limited, 2, "episodes: a rate-limited site is not asked again through every mirror")

    eq(p.cleanLabel("English"), "English", "label: plain title is untouched")
    eq(p.cleanLabel("English (- (Crunchyroll))"), "English (Crunchyroll)", "label: keeps the group")
    eq(p.cleanLabel("German (- Deutsch)"), "German", "label: drops a bare native name")
    eq(p.cleanLabel("Spanish (- Espanol (LA))"), "Spanish (LA)", "label: keeps the region")

    eq(p.fallbackCode("English"), "en", "lang: english maps to en")
    eq(p.fallbackCode("Danish"), "da", "lang: danish maps to da")
    eq(p.fallbackCode("Klingon"), "", "lang: an unknown language is not English")

    eq(p.buildSubtitles([{ file: "https://c/ara.vtt", label: "Arabic" }, { file: "https://c/eng.vtt", label: "Eng_sub" }]).map((s) => s.url), ["https://c/eng.vtt", "https://c/ara.vtt"], "subs: the English track leads even when the site lists it second")
    eq(p.buildSubtitles([{ file: "https://c/es.vtt", label: "Spanish (English signs)" }, { file: "https://c/pt.vtt", label: "Portuguese" }])[0].url, "https://c/pt.vtt", "subs: a label naming another language before English is not English")
    eq(p.buildSubtitles([{ file: "https://c/a.vtt", label: "  " }])[0].language, "English", "subs: a blank label is named English")

    eq(p.plain("a — b…"), "a - b...", "plain: dashes and ellipsis become ASCII")
    eq(p.plain("one\ntwo\tthree"), "one two three", "plain: newlines collapse to spaces")
    eq(/^[\x20-\x7e]*$/.test(p.plain("日本語")), true, "plain: output is ASCII only")
}

console.log("anikoto: subtitle host alignment")
{
    const VIDEO = "https://good.cdn/anime/a/b/master.m3u8"
    const mk = (subHost) => ({
        server: "Auto",
        headers: { Referer: "https://megaplay.buzz/", Origin: "https://megaplay.buzz" },
        videoSources: [{
            url: VIDEO, type: "m3u8", quality: "default",
            subtitles: [
                { id: "en-0", url: `https://${subHost}/anime/a/b/subtitles/eng.vtt`, language: "English", isDefault: true },
                { id: "ar-1", url: `https://${subHost}/anime/a/b/subtitles/ara.vtt`, language: "Arabic", isDefault: false },
            ],
        }],
    })
    const provider = (reachable) => load("anikoto", {
        fetch: (url) => Promise.resolve(
            reachable(url)
                ? { ok: true, status: 200, text: () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n" }
                : { ok: false, status: 403, text: () => "" },
        ),
    })

    const blocked = mk("sinkholed.cdn")
    await provider((u) => u.indexOf("good.cdn") !== -1).alignSubtitleHost(blocked)
    eq(blocked.videoSources[0].subtitles.map((s) => s.url), [
        "https://good.cdn/anime/a/b/subtitles/eng.vtt",
        "https://good.cdn/anime/a/b/subtitles/ara.vtt",
    ], "subs: an unreachable subtitle host is swapped to the host the video plays from")

    const fine = mk("other.cdn")
    await provider(() => true).alignSubtitleHost(fine)
    eq(fine.videoSources[0].subtitles[0].url, "https://other.cdn/anime/a/b/subtitles/eng.vtt", "subs: a reachable subtitle host is left alone")

    const noHelp = mk("sinkholed.cdn")
    await provider(() => false).alignSubtitleHost(noHelp)
    eq(noHelp.videoSources[0].subtitles[0].url, "https://sinkholed.cdn/anime/a/b/subtitles/eng.vtt", "subs: no swap when the video host cannot serve them either")

    const sinkholed = mk("blocked.cdn")
    const blockPage = load("anikoto", {
        fetch: (url) => Promise.resolve(
            url.indexOf("good.cdn") !== -1
                ? { ok: true, status: 200, text: () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n" }
                : { ok: true, status: 200, text: () => "<!doctype html><title>DNS Blocking Page</title>" },
        ),
    })
    await blockPage.alignSubtitleHost(sinkholed)
    eq(sinkholed.videoSources[0].subtitles[0].url, "https://good.cdn/anime/a/b/subtitles/eng.vtt", "subs: a DNS sinkhole answering 200 with HTML is not mistaken for a subtitle")

    const same = mk("good.cdn")
    let calls = 0
    const counting = load("anikoto", { fetch: () => { calls++; return Promise.resolve({ ok: true, status: 200, text: () => "WEBVTT" }) } })
    await counting.alignSubtitleHost(same)
    eq(calls, 0, "subs: costs nothing when subtitles already sit on the video host")

    const mirror = mk("sinkholed.cdn")
    mirror.videoSources[0].url = "https://mirror.cdn/a/b/master.m3u8"
    await provider((u) => u.indexOf("https://ncdn.imgnex.top/anime/") === 0).alignSubtitleHost(mirror)
    eq(mirror.videoSources[0].subtitles.map((s) => s.url), [
        "https://ncdn.imgnex.top/anime/a/b/subtitles/eng.vtt",
        "https://ncdn.imgnex.top/anime/a/b/subtitles/ara.vtt",
    ], "subs: a video mirror with another path layout falls through to a known CDN")

    const late = mk("sinkholed.cdn")
    const lateProvider = provider((u) => u.indexOf("good.cdn") !== -1)
    lateProvider.deadline = 1
    await lateProvider.alignSubtitleHost(late)
    eq(late.videoSources[0].subtitles[0].url, "https://good.cdn/anime/a/b/subtitles/eng.vtt", "subs: the swap still happens once the time budget is spent")

    const probes = []
    const spent = load("anikoto", {
        $store: { get: (k) => (k === "anikoto:cdnhosts" ? { at: Date.now(), data: ["h1.cdn", "h2.cdn"] } : undefined), set() {}, remove() {}, has: () => false },
        fetch: (url) => { probes.push(url.split("/")[2]); return Promise.resolve({ ok: false, status: 404, text: () => "" }) },
    })
    spent.deadline = 1
    await spent.alignSubtitleHost(mk("sinkholed.cdn"))
    eq(probes, ["sinkholed.cdn", "good.cdn", "ncdn.imgnex.top"], "subs: once the budget is spent only the video host and the known CDN are tried, not every learned host")
}

console.log("anikoto: time budget")
{
    const p = load("anikoto", {
        fetch: (url) => {
            if (url.indexOf("master") !== -1) p.deadline = 1
            return Promise.resolve({ ok: true, status: 200, text: () => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nindex-f1.m3u8\n" })
        },
    })
    const ok = await p.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url: "https://c.cdn/a/master.m3u8", type: "m3u8", quality: "default", subtitles: [] }] })
    eq(ok, true, "budget: a stream whose master loaded is kept when the clock runs out before the variants are checked")

    const q = load("anikoto", {
        fetch: (url) => {
            if (url.indexOf("master") !== -1) return Promise.resolve({ ok: true, status: 200, text: () => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv2.m3u8\n" })
            q.deadline = 1
            return Promise.reject(new Error("i/o timeout"))
        },
    })
    eq(await q.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url: "https://c.cdn/a/master.m3u8", type: "m3u8", quality: "default", subtitles: [] }] }), false, "budget: a stream whose first variant just failed is not kept because the clock ran out")

    const learned = []
    const lp = load("anikoto", {
        $store: { get: () => undefined, set: (k, v) => { if (k === "anikoto:cdnhosts") learned.push(v.data[0]) }, remove() {}, has: () => false },
        fetch: () => Promise.resolve({ ok: true, status: 200, text: () => "#EXTM3U\n" }),
    })
    for (const url of ["https://megap.x.top/0a4afc550434c2fa75a83a3fbdb408d0/b/master.m3u8", "https://fetch.y.top/anime/a/b/master.m3u8"]) {
        await lp.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url, type: "m3u8", quality: "default", subtitles: [] }] })
    }
    eq(learned, ["fetch.y.top"], "cdn: only hosts with the /anime/ layout are learned as subtitle and failover hosts")
}

console.log("anikoto: enc resolve cost")
{
    const EMBED = "https://megaplay.buzz/stream/s-2/1/sub?s=bcdn"
    const fetched = []
    const res = (body, ok = true, status = 200) => ({ ok, status, text: () => body, json: () => JSON.parse(body) })
    const p = load("anikoto", {
        LoadDoc: () => () => ({ first: () => ({ attr: () => "", text: () => "" }), length: () => 0, each: () => {}, find: () => ({ first: () => ({ text: () => "" }) }) }),
        CryptoJS: { AES: { decrypt: () => ({ toString: () => JSON.stringify({ file: "https://cdn.test/a/master.m3u8" }) }) }, enc: { Utf8: 1 } },
        fetch: (url) => {
            fetched.push(url)
            if (url.indexOf("/ajax/server?get=") !== -1) return Promise.resolve(res(JSON.stringify({ status: 200, result: { url: EMBED } })))
            if (url === EMBED) return Promise.resolve(res('<div id="megaplay-player" data-id="177919"></div><script src="/lib/newclient.min.js"></script>'))
            if (url.indexOf("getSources") !== -1) return Promise.resolve(res(JSON.stringify({ tracks: [], enc: "AAAA" })))
            return Promise.resolve(res("", false, 404))
        },
    })

    const got = await p.fetchSources("L1")
    eq(got && got.file, "https://cdn.test/a/master.m3u8", "enc: the hardcoded key resolves the file")
    eq(fetched.filter((u) => u === EMBED).length, 1, "enc: the embed page is fetched once, not re-scanned")
    eq(fetched.some((u) => u.indexOf("/lib/") !== -1), false, "enc: no player script is downloaded when a known key works")
    eq(fetched.filter((u) => u.indexOf("getSources") !== -1), ["https://megaplay.buzz/stream/getSourcesNew?id=177919&s=bcdn"], "enc: one source request, carrying the embed's CDN selector")

    const scan = load("anikoto", {
        fetch: (url) => Promise.resolve(res(url === EMBED
            ? '<script src="https://megaplay.buzz/lib/newclient.min.js"></script>'
            : 'a=String(e.pick(["trustAesKey","TRUST_AES_KEY"],"0123456789abcdef")),k=(new TextEncoder).encode("0123456789abcdef"),v=(new TextEncoder).encode("fedcba9876543210")')),
    })
    eq((await scan.scanEncKeys("https://megaplay.buzz", EMBED)).some((k) => k.key === "0123456789abcdef" && k.iv === "fedcba9876543210"), true, "enc: a rotated key is recovered from the player script's encode() literals")
}

console.log("anikoto: search matching")
{
    const seasons = { "Shangri-La Frontier Season 2": 2 }
    const p = load("anikoto", { $scannerUtils: { normalizeTitle: (t) => ({ season: seasons[t] || -1, part: -1 }), buildSmartSearchTitles: () => null } })
    const hit = (title, url) => ({ id: url || title, title, url: url || title, subOrDub: "sub" })
    const media = (romajiTitle, englishTitle, format) => ({ id: 1, romajiTitle, englishTitle, format })
    const titles = (rs) => rs.map((r) => r.title)

    eq([
        titles(p.filterBySeason([hit("Shangri-La Frontier"), hit("Shangri-La Frontier Season 2")], 3, 0, media("Shangri-La Frontier 3rd Season", "Shangri-La Frontier Season 3", "TV"))),
        titles(p.filterBySeason([hit("LUPIN THE 3rd PART 6")], 3, 6, media("Lupin III: Part 6", "Lupin III: Part 6", "TV"))),
    ], [[], ["LUPIN THE 3rd PART 6"]], "season: a season the site does not have yet is not served by an earlier one, but an unparsed title is kept")

    const movies = [hit("Jujutsu Kaisen 0 Movie"), hit("Ashita no Joe 2 (Movie)")]
    const dice = (m) => { const w = p.wordDice(movies, m); return w && w.s >= 0.5 ? w.r.title : null }
    eq([dice(media("Jujutsu Kaisen 0", "Jujutsu Kaisen 0", "MOVIE")), dice(media("Madogiwa no Totto-chan", "Totto-Chan: The Little Girl at the Window", "MOVIE"))], ["Jujutsu Kaisen 0 Movie", null], "movie: the site's movie card is found by word overlap, an unrelated film is not")

    p.alt["g"] = "Hai to Gensou no Grimgar"
    eq(titles(p.sameShow([hit("Grimgar: Ashes and Illusions", "g")], media("Hai to Gensou no Grimgar", "Grimgar of Fantasy and Ash", "TV"))), ["Grimgar: Ashes and Illusions"], "match: the card's romaji title counts when the site's English name differs")

    const ev = { m: { episodes: 1, movie: true }, t: { episodes: 12, movie: false } }
    eq(titles(p.preferByEvidence([hit("Movie", "m"), hit("Show", "t")], ev, { id: 0 })), ["Movie", "Show"], "manual: a search with no media format keeps movie cards")

    const keys = []
    const k = load("anikoto", { $store: { get: (key) => { keys.push(key) }, set() {}, remove() {}, has: () => false } })
    for (const id of [182205, 156822]) await k.search({ query: "", dub: false, media: { id, romajiTitle: "Slime", englishTitle: "Slime", format: "TV", episodeCount: 24 } }).catch(() => {})
    const sk = keys.filter((x) => x.indexOf("anikoto:srch:") === 0)
    eq(sk.length === 2 && sk[0] !== sk[1], true, "search cache: sibling seasons with the same queries do not share a cached result")
}

console.log("animepahe")
{
    const p = load("animepahe")
    eq(p.remoteHttps("https://cdn.example.com/a.m3u8"), true, "url: a normal remote host is allowed")
    eq(p.remoteHttps("https://127.0.0.1/a.m3u8"), false, "url: loopback is rejected")
    eq(p.remoteHttps("https://localhost:8191/a.m3u8"), false, "url: localhost is rejected")
    eq(p.remoteHttps("https://box.local/a.m3u8"), false, "url: .local is rejected")
    eq(p.remoteHttps("https://evil.com@127.0.0.1/a.m3u8"), false, "url: userinfo cannot smuggle loopback past the host check")
    eq(p.remoteHttps("https://192.168.1.5:8080/a.m3u8"), false, "url: private IPv4 is rejected")

    const ordinals = {
        "Attack on Titan Season 2": { season: 2, part: 1 },
        "Shingeki no Kyojin Season 2": { season: 2, part: 1 },
        "Unrelated Show Season 2": { season: 2, part: 1 },
        "Attack on Titan Season 3 Part 2": { season: 3, part: 2 },
    }
    const s = load("animepahe", {
        $scannerUtils: { normalizeTitle: (t) => ordinals[t] || { season: 1, part: 1 }, buildSmartSearchTitles: () => null },
    })
    const opts = (q, romaji, english) => ({ query: q, dub: false, media: { id: 1, romajiTitle: romaji, englishTitle: english } })
    const hit = (title) => ({ id: title, title, url: "", subOrDub: "both" })
    const ids = (rs) => rs.map((r) => r.id)

    eq(
        ids(s.filterBySeason([hit("Attack on Titan Season 2"), hit("Unrelated Show Season 2"), hit("Attack on Titan")], opts("Attack on Titan Season 2", "Shingeki no Kyojin Season 2", "Attack on Titan Season 2"))),
        ["Attack on Titan Season 2"],
        "season: the other show's season 2 is dropped before the ordinal match",
    )
    eq(
        ids(s.filterBySeason([hit("Unrelated Show Season 2"), hit("Attack on Titan")], opts("Attack on Titan Season 2", "Shingeki no Kyojin Season 2", "Attack on Titan Season 2"))),
        ["Attack on Titan"],
        "season: no ordinal-bearing entry falls back to the show, not to a stranger",
    )
    eq(
        ids(s.filterBySeason([hit("Attack on Titan Season 3 Part 2"), hit("Attack on Titan Season 2")], opts("", "Attack on Titan Season 3 Part 2", ""))),
        ["Attack on Titan Season 3 Part 2"],
        "season: season and part are matched independently",
    )
    eq(
        ids(s.filterBySeason([hit("Anything At All")], opts("Anything At All", "", ""))),
        ["Anything At All"],
        "season: a manual search with no media titles keeps every result",
    )
}

console.log("anizone")
{
    const p = load("anizone")
    eq(p.statedEpisodeCount("<span>1180 Episodes</span>"), 1180, "episodes: reads the stated count")
    eq(p.statedEpisodeCount("<span>no count here</span>"), 0, "episodes: absent count reads as zero")
    eq(p.isNonDialogue("English - Full Subtitles"), false, "track: a full dialogue track is not signs-only")
    eq(p.isNonDialogue("English (Signs & Songs)"), true, "track: signs and songs is non-dialogue")
    eq(p.trackScore("English", true, false, false) > p.trackScore("English (Signs)", true, false, true), true, "track: dialogue outranks signs")
    eq(p.trackScore("English", true, true, false) > p.trackScore("English", true, false, false), true, "track: the site default breaks ties upward")

    eq(p.langName("he"), "Hebrew", "lang: a code the site serves is named")
    eq(p.langName("pt-br"), "Portuguese (Brazil)", "lang: a regional code keeps its region")
    eq(p.langName("zz"), "ZZ", "lang: an unknown code falls back to the code")

    eq(p.decodeEntities("&#128512;"), "\u{1F600}", "entities: an astral codepoint decodes to one emoji")
    eq(p.decodeEntities("&#x41;&amp;&#66;"), "A&B", "entities: hex and decimal both decode")
    eq(p.decodeEntities("&#1114112;"), "&#1114112;", "entities: an out-of-range codepoint is left alone")

    const seenMethods = []
    const probe = load("anizone", {
        fetch: (url, opts) => {
            seenMethods.push((opts && opts.method) || "GET")
            return Promise.resolve({ ok: false, status: 404, text: () => "" })
        },
    })
    const trimmed = await probe.trimToExisting("abc123", 5, 2)
    eq(seenMethods.length > 0, true, "probe: the tail probe actually ran")
    eq(seenMethods.filter((m) => m !== "GET"), [], "probe: existence is checked with GET - HEAD never completes on this site")
    eq(trimmed, { last: 2, sure: true }, "probe: an all-404 tail trims to the highest listed episode")

    let probes = 0
    const upTo = (last, other) => load("anizone", {
        fetch: (url) => {
            probes++
            const status = other || (parseInt(url.split("/").pop(), 10) <= last ? 200 : 404)
            return Promise.resolve({ ok: status === 200, status, text: () => "" })
        },
    })
    eq([(await upTo(30).trimToExisting("abc123", 48, 24)).last, probes], [30, 12], "probe: a gap wider than the linear probes is bisected to the last real episode")
    eq(await upTo(30, 429).trimToExisting("abc123", 24, 23), { last: 24, sure: false }, "probe: a rate-limited probe keeps the stated count and reports it as undecided")

    const store = (mem) => ({ get: (k) => mem[k], set: (k, v) => { mem[k] = v }, remove: (k) => { delete mem[k] }, has: (k) => k in mem })
    const site = (more, cursor, walk, o = {}) => {
        const hits = []
        const mem = {}
        const items = JSON.stringify((o.items || [1, 2, 10]).map((n) => ({ slug: String(n) })))
        const html = `<div wire:snapshot="{&quot;data&quot;:{&quot;slug&quot;:&quot;abc123&quot;,&quot;sort&quot;:&quot;${o.sort || "default-asc"}&quot;}}" data-csrf="t"></div>items: JSON.parse('${items}'), nextCursor: ${cursor ? `'${cursor}'` : "null"}, hasMore: ${more}, <span>12 Episodes</span>`
        const s = load("anizone", {
            $store: store(mem),
            fetch: (url, opts) => {
                hits.push(url)
                if (opts && opts.method === "POST") return Promise.resolve(o.status ? { ok: false, status: o.status } : { ok: true, status: 200, json: () => ({ components: [{ snapshot: "s2", effects: { dispatches: [{ name: "items-loaded", params: walk }] } }] }) })
                if (url.endsWith("/anime/abc123")) return Promise.resolve({ ok: true, status: 200, text: () => html, cookies: {} })
                const status = o.status || (url.endsWith("/12") ? 200 : 404)
                return Promise.resolve({ ok: status === 200, status, text: () => "" })
            },
        })
        return s.findEpisodes("abc123$sub").then((eps) => [eps.map((e) => e.number), hits.length, Object.keys(mem)])
    }
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    eq(await site(false), [[1, 2, 10], 1, ["anizone:eps:abc123$sub"]], "episodes: a finished listing is trusted over the stated count, with no probes, and cached")
    eq((await site(true))[0], [1, 2, 10, 11, 12], "episodes: an unfinished listing is extended above its highest episode, not from 1")
    eq((await site(true, "c1", { items: [{ slug: "11" }, { slug: "s6" }], nextCursor: null, hasMore: false }))[0], [1, 2, 10, 11], "episodes: the cursor walk finishes the listing, so the stated count is not used")
    eq((await site(true, "c1", null, { items: [1, 2, 3] })).slice(0, 2), [all, 2], "episodes: a gapless first page skips the cursor walk and only probes the tail")
    eq((await site(true, "c1", null, { items: [1, 10, 9, 8], sort: "release-desc", status: 429 }))[0], all, "episodes: a newest-first listing cut short is filled from episode 1")
    eq(await site(true, "c1", null, { status: 429 }), [[1, 2, 10, 11, 12], 3, []], "episodes: a rate-limited listing keeps the stated count and is not cached")

    const listed = { "anizone:eps:abc123$al5$sub": { at: Date.now(), data: [{ number: 7 }] } }
    const gone = load("anizone", { $store: store(listed), fetch: () => Promise.resolve({ ok: false, status: 404, text: () => "" }) })
    const err = await gone.findEpisodeServer({ id: "abc123$7$al5$sub", number: 7, url: "" }, "Auto").catch((e) => e)
    eq([err, Object.keys(listed)], ["anizone: episode 7 is not on anizone yet - refresh the episode list", []], "server: a missing episode drops the cached list so a refresh refetches it")

    const dub = await load("anizone", { fetch: () => Promise.resolve({ ok: false, status: 503, text: () => "" }) }).hasEnglishAudio("https://cdn.test/a/master.m3u8", "abc123", "1")
    eq(dub === undefined, true, "dub: a failed audio check is undecided, not a missing dub")

    const sq = (romajiTitle, englishTitle, query) => p.searchQueries({ media: { id: 0, romajiTitle, englishTitle }, query, dub: false }).primary
    eq(sq("Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2", "Re:ZERO Season 2", "x"), ["Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2", "Re:Zero kara Hajimeru Isekai Seikatsu", "Re:ZERO Season 2", "Re:ZERO"], "search: raw titles and their season-less base are sent verbatim, punctuation kept")
    eq(sq("", null, "Kaguya-sama"), ["Kaguya-sama"], "search: a manual query is sent as typed")

    const card = (sid, title) => ({ r: { id: sid }, card: { sid, titles: [title], type: "", year: 2018, eps: 12 } })
    const pick = (romajiTitle, englishTitle, a, b, season) => p.pickBest([card("a", a), card("b", b)], { romajiTitle, englishTitle, startDate: { year: 2018 } }, season, 0).map((r) => r.id)
    eq([pick("Tokyo Ghoul:re 2", "Tokyo Ghoul:re 2", "Tokyo Ghoul:Re", "Tokyo Ghoul:Re (2018)", 2), pick("Gintama.", "Gintama Season 4", "Gintama.", "Gintama. (2018)", 4)], [["b"], ["a"]], "match: a same-year sequel takes the year-tagged card unless another card is the exact title")

    const mem = {}
    let gets = 0
    const cached = load("anizone", {
        $store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v }, remove: (k) => { delete mem[k] }, has: (k) => k in mem },
        fetch: (url) => {
            gets++
            return Promise.resolve({ ok: true, status: 200, text: () => url.endsWith("=Foo") ? `items: JSON.parse('[{"slug":"abc123","main_title":"Foo"}]')` : "<p>checking your browser</p>" })
        },
    })
    const find = (title) => cached.search({ media: { id: 0, romajiTitle: title }, query: title, dub: false }).then((r) => r.map((x) => x.id), () => "err")
    eq([await find("Foo"), await find("Foo"), gets], [["abc123$sub"], ["abc123$sub"], 1], "search: a repeated query is answered from the store, not refetched")
    eq([await find("Bar"), await find("Bar"), gets], ["err", "err", 3], "search: a page with no result markup is never cached")
}

console.log("animelok")
{
    const p = load("animelok")
    eq(p.subCode("eng", ""), "en", "lang: a three letter code normalises")
    eq(p.subCode("", "Spanish"), "es", "lang: a label-only track still resolves")
    eq(p.subCode("en", "English"), "en", "lang: a two letter code passes through")
    eq(p.trackScore("English", true, false, false) > p.trackScore("English (Signs & Songs)", true, true, true), true, "track: full dialogue beats a default signs track")
}

console.log("aquatils (source invariants)")
{
    const src = fs.readFileSync(`${ROOT}/plugins/aquatils/plugin.ts`, "utf8")
    const has = (t) => src.includes(t)
    const count = (t) => src.split(t).length - 1

    eq(has("taskkill"), false, "kill: nothing is stopped by image name alone")
    eq(has("fuser -k"), false, "kill: the port is never cleared without identifying what holds it")
    eq(has("*aquatils/*) kill -9"), true, "kill: the port sweep checks the executable is ours")
    eq(has("$p.CommandLine -like '*aquatils\\\\*'"), true, "kill: the windows sweep matches on the command line")

    eq(has('const FS_KEEP = ["chromium", "state"]'), true, "state: the keep-list names the state directory")
    eq(has('e.name() !== "chromium"'), false, "state: no bare literal is left to drift from the keep-list")
    eq(count("FS_KEEP.indexOf"), 1, "state: prune and remove share the one keep-list reader")

    eq(has('const staging = dir + ".new"'), true, "chromium: the download lands beside the working copy")
    eq(has("$os.rename(dir, previous)"), true, "chromium: the working copy is moved aside, not deleted in place")

    eq(has("aqText(scrubLog(msg))"), true, "privacy: reported errors are scrubbed before they leave")
    eq(has('out.push("lastError=" + scrubLog(err))'), true, "privacy: the diagnostics the user copies are scrubbed")
    eq(has("dl.cancel(fsChromiumDownloadId)"), true, "downloads: Stop cancels a browser download in flight")
    eq(has('setErr("The solver download failed: "'), true, "downloads: a failed solver download is reported, not only noted")
    eq(has('data.solver === "aquatils"'), true, "identity: the probe requires our own solver to claim health")
    eq(has("p.foreign"), true, "identity: another compatible server on the port is reported, not counted as healthy")
    eq(has("const avEvidence ="), true, "windows: a scanner verdict needs scanner evidence")
    eq(has("execRefused && !avEvidence"), true, "windows: a refusal to execute is reported as itself")
}

console.log("aquatils (boot)")
{
    const BIN = "/cache/aquatils/0.2.0/solver/solver"
    const LOG = "/cache/aquatils/0.2.0/solver.log"
    const INSTALLED = { "fs.solverReady": "0.2.0", "fs.wantChromium": false }
    const ours = (url) => (url === "http://127.0.0.1:8191/v1" ? { json: { solver: "aquatils", version: "0.2.0", sessions: ["seanime"] } } : null)

    await run("boot: nothing installed and nothing listening - no launch, not Running", async (what) => {
        const h = bootPlugin()
        await h.settle()
        eq([h.spawns().length, ["unknown", "down"].includes(h.status())], [0, true], what)
    })

    await run("boot: an installed solver that answers as ours shows Running without a launch", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch: ours })
        await h.settle()
        eq([h.status(), h.spawns().length], ["up", 0], what)
    })

    await run("boot: the registered handler ids are unchanged", async (what) => {
        const ids = Object.keys(bootPlugin().handlers)
        eq([ids.filter((id) => /^seh-copy-\d+$/.test(id)).length, ids.filter((id) => !/^seh-copy-\d+$/.test(id)).sort()], [30, [
            "fs-autostart-toggle", "fs-autoupdate-toggle", "fs-chromium-toggle", "fs-consent-toggle", "fs-copy-cache-path", "fs-copy-deps", "fs-copy-diag",
            "fs-customtls-toggle", "fs-dns-custom-save", "fs-doctor", "fs-enable-chromium", "fs-engine-set-chrome", "fs-engine-set-webview2",
            "fs-help-customtls", "fs-help-engine", "fs-help-pacing", "fs-help-verbose", "fs-help-wv2refresh", "fs-help-wv2utls", "fs-help-wv2warm",
            "fs-install-deps", "fs-logs-clear", "fs-logs-copy", "fs-mode-binary", "fs-mode-remote", "fs-pacing-toggle", "fs-remove-chromium",
            "fs-remove-solver", "fs-restart", "fs-restart-update", "fs-save", "fs-simple-start", "fs-start", "fs-stealth", "fs-stop", "fs-test",
            "fs-update-chromium", "fs-verbose-toggle", "fs-wv2refresh-toggle", "fs-wv2utls-toggle", "fs-wv2warm-toggle",
            "seh-clear", "seh-copy-all", "seh-notify-toggle", "seh-save", "ui-mode-toggle", "view-cf", "view-errors", "view-settings",
        ]], what)
    })

    pending("remote: Start with the remote host down ends Off, not Starting", async (what) => {
        const h = bootPlugin({ storage: { "fs.mode": "remote", "fs.host": "10.0.0.5" } })
        await h.settle()
        h.fire("fs-simple-start")
        await h.settle()
        for (let i = 0; i < 3; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        eq(h.status(), "down", what)
    })

    pending("exit: a stale bind line in solver.log does not mask this launch's library error", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x", [LOG]: "listen tcp 127.0.0.1:8191: bind: address already in use\n" } })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        const s = h.spawns()[0]
        s.fail("solver: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory")
        s.exit(127)
        await h.settle()
        eq(/shared libraries/.test(h.reported[h.reported.length - 1]), true, what)
    })

    pending("boot: auto-start with the solver not answering launches it exactly once", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.autoStart": true }, files: { [BIN]: "x" } })
        await h.settle()
        for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        const sweeps = h.cmds.filter((c) => c.args.includes("[a]quatils/.*/solver/solver")).length
        eq([h.spawns().length, sweeps], [1, 1], what)
    })

    pending("launch: a stored headless flag gives no SOLVER_HEADLESS and is removed at load", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.browserMode": "headless" }, files: { [BIN]: "x" } })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        eq([h.spawns()[0].cmd.env.includes("SOLVER_HEADLESS=1"), h.storage.has("fs.browserMode")], [false, false], what)
    })
}

console.log("configuration")
{
    const prefs = (map) => ({ $getUserPreference: (n) => map[n] })
    const DEFAULTS = {
        anikoto: "https://anikototv.to",
        animepahe: "https://animepahe.pw",
        anizone: "https://anizone.to",
        animelok: "https://animelok.live",
    }
    for (const name in DEFAULTS) {
        eq(load(name).baseUrl, DEFAULTS[name], `config: ${name} falls back to the manifest default when nothing is set`)
        eq(load(name, prefs({ baseUrl: "{{baseUrl}}" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an unsubstituted placeholder`)
        eq(load(name, prefs({ baseUrl: "" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an empty setting`)
    }
    eq(load("anikoto", prefs({ baseUrl: "https://mirror.example" })).baseUrl, "https://mirror.example", "config: a configured mirror is used")
    eq(load("animelok", prefs({ baseUrl: "https://animelok.online" })).base, "https://animelok.live", "config: a legacy animelok domain is remapped once at construction")

    const solverOn = load("anikoto", prefs({ useCustomSolver: "on", solverUrl: "http://127.0.0.1:9999/v1" }))
    eq(solverOn.solverEndpoint(), "http://127.0.0.1:9999/v1", "config: the solver endpoint follows the setting")
    eq(solverOn.solverEnabled(), true, "config: the solver is enabled when turned on and pointed somewhere")
    eq(load("anikoto").solverEnabled(), false, "config: the solver stays off by default")
    eq(load("anikoto", prefs({ useCustomSolver: "on", solverUrl: "" })).solverEndpoint(), "http://127.0.0.1:8191/v1", "config: clearing the solver URL falls back to the default, the on/off switch is what disables it")
    eq(load("anikoto", prefs({ useCustomSolver: "on", solverUrl: "localhost:8191" })).solverEnabled(), false, "config: a solver URL with no scheme disables the solver")
    eq(load("animepahe", prefs({ solverUrl: "localhost:8191" })).solverEndpoint(), "", "config: animepahe rejects a schemeless solver URL too")
    eq(load("anikoto", prefs({ solverUrl: "http://box:8191" })).solverEndpoint(), "http://box:8191/v1", "config: the /v1 suffix is added when missing")
    eq(load("anikoto", prefs({ solverUrl: "http://box:8191/v1/" })).solverEndpoint(), "http://box:8191/v1", "config: a trailing slash does not double the suffix")
    eq(load("anikoto", prefs({ loadSubtitles: "disabled" })).loadSubtitles, "disabled", "config: subtitles can be turned off")
}

console.log("versions")
{
    const v = await import("./bump.mjs")

    eq(v.next("1.3.98"), "1.3.99", "version: an ordinary patch bump")
    eq(v.next("1.3.99"), "1.4.0", "version: a patch past 99 rolls into the minor")
    eq(v.next("1.9.99"), "2.0.0", "version: a minor past 9 rolls into the major")
    eq(v.normalise("1.3.103"), "1.4.0", "version: an overflowed patch normalises into the minor")
    eq(v.normalise("0.10.28"), "1.0.28", "version: an overflowed minor normalises into the major and keeps the patch")
    eq(v.isValid("1.4.0"), true, "version: three fields inside the caps are valid")
    eq(v.isValid("1.3.103"), false, "version: a three-digit patch is not")
    eq(v.isValid("0.10.28"), false, "version: a two-digit minor is not")
    eq(v.isValid("1.4"), false, "version: two fields are not a version")
    eq(v.manifests().filter((f) => !v.isValid(JSON.parse(fs.readFileSync(f, "utf8")).version)), [], "version: every shipped manifest is inside 9.9.99")
}

console.log("payload bytes")
{
    const payloads = fs.readdirSync(`${ROOT}/extensions`).map((d) => `extensions/${d}/provider.ts`)
        .concat(fs.readdirSync(`${ROOT}/plugins`).map((d) => `plugins/${d}/plugin.ts`))
    const bad = []
    for (const rel of payloads) {
        const buf = fs.readFileSync(`${ROOT}/${rel}`)
        for (let i = 0; i < buf.length; i++) {
            const b = buf[i]
            if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
                bad.push(`${rel}@${i}=0x${b.toString(16)}`)
                break
            }
        }
    }
    eq(bad, [], "bytes: no payload carries a stray control character")
}

console.log()
if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed`)
    process.exit(1)
}
console.log(`${checks} checks passed` + (skipped ? `, ${skipped} pending` : ""))
