import fs from "fs"
import { execFileSync } from "child_process"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

let failures = 0
let checks = 0

const run = (what, fn) => fn(what)

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

console.log("haifacdn")
{
    const lib = [
        { id: 6, title: "That Time I Got Reincarnated as a Slime", anilist_id: 101280, audio: ["Japanese", "Spanish", "English"], description: "Lonely thirty-seven-year-old...", genres: ["Action"] },
        { id: 7, title: "That Time I Got Reincarnated as a Slime Season 2", anilist_id: 108511, audio: ["Japanese", "Russian", "English"] },
        { id: 8, title: "Frieren: Beyond Journey’s End", anilist_id: 154587, audio: ["Japanese"] },
        { id: 3, title: "Skeleton Knight OVA", anilist_id: null, audio: ["Japanese"] },
        { id: 9, title: "Skeleton Knight OVA 2nd Season", anilist_id: null, audio: ["Japanese", "English"] },
    ]
    const ep = (id, n, title = "E" + n) => ({ id, episode: n, title, stream: `https://cdn.lua.locker/hls/${id}/master.m3u8` })
    const routes = {
        "/series/7": { id: 7, seasons_detail: [{ season: 2, episodes: [ep("b2", 2, "Slime S02E02"), ep("b1", 1, "That Time I Got Reincarnated as a Slime S02E01")] }] },
        "/series/9": { id: 9, seasons_detail: [{ season: 0, episodes: [ep("sp", 4)] }, { season: 2, episodes: [ep("y1", 1)] }, { season: 1, episodes: [ep("x2", 2), ep("x1", 1), ep("x3", 3)] }] },
        "/series/6": { id: 6, seasons_detail: [{ season: 1, episodes: [ep("a1", 1)] }] },
        "/series/3": { id: 3, seasons_detail: [{ season: 0, episodes: [ep("o2", 2), ep("o1", 1)] }] },
        "/series/2": { id: 2, seasons_detail: [] },
        "/episodes/ja": {
            stream: "https://x/ja.m3u8",
            audio: [{ label: "Japanese", language: "jpn", default: true }],
            subtitles: [
                { label: "Spanish (Latin America)", language: "spa", default: false, url: "https://x/3_spa.vtt" },
                { label: "Spanish", language: "spa", default: false, url: "https://x/4_spa.vtt" },
                { label: "English", language: "eng", default: false, url: "https://x/2_eng.vtt" },
                { label: "", language: "fin", default: false, url: "https://x/5_fin.vtt" },
            ],
        },
        "/episodes/es": { stream: "https://x/es.m3u8", audio: [{ label: "Japanese", language: "jpn" }], subtitles: [{ label: "English", language: "eng", url: "https://x/e.vtt" }, { label: "Spanish", language: "spa", default: true, url: "https://x/s.vtt" }] },
        "/episodes/en": { stream: "https://x/en.m3u8", audio: [{ label: "Japanese", language: "jpn" }, { label: "English", language: "eng" }], subtitles: [] },
    }
    const answers = {
        777777: { ok: true, duplicate: false, request: { title: "That Time I Got Reincarnated as a Slime Season 3", already_in_library: false } },
        666661: { ok: true, duplicate: false, request: { title: "Held One" }, auto_approve: { approved: false, episodes_queued: 0, reason: "52 episodes is over the 30-episode auto-approve limit" } },
        666662: { ok: true, duplicate: true, request: { title: "Approved One" }, auto_approve: { approved: true, episodes_queued: 12, reason: null } },
        666663: { ok: true, duplicate: false, request: { title: "Next One" } },
        666664: { ok: true, duplicate: true, request: { title: "Pending One" }, auto_approve: { approved: true, episodes_queued: 3, reason: null } },
    }
    const seen = []
    const mk = (key, prefs = {}, mine = []) => {
        const store = new Map()
        const notes = []
        const posts = []
        let codes = 0
        let listings = 0
        const prov = load("haifacdn", {
            $getUserPreference: (k) => (k === "apiKey" ? key : prefs[k]),
            $store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), has: (k) => store.has(k) },
            console: { log() {}, info() {}, warn: (m) => notes.push(JSON.parse(String(m).slice(9))), error() {} },
            fetch: (url, opts) => {
                seen.push(opts.headers.Authorization)
                const path = url.replace("https://cdn.lua.locker/v1", "")
                const ok = (body, status = 200) => Promise.resolve({ ok: true, status, headers: {}, json: () => body })
                if (opts.method === "POST") {
                    const body = JSON.parse(opts.body)
                    posts.push([path, body, opts.headers["Content-Type"]])
                    if (path === "/autogen") return ok({ ok: true, code: "aa_" + ++codes, max_episodes: 30, single_use: true }, 200)
                    return ok(answers[body.anilist_id] || { ok: true, request: {} }, 201)
                }
                if (path.startsWith("/requests?")) return ok({ requests: mine })
                if (path.startsWith("/series?") && path.includes("&offset=")) {
                    listings++
                    return ok({ total: lib.length, limit: 100, offset: 0, series: lib })
                }
                if (path.startsWith("/series?")) {
                    const q = decodeURIComponent((path.match(/[?&]q=([^&]*)/) || [])[1] || "").toLowerCase()
                    return ok({ series: lib.filter((s) => s.title.toLowerCase().indexOf(q) !== -1) })
                }
                const body = routes[path.split("?")[0]]
                return body ? ok(body) : Promise.resolve({ ok: false, status: 404, headers: {}, json: () => ({ error: "not_found" }) })
            },
        })
        prov.notes = notes
        prov.posts = posts
        prov.store = store
        prov.listings = () => listings
        return prov
    }
    const p = mk(" ak_test ")
    const media = (id, english = "", romaji = "", synonyms = []) => ({ id, englishTitle: english, romajiTitle: romaji, synonyms, isAdult: false })
    const ids = async (prov, m, dub, query = "") => (await prov.search({ media: m, query, dub })).map((r) => r.id + ":" + r.subOrDub)
    eq([
        await ids(p, media(108511, "That Time I Got Reincarnated as a Slime Season 2", "Tensei shitara Slime Datta Ken 2nd Season"), false, "slime"),
        await ids(p, media(101280, "That Time I Got Reincarnated as a Slime"), true, "slime"),
        await ids(p, media(154587, "Frieren: Beyond Journey's End"), true, "frieren"),
        await ids(p, media(200002, "Skeleton Knight OVA Season 2", "Gaikotsu Kishi OVA II"), true, "skeleton"),
        await ids(p, media(200001, "Skeleton Knight OVA"), false, "skeleton"),
        await ids(p, media(5555, "Something Else"), false, "skeleton"),
        await ids(p, media(0), false, "skeleton"),
    ], [["7$sub:both"], ["6$dub:both"], [], ["9$dub:both"], ["3$sub:sub"], ["3$sub:sub"], ["3$sub:sub", "9$sub:both"]],
        "search: each season is its own entry picked by its AniList id, dub needs English audio, unmapped entries match on title and season, an unrelated query only offers unmapped entries of the same season, and a manual query lists every hit")
    const quiet = mk("ak_test", { requestMissing: "off" })
    const stale = mk("ak_test", { requestMissing: "off" })
    stale.store.set("haifacdn:library", { at: Date.now(), data: [] })
    eq([
        await ids(quiet, media(5555, "Something Else"), false, "slime"),
        await ids(quiet, media(0), false, "slime"),
        await ids(quiet, media(300001, "Frieren: Beyond Journey's End"), false, ""),
        await ids(stale, media(108511, "That Time I Got Reincarnated as a Slime Season 2"), false, "slime"),
    ], [[], ["6$sub:both", "7$sub:both"], [], ["7$sub:both"]],
        "search: entries mapped to another AniList id never match by query or title, a manual query keeps them, and a live query still finds this media's own id when the cached library predates it")
    eq(Object.keys(p.store.get("haifacdn:library").data[0]), ["id", "title", "anilist_id", "audio"], "library: the cached listing keeps only the fields search reads")
    eq([
        (await p.findEpisodes("7$dub")).map((e) => [e.number, e.id, e.title || null]),
        (await p.findEpisodes("9$sub")).map((e) => e.id),
        (await p.findEpisodes("3$sub")).map((e) => e.number),
        (await p.findEpisodes("7$s2$sub")).map((e) => e.id),
        (await p.findEpisodes("7$s1$sub")).map((e) => e.id),
        (await p.findEpisodes("9$s2$sub")).map((e) => e.id),
        await p.findEpisodes("6$s2$sub").then(() => "loaded", (e) => String(e)),
        await p.findEpisodes("2$sub"),
    ], [[[1, "b1$dub", null], [2, "b2$dub", null]], ["x1$sub", "x2$sub", "x3$sub"], [1, 2], ["b1$sub", "b2$sub"], ["b1$sub", "b2$sub"], ["y1$sub"],
        "Haifa CDN: this match was saved by an older version of the extension - match the series again", []],
        "episodes: a sequel lists its episodes whatever season number its files carry, file-name titles are dropped, specials stay out unless they are all there is, a clashing season keeps the bigger group, an old season tag picks its group, an old tag the entry can't serve asks for a new match, and an entry with no files yet lists nothing")
    const srv = await p.findEpisodeServer({ id: "ja$sub", number: 1, url: "" }, "Haifa CDN")
    eq([srv.videoSources[0].url, srv.videoSources[0].type, srv.videoSources[0].subtitles.map((s) => s.language + (s.isDefault ? "*" : "")), Object.keys(srv.headers).length],
        ["https://x/ja.m3u8", "m3u8", ["English*", "Spanish (Latin America)", "Spanish", "fin"], 0],
        "server: the master playlist plays as is with no headers; tracks are named by their label, a missing label falls back to the code, and English leads as the default when none is marked")
    eq((await p.findEpisodeServer({ id: "es$sub", number: 1, url: "" }, "Haifa CDN")).videoSources[0].subtitles.map((s) => s.language + (s.isDefault ? "*" : "")), ["Spanish*", "English"], "server: a track the API marks default stays the default")
    let noDub = ""
    try { await p.findEpisodeServer({ id: "ja$dub", number: 1, url: "" }, "Haifa CDN") } catch (e) { noDub = String(e) }
    eq([noDub, (await p.findEpisodeServer({ id: "en$dub", number: 1, url: "" }, "Haifa CDN")).videoSources[0].url], ["Haifa CDN: this episode has no English audio", "https://x/en.m3u8"], "server: dub needs an English audio track")

    await ids(p, media(777777, "That Time I Got Reincarnated as a Slime Season 3"), false, "slime")
    await ids(p, media(777777, "That Time I Got Reincarnated as a Slime Season 3"), true, "slime")
    const off = mk("ak_test", { requestMissing: "off" })
    await off.search({ media: media(888888, "Nothing Here"), query: "", dub: false })
    const asked = mk("ak_test", {}, [{ anilist_id: 999999 }])
    await asked.search({ media: media(999999, "Already Asked"), query: "", dub: false })
    eq([p.posts, p.notes.map((n) => n.lvl + " " + n.msg), off.posts.length + asked.posts.length],
        [[["/request", { anilist_id: 777777, note: "Requested from Seanime" }, "application/json"]], ["info Haifa CDN: That Time I Got Reincarnated as a Slime Season 3 isn't in the library yet - requested it"], 0],
        "request: a season the library lacks is requested once per stored flag as JSON with an info notice; a switched-off setting and a show this key already asked for send nothing")

    const auto = mk("ak_test", { autoApprove: "on" })
    for (const id of [666661, 666662, 666663]) await auto.search({ media: media(id, "X" + id), query: "", dub: false })
    eq([auto.posts.map((x) => x[0] + " " + (x[1].note || "")), auto.notes.map((n) => n.msg)], [
        ["/autogen ", "/request aa_1 Requested from Seanime", "/autogen ", "/request aa_2 Requested from Seanime", "/autogen ", "/request aa_3 Requested from Seanime"],
        [
            "Haifa CDN: Held One isn't in the library yet - requested it (held for review: 52 episodes is over the 30-episode auto-approve limit)",
            "Haifa CDN: Approved One isn't in the library yet - requested it and it was approved; 12 episodes are downloading",
            "Haifa CDN: Next One isn't in the library yet - requested it",
        ],
    ], "request: auto-approve mints a fresh code for each request and puts it in the note")
    eq(auto.listings(), 2, "request: an approval drops the cached library so the next search sees the new entry")
    const pending = mk("ak_test", { autoApprove: "on" }, [{ anilist_id: 666664, status: "pending" }, { anilist_id: 666665, status: "approved" }])
    for (const id of [666664, 666665]) await pending.search({ media: media(id, "X" + id), query: "", dub: false })
    eq(pending.posts.map((x) => x[0] + " " + (x[1].anilist_id || "")), ["/autogen ", "/request 666664"], "request: with auto-approve on, this key's own pending request is sent again with a code; one already past review is left alone")

    let noKey = ""
    try { await mk("").findEpisodes("7$sub") } catch (e) { noKey = String(e) }
    eq([noKey, seen.every((h) => h === "Bearer ak_test")], ["Haifa CDN: add your API key in the extension settings", true], "auth: the key is sent trimmed as a bearer token, and a missing key says where to set it")
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

    const paheData = [
        { id: 4000, session: "s-wrong", title: "Frieren: Beyond Journey's End" },
        { id: 77, session: "s-other", title: "Totally Unrelated Show" },
        { id: 5319, session: "s-right", title: "Sousou no Frieren" },
    ]
    const meta = (al, mal) => `<html><head><title>x :: animepahe</title>${al ? `<meta name="anilist" content="${al}">` : ""}${mal ? `<meta name="myanimelist" content="${mal}">` : ""}</head></html>`
    const reply = (body, status = 200, html = false) => Promise.resolve({ ok: status < 400, status, url: "", cookies: {}, headers: {}, contentType: html ? "text/html" : "application/json", text: () => (html ? body : JSON.stringify(body)), json: () => body })
    const mkPahe = (pages) => {
        const store = new Map()
        const hits = []
        const prov = load("animepahe", {
            $store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), has: (k) => store.has(k) },
            fetch: (url) => {
                if (url.indexOf("/api?m=search&q=") !== -1) return reply({ total: paheData.length, data: paheData })
                const page = /\/anime\/([\w-]+)$/.exec(url)
                if (page) {
                    hits.push(page[1])
                    return pages[page[1]] === undefined ? reply("Just a moment...", 403, true) : reply(pages[page[1]], 200, true)
                }
                return reply({})
            },
        })
        prov.hits = hits
        return prov
    }
    const frieren = (id, idMal, dub = false) => ({ query: "", dub, media: { id, idMal, romajiTitle: "Sousou no Frieren", englishTitle: "Frieren: Beyond Journey's End" } })
    const found = async (prov, o) => (await prov.search(o)).map((r) => r.id)
    const fallback = ["s-wrong$sub", "s-right$sub"]
    const tagged = mkPahe({ "s-wrong": meta(999, 888), "s-right": meta(154587, 52991), "s-other": meta() })
    eq([
        await found(tagged, frieren(154587, 52991)),
        await found(tagged, frieren(154587, 52991, true)),
        tagged.hits,
    ], [["s-right$sub"], ["s-right$dub"], ["s-wrong", "s-right"]],
        "ids: the series page's AniList id picks the exact entry over a closer-titled wrong one, and each page's ids are kept")
    const malOnly = mkPahe({ "s-wrong": meta(), "s-right": meta(0, 52991) })
    eq(await found(malOnly, frieren(0, 52991)), ["s-right$sub"], "ids: a page with only a MAL id still matches by MAL id")
    const strangers = mkPahe({ "s-wrong": meta(1), "s-right": meta(2), "s-other": meta(3) })
    const bare = mkPahe({})
    const blocked = mkPahe({})
    eq([
        await found(strangers, frieren(154587, 52991)),
        await found(bare, frieren(0, undefined)),
        await found(blocked, frieren(154587, 52991)),
        [strangers, bare, blocked].map((p) => new Set(p.hits).size),
    ], [fallback, fallback, fallback, [3, 0, 1]],
        "ids: no page with our ids, no ids to look for, or a page that will not load all keep the title pick, and a failed page stops the checks")
}

console.log("animelok")
{
    const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, url: "", cookies: {}, headers: {}, text: () => JSON.stringify(body), json: () => body })
    const servers = (al, ep, salt, h = ep) => ({ success: true, anilistId: al, epNum: ep, servers: [
        { source: "reanime", server: "HD-1", type: "sub", url: "https://flixcloud.cc/video/f1" },
        ...(salt ? [{ source: "animesalt", server: "Multi-1", type: "dub", languages: ["hindi"], url: `https://ravok.buzz/video/h${h}` }, { source: "animesalt", server: "Multi-2", type: "dub", url: "https://anime.streamindia.co.in/abyss?u=1" }] : []),
        { source: "megaplay", server: "MegaPlay", type: "sub", url: `https://megaplay.buzz/stream/ani/${al}/${ep}/sub` },
    ] })
    const mkLok = (o = {}) => {
        const store = new Map()
        const hits = []
        const logs = []
        const prov = load("animelok", {
            console: { log() {}, info() {}, warn: (s) => logs.push("warn " + s), error: (s) => logs.push("error " + s) },
            $store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), has: (k) => store.has(k) },
            fetch: (url, init) => {
                hits.push(url.replace(/^https:\/\/[^/]+/, ""))
                const api = /\/api\/anilist\/(\d+)\/(\d+)$/.exec(url)
                if (api) {
                    if (o.down) return Promise.reject(new Error(`Get "${url}": dial tcp: lookup animelok.cc: no such host`))
                    if (o.status) return reply({}, o.status)
                    if (o.shape) return reply({ success: true })
                    if (o.bad && o.bad.includes(+api[2])) return reply({}, 502)
                    return reply(servers(+api[1], +api[2], +api[2] <= (o.eps ?? 13), o.movie ? 1 : +api[2]))
                }
                if (/\/player\/index\.php\?data=h\d+&do=getVideo$/.test(url) && init && init.method === "POST") return reply(o.noLink ? { hls: true } : { hls: true, securedLink: "https://ravok.buzz/cdn/hls/x/master.m3u8?md5=a&expires=1" })
                return reply({}, 404)
            },
        })
        prov.hits = hits
        prov.logs = logs
        prov.store = store
        return prov
    }
    const solo = (dub, query = "") => ({ query, dub, media: { id: 151807, englishTitle: "Solo Leveling", episodeCount: 12 } })
    const err = (p) => p.then(() => "no error", (e) => String(e))
    const subOnly = mkLok()
    eq([await subOnly.search(solo(false)), subOnly.hits.length], [[], 0], "lok: a sub search finds nothing without asking the site, since only the multi-language dub plays")
    const lok = mkLok()
    eq((await lok.search(solo(true))).map((r) => [r.id, r.subOrDub]), [["151807$dub$12", "dub"]], "lok: an episode 1 with a ravok source is a dub result keyed by AniList id")
    eq((await lok.findEpisodes("151807$dub$12")).map((e) => e.number).slice(-2), [11, 12], "lok: the site's answers past the AniList count (a sequel's episodes) are not listed")
    eq([...lok.store.keys()].filter((k) => k.indexOf("epcount") !== -1), ["animelok:epcount:151807:12"], "lok: the episode count is cached per AniList count")
    eq([(await mkLok({ eps: 8 }).findEpisodes("151807$dub$12")).length, (await mkLok().findEpisodes("151807$dub$0")).length], [8, 13], "lok: a dub behind the AniList count, or a show with no count, is counted by probing the site")
    const movie = mkLok({ movie: true, eps: 5000 })
    eq([(await movie.findEpisodes("21519$dub$1")).length, (await movie.findEpisodes("21519$dub$0")).length], [1, 1], "lok: a movie the site answers for at every episode number lists once")
    eq(await mkLok({ eps: 0 }).search(solo(true)), [], "lok: a show whose episode 1 has only flixcloud and MegaPlay is not a match")
    const srv = await lok.findEpisodeServer({ id: "151807$dub$5", number: 5, url: "" }, "Auto")
    eq([srv.videoSources[0].url, srv.headers.Referer, lok.hits.filter((h) => h.indexOf("getVideo") !== -1)], ["https://ravok.buzz/cdn/hls/x/master.m3u8?md5=a&expires=1", "https://ravok.buzz/", ["/player/index.php?data=h5&do=getVideo"]], "lok: the server asks the ravok player for its secured link and plays it with the player's referer")
    const hitsBefore = lok.hits.length
    await lok.findEpisodeServer({ id: "151807$dub$5", number: 5, url: "" }, "Auto")
    eq(lok.hits.length, hitsBefore, "lok: a second play of the same episode is served from the cache")
    eq(await err(lok.findEpisodeServer({ id: "151807$dub$20", number: 20, url: "" }, "Auto")), "animelok: episode 20 has no multi-language dub on this site", "lok: an episode with only flixcloud and MegaPlay is reported as missing")
    eq(lok.logs.slice(-1).map((l) => /^warn SEHERRv1 .*"lvl":"info"/.test(l)), [true], "lok: a missing episode is reported as a notice, not an error")
    const sick = mkLok({ status: 503 })
    await err(sick.findEpisodeServer({ id: "151807$dub$1", number: 1, url: "" }, "Auto"))
    eq(sick.logs.map((l) => /^error SEHERRv1 /.test(l) && l.indexOf("lvl") === -1), [true], "lok: a failed lookup is reported as an error")
    eq([
        await err(mkLok({ status: 503 }).search(solo(true))),
        await err(mkLok({ shape: true }).search(solo(true))),
        await err(mkLok({ status: 404 }).search(solo(true))),
        await err(mkLok({ noLink: true }).findEpisodeServer({ id: "151807$dub$1", number: 1, url: "" }, "Auto")),
    ], [
        "animelok: search failed - the site answered HTTP 503",
        "animelok: https://animelok.cc answered for AniList id 151807 in a shape this extension does not understand — the site changed its API; this extension needs an update.",
        "animelok: https://animelok.cc answered for AniList id 151807 in a shape this extension does not understand — the site changed its API; this extension needs an update.",
        "animelok: the ravok.buzz player answered without a stream link - this extension needs an update",
    ], "lok: an HTTP error, a changed API, a removed endpoint and a player with no link each say what failed")
    const o = { status: 503 }
    const healing = mkLok(o)
    const r1 = await err(healing.search(solo(true)))
    o.status = 0
    eq([r1, (await healing.search(solo(true))).length], ["animelok: search failed - the site answered HTTP 503", 1], "lok: a failed lookup is not cached, so the next search tries again")
    const f = { bad: [8] }
    const flaky = mkLok(f)
    const c1 = await err(flaky.findEpisodes("151807$dub$0"))
    f.bad = []
    eq([c1, (await flaky.findEpisodes("151807$dub$0")).length], ["animelok: counting episodes failed - the site answered HTTP 502", 13], "lok: a probe that fails twice stops the count with an error instead of a short list, and nothing short is cached")
    const down = mkLok({ down: true })
    eq([await err(down.search(solo(true))), down.hits.length], ["animelok: search failed - the site could not be found (DNS)", 2], "lok: a lookup failure is retried once and named")
}

console.log("hanime")
{
    const crypto = await import("node:crypto")
    const KEY = crypto.createHash("sha256").update("htv-insecure-handshake-v1").digest()
    const AAD = Buffer.from("htv-insecure-v1")
    const sealN = (obj) => {
        const iv = crypto.randomBytes(12)
        const c = crypto.createCipheriv("aes-256-gcm", KEY, iv)
        c.setAAD(AAD)
        const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
        return Buffer.from(JSON.stringify({ v: 1, alg: "AES-256-GCM", iv: iv.toString("base64url"), tag: c.getAuthTag().toString("base64url"), data: data.toString("base64url") })).toString("base64url")
    }
    const openN = (tok) => {
        const e = JSON.parse(Buffer.from(tok, "base64url").toString())
        const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(e.iv, "base64url"))
        d.setAAD(AAD)
        d.setAuthTag(Buffer.from(e.tag, "base64url"))
        return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, "base64url")), d.final()]).toString())
    }
    const sig = (t) => crypto.createHash("sha256").update(`${t},Xkdi29,https://hanime.tv,mn2,${t}`).digest("hex")
    const unix = (s) => Math.floor(Date.parse(s.length === 10 ? s + "T00:00:00Z" : s) / 1000)
    const row = (name, slug, rel, o = {}) => ({ id: 1, name, slug, search_titles: `${name} ${o.alt || ""}`.trim(), description: "", released_at_unix: unix(rel), created_at_unix: o.up || unix(rel), tags: o.tags || ["censored"] })
    const kur = "Kuroinu: Kedakaki Seijo wa Hakudaku ni Somaru"
    const nsn = "Yakin Byoutou Night Shift Nurses"
    const rows = [
        row("Kuroinu 1", "kuroinu-1", "2012-01-27", { alt: kur }),
        row("Kuroinu 2", "kuroinu-2", "2012-06-29", { alt: kur }),
        row("Kuroinu 3", "kuroinu-3", "2013-11-29", { alt: kur }),
        row("Kuroinu 2 Episode 1", "kuroinu-2-episode-1", "2021-08-26", { alt: "Kuroinu II" }),
        row("Enjo Kouhai 1", "enjo-kouhai-1", "2020-01-30T15:41:00Z", { alt: "** Kouhai ○○交配 Enjo Kouhai 援助交配" }),
        row("Enjo Kouhai 2", "enjo-kouhai-2", "2020-02-28", { alt: "** Kouhai ○○交配 Enjo Kouhai 援助交配" }),
        row("Kouhai 1", "kouhai-1", "2015-05-05"),
        row("Netorareta Bakunyuu Tsuma-tachi 1", "netorareta-bakunyuu-tsuma-tachi-1", "2025-09-11T15:00:00Z"),
        row("Netorareta Bakunyuu Tsuma-tachi 2", "netorareta-bakunyuu-tsuma-tachi-2", "2025-10-09T15:00:00Z"),
        row("Netorareta Bakunyuu Tsuma-tachi Season 2 Ep 1", "netorareta-bakunyuu-tsuma-tachi-season-2-ep-1", "2026-09-17T15:00:00Z"),
        row("Futabu! 1", "futabu-1", "2014-02-20T15:00:00Z"),
        row("Futabu! 2", "futabu-2", "2014-05-01"),
        row("Futabu!! 1", "futabu-1-6439", "2015-02-19"),
        row("Futabu!! 2", "futabu-2-c0f1", "2015-04-30"),
        row("Stringendo: Angel-tachi no Private Lesson 1", "stringendo-angel-tachi-no-private-lesson-1", "2006-01-27", { alt: "Stringendo Stringendo: Angel-tachi no Private Lesson" }),
        row("Stringendo: Angel-tachi no Private Lesson 2", "stringendo-angel-tachi-no-private-lesson-2", "2006-04-28", { alt: "Stringendo Stringendo: Angel-tachi no Private Lesson" }),
        row("Stringendo &amp; Accelerando Ultimatum Sera 1", "stringendo-accelerando-ultimatum-sera-1", "2008-05-09", { alt: "Stringendo &amp; Accelerando Ultimatum: Sera" }),
        row("Night Shift Nurses - Karte 1", "night-shift-nurses-karte-1", "2000-12-08", { alt: nsn }),
        row("Night Shift Nurses - Karte 2", "night-shift-nurses-karte-2", "2001-03-23", { alt: nsn }),
        row("Night Shift Nurses - Karte 5", "night-shift-nurses-karte-5", "2002-01-25", { alt: nsn }),
        row("Night Shift Nurses - Karte 5.5", "night-shift-nurses-karte-5-5", "2003-03-28", { alt: nsn }),
        row("Night Shift Nurses - Karte 10", "night-shift-nurses-karte-10", "2004-01-30", { alt: nsn }),
        row("Night Shift Nurses - Kranke 1", "night-shift-nurses-kranke-1", "2005-05-27", { alt: "Yakin Byoutou Kranke Night Shift Nurses" }),
        row("Night Shift Nurses 2 Ep 1", "night-shift-nurses-2-ep-1", "2010-06-25", { alt: "Yakin Byoutou 2 Night Shift Nurses 2" }),
        row("Night Shift Nurses - Ren Nanase", "night-shift-nurses-ren-nanase", "2005-12-04", { alt: nsn }),
        row("Isekai Meikyuu de Harem wo 1", "isekai-meikyuu-de-harem-wo-1", "2022-07-06", { alt: "Harem in the Labyrinth of Another World" }),
        row("Isekai Meikyuu de Harem wo 2", "isekai-meikyuu-de-harem-wo-2", "2022-07-13", { alt: "Harem in the Labyrinth of Another World" }),
        row("Boku no Yayoi-san 1 &amp; 2", "boku-no-yayoi-san", "2015-02-27"),
        row("Boku no Yayoi-san 3 & 4", "boku-no-yayoi-san-3-4", "2016-07-28"),
        row("Boku no Yayoi-san 4", "boku-no-yayoi-san-4", "2016-07-28"),
        row("Super Naughty Maid!", "super-naughty-maid", "2011-02-25"),
        row("Super Naughty Maid! 2", "super-naughty-maid-2", "2011-06-24"),
        row("Toilet no Hanako-san 1", "toilet-no-hanako-san-1", "2010-01-01"),
        row("Toilet no Hanako-san 3", "toilet-no-hanako-san-3", "2010-05-01"),
        row("Toilet no Hanako-san 4", "toilet-no-hanako-san-4", "2010-07-01"),
        row("Overflow Season 1", "overflow-season-1", "2020-02-23"),
        row("Rance: The Quest for Hikari 1", "rance-the-quest-for-hikari-1", "2014-12-26", { alt: "Rance 01: Hikari o Motomete The Animation" }),
        row("Rance: The Quest for Hikari 2", "rance-the-quest-for-hikari-2", "2015-06-26", { alt: "Rance 01: Hikari o Motomete The Animation" }),
        row("Rance: The Quest for Hikari 3", "rance-the-quest-for-hikari-3", "2016-01-29", { alt: "Rance 01: Hikari o Motomete The Animation" }),
        row("Rance: The Quest for Hikari 3 Extra", "rance-the-quest-for-hikari-3-extra", "2016-01-29", { alt: "Rance 01: Hikari o Motomete The Animation" }),
        row("Rance: The Quest for Hikari 4", "rance-the-quest-for-hikari-4", "2016-06-23", { alt: "Rance 01: Hikari o Motomete The Animation" }),
        row("Joshi Luck! 1", "joshi-luck-1", "2019-09-06", { up: 100 }),
        row("Joshi Luck! 1", "joshi-luck-1-uncensored-re-release", "2019-09-06", { up: 50, tags: ["uncensored"] }),
        row("Joshi Luck! 2", "joshi-luck-2", "2019-11-01", { up: 100 }),
        row("Joshi Luck! 2", "joshi-luck-2-c0f1", "2019-11-01", { up: 200 }),
        row("Pure x Holic: Junketsu Otome to Kon&#39;in Kankei!? 1", "pure-x-holic-1", "2026-08-27T15:00:00Z"),
        row("Hoshizora Lesson 1", "hoshizora-lesson-1", "2014-08-29", { alt: "Hoshizora Lesson" }),
        row("Hoshizora Lesson 2", "hoshizora-lesson-2", "2017-11-23", { alt: "Hoshizora Lesson 2nd Stage" }),
        row("Ano Natsu no Hi 1", "ano-natsu-no-hi-1", "2026-05-15T15:00:00Z"),
        row("Ano Natsu no Hi 2", "ano-natsu-no-hi-2", "2026-04-29T15:00:00Z"),
        row("Kare no Shiranai Himitsu o Irete The Animation 1", "kare-no-shiranai-himitsu-o-irete-the-animation-1", "2026-06-25T15:00:00Z"),
        row("Shuudengo, Capsule Hotel de, Joushi ni Binetsu Tsutawaru Yoru.", "shuudengo-capsule-hotel-de-joushi-ni-binetsu-tsutawaru-yoru", "2018-10-08", { alt: "A Hot Night With My Boss in a Capsule Hotel" }),
        row("A Kite", "a-kite", "1998-02-25"),
        row("Swing Out Sisters", "swing-out-sisters", "2011-11-25"),
        row("Hi.Me.Go.To 1", "hi-me-go-to-1", "2001-12-29", { alt: "Hi Me Go To" }),
        row("Princess Lover! OVA 1", "princess-lover-ova-1", "2010-09-17", { alt: "Princess Lover! (2010)" }),
        row("Princess Lover! OVA 2", "princess-lover-ova-2", "2010-10-22", { alt: "Princess Lover! (2010)" }),
        row("Bible Black Only 1", "bible-black-only-1", "2005-07-25", { alt: "Bible Black Only Version" }),
        row("Bible Black Only 2", "bible-black-only-2", "2006-04-25", { alt: "Bible Black Only Version" }),
        row("Bubble de House de XXX 1", "bubble-de-house-de-xxx-1", "2024-08-30", { alt: "Bubble de House de *** The Animation" }),
        row("Shiiku x Kanojo 1", "shiiku-x-kanojo-1", "2016-08-26"),
        row("Shiiku x Kanojo 2", "shiiku-x-kanojo-2", "2016-09-29"),
        row("Shiiku x Kanojo 2 Bonus Episode", "shiiku-x-kanojo-2-bonus-episode", "2016-09-29"),
        row("Can Can Bunny Extra 1", "can-can-bunny-extra-1", "1996-01-19"),
        row("Can Can Bunny Extra 2", "can-can-bunny-extra-2", "1996-03-15"),
        row("Tonari no Ie no Hanashi 1", "tonari-no-ie-no-hanashi-1", "2024-10-04"),
        row("Harem Shima e Youkoso! 1", "harem-shima-e-youkoso-1", "2026-07-31"),
        row("Fuzzy Lips 1", "fuzzy-lips-1", "2014-04-25"),
        row("Fuzzy Lips 2", "fuzzy-lips-2", "2014-06-06"),
        row("Grimoire of the Divine Comedy 1", "grimoire-of-the-divine-comedy-1", "2014-11-28"),
        row("Grimoire of the Divine Comedy 2", "grimoire-of-the-divine-comedy-2", "2015-12-24"),
        row("Grimoire of the Divine Comedy Bonus", "grimoire-of-the-divine-comedy-bonus", "2015-12-25"),
        { id: 2, name: null, slug: "broken-row" },
    ]
    const SOURCES = [
        { label: "1080p", kind: "promotion", src: "", height: 1080 },
        { label: "480p", kind: "normal", src: "/hls/15/tok480", height: 480 },
        { label: "720p", kind: "normal", src: "/hls/15/tok720", height: 720 },
        { label: "360p", kind: "normal", src: "/hls/15/tok360", height: 360 },
    ]
    const reply = (status, body, headers = {}) => Promise.resolve({ ok: status >= 200 && status < 300, status, url: "", headers, cookies: {}, text: () => (typeof body === "string" ? body : JSON.stringify(body)), json: () => (typeof body === "string" ? JSON.parse(body) : body) })
    const mkH = (o = {}) => {
        const store = new Map()
        const hits = []
        const logs = []
        const sent = []
        const prov = load("hanime", {
            console: { log() {}, info() {}, warn: (s) => logs.push("warn " + s), error: (s) => logs.push("error " + s) },
            $store: { get: (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : undefined), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), has: (k) => store.has(k) },
            fetch: (url, init = {}) => {
                hits.push([url, init.noCloudflareBypass === true])
                if (url === "https://graphql.anilist.co" && init.method === "POST") {
                    if (o.alDown) return Promise.reject(new Error(`Post "${url}": dial tcp: lookup graphql.anilist.co: no such host`))
                    const id = JSON.parse(init.body).variables.id
                    hits[hits.length - 1].push(id)
                    return reply(200, { data: { Media: { synonyms: SYN.get(id) || [] } } })
                }
                if (url === "https://guest.freeanimehentai.net/api/v11/search_hvs") {
                    if (o.catDown) return Promise.reject(new Error(`Get "${url}": dial tcp: lookup guest.freeanimehentai.net: no such host`))
                    if (o.catStatus) return reply(o.catStatus, {})
                    if (o.catShape) return reply(200, { results: [] })
                    return reply(200, { data: rows, ads: {} })
                }
                if (url === "https://auth.hanime.tv/api/v11/handshake" && init.method === "POST") {
                    if (o.hsDown) return Promise.reject(new Error(`Post "${url}": dial tcp: lookup auth.hanime.tv: no such host`))
                    const h = init.headers || {}
                    const t = Number(h["x-time"])
                    let payload
                    try {
                        payload = openN(JSON.parse(init.body).token)
                    } catch (_e) {
                        return reply(422, { error_id: "HANDSHAKE_ERROR_1", message: "Invalid token." })
                    }
                    sent.push({ h, payload, t })
                    if (h["x-signature-version"] !== "web2" || h["x-signature"] !== sig(t) || (h.Origin !== "https://hanime.tv" && h.Referer !== "https://hanime.tv/") || h["Content-Type"] !== "application/json") return reply(401, { error_id: "UA1" })
                    const slug = payload.slug
                    if (slug === "gone-1") return reply(404, { error_id: "NF1" })
                    if (slug === "ua1-1") return reply(401, { error_id: "UA1" })
                    if (slug === "waf-1") return reply(403, "<!DOCTYPE html><title>Attention Required!</title>")
                    if (slug === "notoken-1") return reply(200, { status: "OK" })
                    const sources = slug === "delisted-1" ? [] : slug === "premium-1" ? SOURCES.slice(0, 1) : SOURCES
                    return reply(200, { status: "OK" }, { "Content-Type": "application/json", "X-Token": sealN({ sources, is_preroll_enabled: true, preroll_urls: [] }) })
                }
                return reply(404, {})
            },
        })
        prov.hits = hits
        prov.logs = logs
        prov.sent = sent
        prov.store = store
        return prov
    }
    const special = [/(^|(.*?)[ _.\-(]+)(SP|OAV|OVA|OAD|ONA) ?(\d{1,2})(-([0-9]{1,3}))? ?(.*)$/i, /[-._( ](OVA|ONA)[-._) ]/i, /[-._ ](S|SP)((0|00))([Ee]\d)/i, /[-._({[ ]?(OVA|ONA|OAV|OAD)[\])}\-._ ]?/]
    const seasonal = (s) => s.indexOf("第") === -1 && !special.some((r) => r.test(s.toLowerCase())) && (s.toLowerCase().indexOf("season") !== -1 || /\d(st|nd|rd|th) [Ss].*/.test(s.toLowerCase()))
    const SYN = new Map()
    const M = (id, romaji, english, synonyms, start, eps, format = "OVA") => {
        const [y, m, d] = (start || "").split("-").map(Number)
        SYN.set(id, synonyms)
        return { id, format, romajiTitle: romaji, englishTitle: english || undefined, synonyms: synonyms.filter(seasonal), episodeCount: eps > 0 ? eps : -1, startDate: start ? { year: y, month: m, day: d } : undefined, isAdult: true }
    }
    const err = (p) => p.then(() => "no error", (e) => String(e))
    const h = mkH()
    const ids = async (media, query = "") => (await h.search({ media, query: query || media.romajiTitle || "", dub: false })).map((r) => r.id)
    eq([
        await ids(M(11827, kur, "Kuroinu ～The proud saint is stained with white filth～", ["Black Dogs: Noble and Holy Women Tainted Milky White"], "2012-01-27", 6)),
        await ids(M(900001, "Kuroinu II", "", [], "2021-08-26", 2)),
        await ids(M(127090, "Isekai Meikyuu de Harem wo", "Harem in the Labyrinth of Another World", [], "2022-07-06", 12)),
        await ids(M(3559, "Stringendo", "Stringendo", ["Stringendo - Angel-tachi no Private Lesson"], "2006-01-27", 12)),
        await ids(M(1387, "Yakin Byoutou", "Night Shift Nurses", ["NSN", "Night Shift Ward"], "2000-12-08", 10)),
        await ids(M(21062, "Futabu!", "", [], "2014-02-21", 2)),
    ], [["kuroinu"], ["kuroinu 2"], ["isekai meikyuu de harem wo"], ["stringendo: angel-tachi no private lesson"], ["night shift nurses - karte"], ["futabu!"]],
        "hanime pick: the series wins over its own sequel, a sequel row, a sibling series sharing the first word, a spin-off listed under the same alt name and a punctuation twin, by title then release date")
    eq([
        await ids(M(21618, "Furueru Kuchibiru: fuzzy lips 0", "Fuzzy Lips 0", [], "2014-06-27", 1)),
        await ids(M(990100, "Fuzzy Lips", "", [], "2014-04-25", 2)),
        await ids(M(98972, "Shinkyoku no Grimoire THE ANIMATION: Unico no Natsuyasumi", "", ["Grimoire of the Divine Comedy"], "2015-12-25", 1, "SPECIAL")),
        await ids(M(990101, "Shinkyoku no Grimoire THE ANIMATION", "", ["Grimoire of the Divine Comedy"], "2014-11-28", 2)),
    ], [[], ["fuzzy lips"], [], ["grimoire of the divine comedy"]],
        "hanime traps: a trailing 0 is its own entry, not season 1, and a one-episode special never takes its parent's multi-episode group through an AniList synonym")
    eq([
        await ids(M(213067, "Netorareta Bakunyuu Tsuma-tachi 2", "", [], "2026-09-18", 2)),
        await ids(M(193348, "Netorareta Bakunyuu Tsuma-tachi", "", [], "2025-09-12", 2)),
        await ids(M(900002, "Joshi Luck! 2", "", [], "2022-01-07", 2)),
    ], [["netorareta bakunyuu tsuma-tachi season 2"], ["netorareta bakunyuu tsuma-tachi"], []],
        "hanime sequel: AniList 'X 2' takes the season 2 rows, never season 1 episode 2, and a sequel the site lacks matches nothing")
    const enjo = M(112936, "○○ Kouhai", "", ["援助交配", "Enjo Kouhai", "Assisted Mating"], "2020-01-31", 0)
    eq([
        enjo.synonyms,
        await ids(enjo),
        await ids(enjo),
        h.hits.filter((x) => x[2] === 112936).length,
        await ids(M(900003, "○○ Kouhai", "", [], "2015-05-05", 1)),
        await mkH({ alDown: true }).search({ media: enjo, query: "", dub: false }),
        await ids(M(211338, "Harem-tou e Youkoso!", "", ["Welcome to Paradise Island!", "Harem Shima e Youkoso!"], "2026-07-31", 1)),
    ], [[], ["enjo kouhai"], ["enjo kouhai"], 1, [], [], ["harem shima e youkoso!"]],
        "hanime synonyms: Seanime passes only season synonyms, so a search with no match (a placeholder romaji, or a romaji the site spells differently) fetches the full synonyms from AniList once (cached) and lets a synonym decide; a placeholder never matches a bare 'Kouhai' entry, and an unreachable AniList just means no match")
    eq([
        await ids(M(104117, "Shuudengo, Capsule Hotel de, Joushi ni Binetsu Utawaru Yoru.", "A Hot Night With My Boss in a Capsule Hotel", [], "2018-10-08", 1, "ONA")),
        await err(h.search({ media: M(104117, "Shuudengo, Capsule Hotel de, Joushi ni Binetsu Utawaru Yoru.", "A Hot Night With My Boss in a Capsule Hotel", [], "2018-10-08", 12, "ONA"), query: "", dub: false })),
        await err(h.search({ media: M(320, "A KITE", "Kite", ["A Kite Special Edition"], "1998-02-25", 2), query: "", dub: false })),
        h.logs.filter((l) => l.indexOf("only as one video, so") !== -1).map((l) => /^warn SEHERRv1 .*"lvl":"info"/.test(l)),
    ], [
        ["shuudengo, capsule hotel de, joushi ni binetsu tsutawaru yoru."],
        "hanime: the site has Shuudengo, Capsule Hotel de, Joushi ni Binetsu Tsutawaru Yoru. only as one video, so its 12 episodes cannot be matched",
        "hanime: the site has A Kite only as one video, so its 2 episodes cannot be matched",
        [true, true],
    ], "hanime single video: a lone numberless video is offered to a one-episode entry, but never as episode 1 of a multi-episode entry (reported as a notice)")
    eq([
        await ids(M(20934, "Swing Out Sisters (2014)", "", [], "2014-01-30", 1)),
        await ids(M(12143, "Swing Out Sisters", "", [], "2011-11-25", 1)),
        await ids(M(900010, "Swing Out Sisters (2011)", "", [], "", 1)),
        await ids(M(20634, "Himegoto", "", ["Hime Goto"], "2014-07-07", 13, "TV_SHORT")),
        await ids(M(900011, "Himegoto", "", [], "2002-01-12", 1)),
        await ids(M(6201, "Princess Lover!", "", [], "2009-07-06", 12, "TV")),
        await ids(M(8918, "Princess Lover! OVA", "", ["Kimi to Isshou no Asa"], "2010-09-17", 2)),
        await ids(M(5347, "Bible Black: Imari Ryoujoku Genba", "", [], "2005-07-25", 1, "SPECIAL")),
        await ids(M(177149, "Bubble de House de ***: Ofuro Maker no Showroom ga Sharehouse de... The Animation", "", [], "2024-08-30", 0)),
    ], [[], ["swing out sisters"], ["swing out sisters"], [], ["hi.me.go.to"], [], ["princess lover! ova"], [], ["bubble de house de xxx"]],
        "hanime exact traps: a '(year)' tag far from the site's year, a match only after removing spaces from another decade, and a TV entry against the site's OVA group all need the date; a franchise prefix cut from a title needs 3 words to count in the alt names")
    eq([
        await ids(M(21754, "Shiiku × Kanojo", "", [], "2016-08-26", 4)),
        await ids(M(1275, "Can Can Bunny Extra", "Can Can Bunny", ["Can Can Bunny Extra - Lucky 7"], "1996-01-19", 6)),
        await h.findEpisodes("can can bunny extra").then((r) => r.map((e) => e.number), String),
        await err(h.findEpisodes("shiiku x kanojo 2 bonus episode")),
        await ids(M(900012, "Tonari no Ie no Hanashi Animation", "", [], "2024-10-04", 0)),
    ], [["shiiku x kanojo"], ["can can bunny extra"], [1, 2], "hanime: shiiku x kanojo 2 bonus episode is no longer in the site's catalog - match the series again", ["tonari no ie no hanashi"]],
        "hanime normalize 2: '×' reads as x, a series whose name contains 'Extra' keeps its episodes while a trailing 'Bonus Episode' row is still skipped, and a bare 'Animation' suffix is dropped")
    eq([
        await ids(M(151632, "Isekai Meikyuu de Harem wo OVA", "", ["Harem in the Labyrinth of Another World OVA"], "2022-11-25", 2)),
        await ids(M(900004, "Hoshizora Lesson 2nd Stage", "", [], "2017-11-23", 1)),
        await ids(M(900005, "Kouhai Ao", "", [], "2015-05-05", 1)),
    ], [[], [], []], "hanime traps: an OVA entry is not its TV series, a sequel the site files as episode 2 of the first show is not matched by that row's date, and a short shared word is not a match")
    eq([
        await ids(M(900006, "Ano Natsu no Hi to Kimi to Boku no Monogatari", "", [], "2026-04-30", 2)),
        await ids(M(210116, "Kare no Shiranai Himitsu wo Irete. The Animation", "", [], "2026-06-26", 0)),
        await ids(M(212574, "Pure x Holic: Junketsu Otome to Kon’in Kankei!? The Animation", "", [], "2026-08-28", 2)),
        await ids(M(20783, "Rance 01: Hikari wo Motomete THE ANIMATION", "", [], "2014-12-26", 4)),
    ], [["ano natsu no hi"], ["kare no shiranai himitsu o irete the animation"], ["pure x holic: junketsu otome to kon'in kankei!?"], ["rance: the quest for hikari"]],
        "hanime normalize: a truncated site name matches by prefix on the JST date of its earliest row even when episodes were released out of order; wo/o, THE ANIMATION, HTML entities, curly apostrophes and the site's alt names all line up")
    const titles = (await h.search({ media: M(212574, "Pure x Holic: Junketsu Otome to Kon’in Kankei!? The Animation", "", [], "2026-08-28", 2), query: "x", dub: false })).map((r) => [r.title, r.url, r.subOrDub])
    eq(titles, [["Pure x Holic: Junketsu Otome to Kon'in Kankei!?", "https://hanime.tv/videos/hentai/pure-x-holic-1", "sub"]], "hanime result: the site title is decoded and the result links the first episode page")
    eq([
        await err(h.search({ media: M(113417, "Overflow", "Overflow", [], "2020-01-06", 8), query: "Overflow", dub: false })),
        await ids(M(900007, "Overflow", "", [], "2020-02-23", 1)),
        h.logs.filter((l) => l.indexOf("Overflow Season 1") !== -1).map((l) => /^warn SEHERRv1 .*"lvl":"info"/.test(l)),
    ], ["hanime: the site has Overflow Season 1 only as one video of the whole season, so its episodes cannot be matched", ["overflow season 1"], [true]],
        "hanime season compilation: a whole-season video is never mapped onto a multi-episode entry (reported as a notice) and is offered only to a one-episode entry")
    const eps = async (key) => (await h.findEpisodes(key)).map((e) => [e.number, e.id, e.title || null])
    eq([
        await eps("boku no yayoi-san"),
        await eps("super naughty maid!"),
        (await eps("toilet no hanako-san")).map((e) => e[0]),
        (await eps("night shift nurses - karte")).map((e) => e[0]),
        (await eps("futabu!!")).map((e) => e[0] + ":" + e[1]),
        (await eps("rance: the quest for hikari")).map((e) => e[1]),
        (await eps("overflow season 1")).map((e) => e[0]),
    ], [
        [[1, "boku-no-yayoi-san", "Episodes 1 & 2"], [2, "boku-no-yayoi-san", "Episodes 1 & 2"], [3, "boku-no-yayoi-san-3-4", "Episodes 3 & 4"], [4, "boku-no-yayoi-san-4", null]],
        [[1, "super-naughty-maid", null], [2, "super-naughty-maid-2", null]],
        [1, 3, 4],
        [1, 2, 5, 10],
        ["1:futabu-1-6439", "2:futabu-2-c0f1"],
        ["rance-the-quest-for-hikari-1", "rance-the-quest-for-hikari-2", "rance-the-quest-for-hikari-3", "rance-the-quest-for-hikari-4"],
        [1],
    ], "hanime grouping: a '1 & 2' row serves both numbers and a single row beats it, a numberless row is episode 1, gaps stay gaps, '.5' specials and extras are left out, and random-suffix slugs keep the number from the name")
    eq([(await eps("joshi luck!")).map((e) => e[1]), (await h.findEpisodes("kuroinu"))[0].url], [["joshi-luck-1-uncensored-re-release", "joshi-luck-2-c0f1"], "https://hanime.tv/videos/hentai/kuroinu-1"],
        "hanime dedupe: a re-upload of the same episode keeps one copy, the uncensored one first and otherwise the newest")
    eq(await err(h.findEpisodes("no such show")), "hanime: no such show is no longer in the site's catalog - match the series again", "hanime episodes: a saved match the catalog dropped asks for a new match")
    eq(h.hits.filter((x) => x[0].indexOf("search_hvs") !== -1).length, 1, "hanime cache: the catalog is fetched once and reused by every search and episode list")
    const before = h.sent.length
    const t0 = Math.floor(Date.now() / 1000)
    const srv = await h.findEpisodeServer({ id: "kuroinu-1", number: 1, url: "" }, "hanime").catch((e) => ({ server: String(e), headers: {}, videoSources: [] }))
    const req = h.sent[before]
    eq([srv.server, srv.headers, srv.videoSources.map((v) => [v.url, v.type, v.quality, v.subtitles])], ["hanime", { Referer: "https://hanime.tv/" }, [
        ["https://hanime.tv/hls/15/tok720", "m3u8", "720p", []],
        ["https://hanime.tv/hls/15/tok480", "m3u8", "480p", []],
        ["https://hanime.tv/hls/15/tok360", "m3u8", "360p", []],
    ]], "hanime server: each free quality is its own m3u8, best first, the premium 1080p promotion is skipped, subtitles are burned in, and the Referer header sends playlist, key and segments through Seanime's proxy")
    eq([req && req.payload.slug, req && req.payload.directive, req && req.payload.timestamp_unix === req.t, req && Math.abs(req.t - t0 - 60) <= 3, req && req.h.Origin, req && req.h.Referer, h.hits.every((x) => x[1])],
        ["kuroinu-1", "htv_player_handshake", true, true, "https://hanime.tv", "https://hanime.tv/", true],
        "hanime handshake: the AES-GCM seal (with its AAD) opens with the site's key, x-time runs 60 s ahead of the clock, the signature matches, and every request skips the Cloudflare bypass")
    const serr = (id) => err(h.findEpisodeServer({ id, number: 1, url: "" }, "hanime"))
    const logMark = h.logs.length
    eq([
        await serr("gone-1"),
        await serr("delisted-1"),
        await serr("premium-1"),
        await serr("ua1-1"),
        await serr("waf-1"),
        await serr("notoken-1"),
        await serr("Bad Id!"),
        await err(mkH({ hsDown: true }).findEpisodeServer({ id: "kuroinu-1", number: 1, url: "" }, "hanime")),
    ], [
        "hanime: episode 1 is gone from the site",
        "hanime: the site returned no streams for episode 1 (removed from the site, or not available where you are)",
        "hanime: episode 1 plays only for premium accounts on the site",
        "hanime: the site refused the stream handshake (UA1) - the site changed its signing and this extension needs an update, or this computer's clock is more than 3 minutes slow",
        "hanime: the stream handshake (auth.hanime.tv) answered HTTP 403",
        "hanime: the stream handshake answered in a shape this extension does not understand - the site changed its API; this extension needs an update",
        "hanime: unrecognized episode id - refresh the episode list",
    "hanime: the stream handshake (auth.hanime.tv) could not be found (DNS)",
    ], "hanime server errors: a removed slug, a delisted episode, a premium-only episode, a rotated signing secret, an HTTP error, a changed answer, a bad id and an unreachable host each say what failed")
    eq(h.logs.slice(logMark).map((l) => (/"lvl":"info"/.test(l) ? "info" : /^error SEHERRv1 /.test(l) ? "error" : "?")), ["info", "info", "info", "error", "error", "error", "error"],
        "hanime levels: missing, delisted and premium-only episodes are notices; failures are errors")
    const o = { catStatus: 503 }
    const sick = mkH(o)
    const first = await err(sick.search({ media: M(11827, kur, "", [], "2012-01-27", 6), query: "", dub: false }))
    o.catStatus = 0
    eq([
        first,
        (await sick.search({ media: M(11827, kur, "", [], "2012-01-27", 6), query: "", dub: false })).length,
        await err(mkH({ catDown: true }).search({ media: M(11827, kur, "", [], "2012-01-27", 6), query: "", dub: false })),
        await err(mkH({ catShape: true }).findEpisodes("kuroinu")),
    ], [
        "hanime: the catalog (guest.freeanimehentai.net) answered HTTP 503",
        1,
        "hanime: the catalog (guest.freeanimehentai.net) could not be found (DNS)",
        "hanime: the catalog answered in a shape this extension does not understand - the site changed its API; this extension needs an update",
    ], "hanime catalog errors: an HTTP error (not cached, so the next search retries), an unreachable host and a changed answer each say what failed")
    const quiet = mkH()
    eq([await quiet.search({ media: M(11827, kur, "", [], "2012-01-27", 6), query: "", dub: true }), quiet.hits.length, quiet.getSettings()], [[], 0, { episodeServers: ["hanime"], supportsDub: false }],
        "hanime dub: there is no dub, so a dub search answers nothing without asking the site")
    eq([
        (await quiet.search({ media: { id: 0, synonyms: null }, query: "kuroinu", dub: false })).map((r) => r.title),
        (await quiet.search({ media: { id: 0, synonyms: null }, query: "yakin byoutou", dub: false })).map((r) => r.id),
        await quiet.search({ media: { id: 0, synonyms: null }, query: "", dub: false }),
    ], [["Kuroinu", "Kuroinu 2"], ["night shift nurses - karte", "night shift nurses - kranke", "night shift nurses 2", "night shift nurses - ren nanase"], []],
        "hanime manual search: a query lists every series whose name or alt names contain it, names first")
}

console.log("hentaicity")
{
    const H = "https://www.hentaicity.com"
    const id = (p, n) => (p + "00000000000").slice(0, 11 - String(n).length) + n
    const card = ([vid, title, num = 30000]) => `<div class="outer-item">\n<div class="item">\n<div class="thumb-ratio">\n<a href="${H}/click/1-1/video/x-${vid}.html" class="thumb-img pop-execute" id="trailerp">\n<img loading="lazy" src="https://cdn1.images.hentaicity.com/videos/0465/${num}/main.jpg" alt="${title}" /><span class="time">24:00</span></a>\n</div>\n<p><a class="video-title pop-execute" href="${H}/click/1-1/video/x-${vid}.html" title="${title}">${title}</a></p>\n</div>\n</div>`
    const results = (rows) => `<html><head><title>Search | Hentai City</title></head><body>${rows.map(card).join("\n")}</body></html>`
    const empty = `<html><head><title>Nsn | Hentai City</title></head><body><div class="search-holder"></div><div>No files matching your search criteria were found</div></body></html>`
    const pad = [[id("pd", 1), "Padding Show 1 - Chapter", 38001], [id("pd", 2), "Unrelated Works 3 - Chapter", 38002]]
    const src = (dir, num, names) => `<source src="https://hls.hentaicity.com/_hls/flv/${dir}/${num}/,${names},.mp4.urlset/master.m3u8?validfrom=100&amp;validto=7300&amp;hash=Zm9v%2Fbar%3D" type='application/x-mpegURL' />`
    const page = (vid, box = "", names = "default,mobile,480p", dir = "0502", num = 28271) =>
        `<html><head><title>Watch | Hentai City</title></head><body><div class="detail-player"><video id="video-id" controls preload="auto">\n\t${src(dir, num, names)}\n\t</video></div>` +
        `<div class="ubox-text share2" style="display:none"><input value="${H}/video/x-${vid}.html"></div>${box}` +
        `<div class="ubox-text" style="text-align: left"><a href="${H}/login.php">Login</a> <a href="${H}/signup.php">Sign Up</a></div></body></html>`
    const list = (heading, ...secs) =>
        `<div class="ubox-text" style="text-align: left; margin: 10px 0px 0px 0px">\r\n\t\t\t\t<div style="margin-bottom: 10px"><b style="font-weight: bold">${heading}</b></div>\r\n<div style="margin-bottom: 10px">A short synopsis line.<br><br>\r\n</div>\r\n` +
        secs.map(([name, links], i) => (i ? `<br>\r\n${i % 2 ? `<b style="font-weight: bold">${name}</b>` : name}<br>\r\n` : "") + links.map(([vid, label]) => `<a href="${H}/video/x-${vid}.html">${label}</a><br>`).join("\r\n")).join("") +
        `\r\n\t\t\t</div>`
    const grid = (heading, at, cells) =>
        `<div class="ubox-text" style="text-align: left"><div style="margin-bottom: 10px"><b style="font-weight: bold">${heading}</b></div><div>A short synopsis line.</div><div class="list">` +
        cells.map(([vid, alt, label]) => `<div class="item" style="width: 170px"><div class="thumb-ratio">${vid === at ? `<a class="thumb-img">` : `<a href="${H}/video/x-${vid}.html" class="thumb-img pop-execute">`}<img loading="lazy" src="https://cdn1.images.hentaicity.com/videos/0001/1/main.jpg" alt="${alt}"><span class="time">${label}</span></a></div></div>`).join("\n") +
        `</div></div>`
    const eps = (p, n, label = (k) => `Episode ${k}`) => Array.from({ length: n }, (_, k) => [id(p, k + 1), label(k + 1)])
    const rows = (p, n, head, num = 20000) => Array.from({ length: n }, (_, k) => [id(p, k + 1), `${head(k + 1)} - Chapter`, num + k])

    const bible = results([...rows("bb", 6, (k) => `Bible Black ${k}`), ...rows("nt", 6, (k) => `Bible Black NT ${k}`, 17085), ...rows("bo", 2, (k) => `Bible Black Origins ${k}`), ...rows("by", 2, (k) => `Bible Black Only ${k}`), [id("byb", 1), "Bible Black Only Bonus - Extra"], ...pad])
    const bibleBox = list("Bible Black", ["", eps("bb", 6)], ["Bible Black Origins", eps("bo", 2)], ["Bible Black New Testament", eps("nt", 6)], ["Bible Black Only", eps("by", 2).concat([[id("byb", 1), "Bonus"]])])
    const asagi = results([
        [id("tg", 1), "Taimanin Asagi 1 - Chapter"], [id("tg", 2), "Taimanin Asagi 2: Chaos Arena - Chapter"], [id("tg", 25), "Taimanin Asagi 2.5 - Chapter"], [id("tg", 26), "Taimanin Asagi 2.5: Bad End - Chapter"],
        [id("tg", 3), "Taimanin Asagi 3: Inside - Chapter"], [id("tg", 35), "Taimanin Asagi 3.5: Capture of Asuka - Chapter"], [id("tg", 4), "Taimanin Asagi 4: Banquet - Chapter"],
        ...rows("ad", 4, (k) => `Anti-Demon Ninja Asagi 1 ep${k}`), ...rows("ae", 2, (k) => `Anti-Demon Ninja Asagi 2 ep${k}`), ...rows("af", 2, (k) => `Anti-Demon Ninja Asagi 3 ep${k}`),
        [id("adb", 1), "Anti-Demon Ninja Asagi Bonus - Extra"], [id("ac", 1), "Anti-Demon Ninja Asagi: Captive Doll 1 - Chapter"], [id("ac", 2), "Anti-Demon Ninja Asagi: Captive Doll 2 - Chapter"], [id("adp", 1), "Anti-Demon Ninja Asagi (preview) - Trailer"], ...pad,
    ])
    const asagiBox = list("Taimanin Asagi / Anti-Demon Ninja Asagi / Anti-Demon Hunters / 対魔忍アサギ", ["", eps("ad", 4).concat([[id("adb", 1), "Bonus"]])], ["Anti-Demon Ninja Asagi 2", eps("ae", 2)], ["Anti-Demon Ninja Asagi 3", eps("af", 2)])
    const discipline = results([[id("dl", 2), "Discipline 2 - Chapter", 37243], ...rows("dc", 6, (k) => `Discipline: The Record of a Crusade ${k}`, 24533), ...rows("cd", 3, (k) => `Corrective Discipline ${k}`), ...pad])
    const disciplineBox = list("Discipline - The Hentai Academy / DISCIPLINE -The record of a Crusade- / ディシプリン", ["", eps("dc", 6)]).replace("\r\n\t\t\t</div>", "<br>\r\n<br>Discipline Zero<br>Another synopsis line.<br>Episode 1<br>Episode 2\r\n\t\t\t</div>")
    const kuroinu = results([[id("kp", 1), "Kuroinu (preview) - Trailer"], [id("kr", 1), "Kuroinu 1- The first chapter"], ...rows("kr", 6, (k) => `Kuroinu ${k}`).slice(1), [id("ks", 1), "Kuroinu 2 ep1 - Chapter"]])
    const euphoria = results(rows("eu", 6, (k) => `Euphoria ${k}`))
    const kouhai = results([...rows("ko", 3, (k) => `Kouhai ${k}`), ...rows("sk", 2, (k) => `Senpai and Kouhai ${k}`)])
    const nurses = results([...rows("nc", 3, (k) => `Night Shift Nurses 3 ep${k}`), ...rows("nb", 3, (k) => `Night Shift Nurses 2ep${k + 2}`), [id("nl", 2), "Night Shift Nurses 2 Kamama Mana"], [id("nl", 3), "Night Shift Nurses 3 Yu Yagami"], ...pad])
    const erogeOld = rows("eg", 6, (k) => `Eroge! Make Sexy Games ${k}`, 30154)
    const eroge = results(erogeOld.concat([[id("en", 4), "Eroge! Make Sexy Games 4 - Chapter", 36933], [id("en", 5), "Eroge! Make Sexy Games 5 - Chapter", 36935], [id("en", 6), "Eroge! Make Sexy Games 6 - Chapter", 36934]]))
    const erogeBox = grid("Eroge! H mo Game mo Kaihatsu Zanmai / えろげー! ~Hもゲームも開発三昧~", id("eg", 1), [[id("eg", 1), "Episode 1", "Episode 1 - Now Playing"], ...eps("eg", 6).slice(1).map(([v, l]) => [v, l, l])])
    const scaffold = `<html><head><title>Kuro No Kyoushitsu | Hentai City</title></head><body><div class="search-holder"></div><div class="search-holder"></div><ul><li>tag</li></ul></body></html>`
    const mmBox = list("Monster Musume: Everyday Life with Monster Girls", ["", eps("mm", 4)]).replace(`<a href="${H}/video/x-${id("mm", 3)}.html">Episode 3</a>`, "Episode 3")
    const monster = results([[id("mo", 1), "Monster Musume OVA 1 - Chapter", 32785], [id("mo", 2), "Monster Musume OVA 2 - Chapter", 32786], [id("mm", 1), "Homestay Day - Clip", 32700], [id("mm", 2), "Market Visit - Clip", 32701], [id("mm", 3), "Monster Musume 1 - Chapter", 32702], [id("mm", 4), "Monster Musume 4 - Chapter", 32834]])
    const hxeros = results([...rows("hx", 12, (k) => `Super HxEros (uncensored) ${k}`, 32729), [id("ho", 1), "Super HxEros OVA 1 - Chapter", 32635], [id("ho", 2), "Super HxEros OVA 2 - Chapter", 32636], [id("hc", 1), "Super HxEros - Compilation", 32334]])
    const sisters = results([[id("is", 1), "Immoral Sisters 1 - Chapter"], [id("is", 2), "Immoral Sisters 2 - Chapter"]])
    const sistersBox = list("Ai Shimai: Futari no Kajitsu / Immoral Sisters", ["", eps("is", 2)], ["Immoral Sisters Blossoming", eps("dead", 2)])
    const fuzzy = results([[id("fz", 1), "Fuzzy Lips 1 - Chapter", 37056], [id("fz", 2), "Fuzzy Lips 2 - Chapter", 20740]])
    const gakuen = results([[id("gk", 1), "Gakuen 3: Brilliant Insult 1 - Chapter"], [id("gk", 2), "Gakuen 3: Brilliant Insult 2 - Chapter"]])
    const searches = {
        "kuro+no+kyoushitsu": scaffold, "monster+musume+everyday+life+with+monster+girls": monster, "super+hxeros": hxeros, "immoral+sisters+blossoming": sisters, "immoral+sisters": sisters,
        "fuzzy+lips": fuzzy, "fuzzy+lips+0": fuzzy, "fuzzy+lips+1": fuzzy, "princess+lover": results(rows("pl", 2, (k) => `Princess Lover! ${k}`, 35432)),
        "does+it+count+if+you+lose+your+innocence": results(rows("an", 9, (k) => `Does It Count If You Lose Your Innocence to an Android? ${k}`)),
        "night+shift+nurses+2": results(rows("n2", 5, (k) => `Night Shift Nurses 2 ep${k}`)), "the+invisible+stud": results(rows("iv", 2, (k) => `Invisible Stud ${k}`)),
        stringendo: results(rows("sg", 12, (k) => `Stringendo: Private Lesson of Angels ${k}`, 36830)), "gakuen+3": gakuen, "gakuen+2": gakuen, "lone+show": results([[id("ls", 1), "Lone Show: Its Subtitle - Chapter"]]),
        reunion: results([[id("ru", 1), "Reunion 1 - Chapter", 36556], [id("ru", 2), "Reunion 2 - Chapter", 36557], [id("rc", 1), "Reunion - Clip", 28497]]),
        "bible+black": bible, "shin+bible+black": empty,
        "taimanin+asagi": asagi, "taimanin+asagi+2": asagi, "taimanin+asagi+bonus+video": asagi, "anti+demon+ninja+asagi": asagi, "anti+demon+hunters": asagi,
        "discipline+the+academy": discipline, discipline: discipline, "discipline+the+record+of+a": discipline,
        "kuroinu+2": kuroinu, kuroinu: kuroinu, "euphoria+2": euphoria, "senpai+and+kouhai": kouhai,
        "night+shift+nurses": nurses, "my+long+title+show+and+friends+together": results([...rows("lt", 3, (k) => `My Long Title Show and Friends Together ${k}`), ...pad]), "my+long+title+show+and": results(rows("lt", 5, (k) => `My Long Title Show and Friends Together ${k}`)), "yakin+byoutou": empty, "eroge+h+mo+game+mo+kaihatsu+zanmai": empty, eroge: results(erogeOld), "eroge+make+sexy+games": eroge,
    }
    const pages = {
        [id("bb", 1)]: page(id("bb", 1), bibleBox), [id("tg", 1)]: page(id("tg", 1)), [id("ad", 1)]: page(id("ad", 1), asagiBox), [id("ae", 1)]: page(id("ae", 1), asagiBox),
        [id("dl", 2)]: page(id("dl", 2)), [id("dc", 1)]: page(id("dc", 1), disciplineBox), [id("eu", 1)]: page(id("eu", 1)),
        [id("eg", 1)]: page(id("eg", 1), erogeBox), [id("en", 4)]: page(id("en", 4), "", "default,mobile,480p,720p,1080p", "0315", 36933), [id("eg", 4)]: page(id("eg", 4), "", "default,mobile,480p", "0456", 30157),
        [id("en", 5)]: page(id("en", 5), "", "default,mobile", "0958", 36935), [id("eg", 5)]: page(id("eg", 5), "", "default,mobile,480p", "0350", 30158),
        [id("nc", 1)]: page(id("nc", 1), "", "default,mobile,480p,720p", "0101", 101),
        [id("mm", 3)]: page(id("mm", 3), mmBox),[id("is", 1)]: page(id("is", 1), sistersBox), [id("pl", 1)]: page(id("pl", 1), list("Princess Lover!", ["", eps("pl", 2)])),
        [id("ru", 1)]: page(id("ru", 1), "", "default,mobile,480p", "0730", 36556), [id("rc", 1)]: page(id("rc", 1), "", "default,mobile,480p,720p", "0569", 28497),
    }
    const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, url: "", headers: {}, cookies: {}, text: () => body, json: () => JSON.parse(body) })
    const busy = `<html><head><title>Service Unavailable</title></head><body>No server is available to handle the request</body></html>`
    let plain = 0
    const mkCity = (o = {}) => {
        const store = new Map()
        const hits = []
        const logs = []
        const al = []
        const prov = load("hentaicity", {
            console: { log() {}, info() {}, warn: (s) => logs.push("warn " + s), error: (s) => logs.push("error " + s) },
            $store: { get: (k) => store.get(k), set: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))), remove: (k) => store.delete(k), has: (k) => store.has(k) },
            fetch: (url, init) => {
                if (!init || init.noCloudflareBypass !== true) plain++
                if (url === "https://graphql.anilist.co") {
                    const v = JSON.parse(init.body).variables.id
                    al.push(v)
                    if (o.down) return Promise.reject(new Error(`Post "${url}": dial tcp: lookup graphql.anilist.co: no such host`))
                    return reply(JSON.stringify({ data: { Media: { synonyms: (o.syn || {})[v] || [] } } }))
                }
                const path = url.replace(H, "")
                hits.push(path)
                if (o.down) return Promise.reject(new Error(`Get "${url}": dial tcp: lookup www.hentaicity.com: no such host`))
                const queued = o.queue && o.queue[path] && o.queue[path].shift()
                if (queued) return reply(queued[1] || "", queued[0])
                const s = /^\/search\/video\/([^/]+)$/.exec(path)
                if (s) return reply(searches[s[1]] || results(pad))
                const v = /^\/video\/x-([A-Za-z0-9]{11})\.html$/.exec(path)
                if (v && pages[v[1]]) return reply(pages[v[1]])
                return reply("<html><title>404</title></html>", 404)
            },
        })
        prov.hits = hits
        prov.logs = logs
        prov.al = al
        return prov
    }
    const media = (mid, romaji, english, synonyms = [], episodeCount = -1) => ({ id: mid, romajiTitle: romaji, englishTitle: english || undefined, synonyms, episodeCount, isAdult: true })
    const pick = async (p, m) => (await p.search({ media: m, query: m.romajiTitle, dub: false })).map((r) => [r.id, r.title])
    const list2 = async (p, rid) => (await p.findEpisodes(rid)).map((e) => `${e.number}:${e.id}`)
    const err = (pr) => pr.then(() => "no error", (e) => String(e))
    const many = (p, n, k) => Array.from({ length: n }, (_, i) => `${i + 1}:${id(p, i + 1 + (k || 0))}`)

    const hp = load("hentaicity")
    eq([
        "Kuroinu 1- The first chapter", "Kuroinu (preview) - Trailer", "Kuroinu 2 ep1 - Chapter", "Bible Black Only Bonus - Extra", "Super HxEros (uncensored) 1 - Chapter",
        "Harem in the Labyrinth of Another World (uncensored) S1E12 - Chapter", "Night Shift Nurses 2ep3 - Chapter", "Anti-Demon Ninja Asagi 1 ep4 - Chapter",
        "Taimanin Asagi 2.5: Bad End - Chapter", "Let&#039;s Make Love Together! 4.5 - Chapter", "Taimanin Asagi 3: Inside - Chapter", "Euphoria 2 (ecchi anime) - Chapter",
        "Night Shift Nurses 2 Kamama Mana", "Taimanin Kiriko - Chapter", "Futa Show (JOI game preview) - Clip", "Game Show (game preview) - Clip",
        "Rance 01: Hikari o Motomete 2 - Chapter", "Discipline: The Record of a Crusade 6 - Chapter", "Let&apos;s Go 3 – Chapter", "Dinner for Vampire (english dubs) - Clip",
    ].map((t) => { const h = hp.head(t); return h ? `${h.series}|${h.season}|${h.ep}` : null }), [
        "Kuroinu|1|1", null, "Kuroinu|2|1", null, "Super HxEros|1|1",
        "Harem in the Labyrinth of Another World|1|12", "Night Shift Nurses|2|3", "Anti-Demon Ninja Asagi|1|4",
        null, null, "Taimanin Asagi|1|3", "Euphoria|1|2",
        null, "Taimanin Kiriko|1|1", null, null,
        "Rance 01: Hikari o Motomete|1|2", "Discipline: The Record of a Crusade|1|6", "Let's Go|1|3", null,
    ], "city heads: '1-' with no space, '<S> epN', '2ep3' and 'S1E12' carry their season, a '(...)' tag before the number is dropped, '.5' specials, previews, bonus clips, dub uploads and 'N <words>' parts are not episodes, 'N: subtitle' keeps N, an unnumbered head is episode 1")
    eq([hp.split("fuzzy lips 0"), hp.split("the invisible stud"), hp.split("a kite 2")], [{ base: "fuzzy lips", season: 0 }, { base: "invisible stud", season: 1 }, { base: "kite", season: 2 }],
        "city split: a trailing 0 is its own season, never season 1, and a leading article is not part of the title")
    eq(["Kuroinu II THE ANIMATION", "Ane wo Yobu", "Let’s Play", "Café & Bar (uncensored)", "Discipline - The Hentai Academy", "Kanojo × Kanojo", "Mankitsu Happening OVA"].map((t) => hp.norm(t)),
        ["kuroinu 2", "ane o yobu", "lets play", "cafe and bar", "discipline the academy", "kanojo x kanojo", "mankitsu happening"],
        "city norm: II becomes 2, 'wo' becomes 'o', apostrophes vanish, accents fold, '&' is 'and', '(...)' tags and the words ova/hentai/the animation drop out")
    eq([hp.near("bibleblacknewtestement", "bibleblacknewtestament"), hp.near("kuroinu2", "kuroinu3"), hp.near("wordsworth", "wordsworthgaiden"), hp.near("", "")], [true, false, false, false],
        "city near: a one-letter typo is forgiven only on long titles")
    const ww = hp.sections(page(id("wg", 1), grid("Words Worth / ワーズ・ワース", id("wg", 1), [...eps("ww", 5, (k) => `Words Worth ${k}`).map(([v, l]) => [v, "Episode", l]), [id("wg", 1), "Episode 6", "Words Worth Gaiden 1"], [id("wg", 2), "Episode 7", "Words Worth Gaiden 2"]])), id("wg", 1))
    eq(ww.map((s) => [s.names.slice(0, 2), s.links.map((l) => `${l.ep}:${l.id}`)]), [
        [["Words Worth", "ワーズ・ワース"], many("ww", 5)],
        [["Words Worth Gaiden"], [`1:${id("wg", 1)}`, `2:${id("wg", 2)}`]],
    ], "city box: a thumbnail grid splits by each item's own series label (the heading's series keeps its aliases), the page's own unlinked item counts as itself, and the login box is never read")
    const plainBox = (at) => list("Words Worth / ワーズ・ワース", ["", eps("ww", 4)], ["Words Worth Gaiden", eps("wg", 2)]).replace(`<a href="${H}/video/x-${id("ww", at)}.html">Episode ${at}</a>`, `Episode ${at}`)
    eq([1, 3, 4].map((at) => hp.sections(page(id("ww", at), plainBox(at)), id("ww", at)).map((s) => s.links.map((l) => `${l.ep}:${l.id}`).sort())), [1, 3, 4].map(() => [many("ww", 4), many("wg", 2)]),
        "city box: in the list layout the page's own episode is plain text; it joins its section (first, middle or last item) instead of splitting it or going missing")

    const bb = mkCity()
    const bbId = `b$${id("bb", 1)}$${id("bb", 1)}$bible+black`
    eq([await pick(bb, media(368, "Bible Black", "", [], 6)), await list2(bb, bbId), bb.hits], [
        [[bbId, "Bible Black"]], many("bb", 6), ["/search/video/bible+black", `/video/x-${id("bb", 1)}.html`],
    ], "city pick: the franchise box confirms the exact series among its spin-offs, and the episode list comes from the cached box and search")
    const nt = mkCity()
    eq([await pick(nt, media(1401, "Shin Bible Black", "Bible Black: New Testement", ["Bible Black: Revival"], 6)), await list2(nt, `b$${id("bb", 1)}$${id("nt", 1)}$bible+black`), nt.hits.filter((h) => h.indexOf("/video/") === 0)], [
        [[`b$${id("bb", 1)}$${id("nt", 1)}$bible+black`, "Bible Black: New Testement"]], many("nt", 6), [`/video/x-${id("bb", 1)}.html`],
    ], "city pick: a sequel known only by its (misspelt) English title is found in the franchise box, never as the original 'Bible Black 1..6', and lists the box's own links")
    const ta = mkCity()
    const taId = `b$${id("ad", 1)}$${id("ad", 1)}$taimanin+asagi`
    eq([await pick(ta, media(3479, "Taimanin Asagi", "", [], 4)), await list2(ta, taId), ta.hits.filter((h) => h.indexOf("/video/") === 0)], [
        [[taId, "Taimanin Asagi"]], many("ad", 4), [`/video/x-${id("tg", 1)}.html`, `/video/x-${id("ad", 1)}.html`],
    ], "city trap: the same-named game clips 'Taimanin Asagi 1..4' lose to the OVA posted as 'Anti-Demon Ninja Asagi 1 epN', whose series box lists the romaji")
    eq([await pick(mkCity(), media(21401, "Taimanin Asagi 2", "", [], 2)), await pick(mkCity(), media(8837, "Taimanin Asagi: Bonus Video", "", ["Anti-Demon Hunters", "Anti-Demon Ninja Asagi"], 1))], [
        [[`b$${id("ae", 1)}$${id("ae", 1)}$taimanin+asagi+2`, "Taimanin Asagi 2"]], [],
    ], "city sequel: 'Taimanin Asagi 2' is the box's 'Anti-Demon Ninja Asagi 2' and never game clip 2; a one-episode special named after the franchise borrows none of its four episodes")
    const dc = mkCity()
    const dcId = `b$${id("dc", 1)}$${id("dc", 1)}$discipline+the+academy`
    eq([await pick(dc, media(2432, "Discipline", "Discipline: The Hentai Academy", [], 6)), await list2(dc, dcId)], [
        [[dcId, "Discipline: The Hentai Academy"]], many("dc", 6),
    ], "city trap: the lone unrelated 'Discipline 2' post is not episode 2 of Discipline; the box alias finds 'Discipline: The Record of a Crusade'")
    const ku = mkCity()
    eq([await pick(ku, media(132209, "Kuroinu II THE ANIMATION", "", [], 1)), await list2(ku, "g$2$kuroinu$kuroinu+2"), ku.hits.filter((h) => h.indexOf("/video/") === 0).length], [
        [["g$2$kuroinu$kuroinu+2", "Kuroinu II THE ANIMATION"]], [`1:${id("ks", 1)}`], 0,
    ], "city sequel: 'Kuroinu II' takes only 'Kuroinu 2 ep1', not 'Kuroinu 2', and the preview is skipped")
    const eu = mkCity()
    eq([await pick(eu, media(990002, "Euphoria 2", "", [], 2)), await pick(mkCity(), media(990002, "Euphoria 2", "", [], -1))], [[], []], "city sequel: an AniList 'X 2' never matches episode 2 of 'X', with or without an episode count")
    const ko = mkCity()
    eq([await pick(ko, media(990003, "○○ Kouhai", "", ["Senpai and Kouhai"], 2)), ko.hits], [[["g$1$senpai and kouhai$senpai+and+kouhai", "○○ Kouhai"]], ["/search/video/senpai+and+kouhai"]],
        "city placeholder: a '○○' romaji is neither searched nor matched (no 'Kouhai'); the synonym wins, and the result carries the AniList title so Seanime's title comparison ranks it first")
    const ns = mkCity()
    eq([await pick(ns, media(1387, "Yakin Byoutou", "Night Shift Nurses", [], 10)), ns.hits.length], [[], 2], "city trap: a show the site lacks gets nothing from its sequels' 'Night Shift Nurses 3 epN', '2epN' or the loose 'Night Shift Nurses 2 <name>' parts")
    const lt = mkCity()
    eq([await pick(lt, media(990005, "Nagai Taitoru", "My Long Title Show and Friends Together", [], 4)), await list2(lt, "g$1$my long title show and friends together$my+long+title+show+and+friends+together")], [
        [["g$1$my long title show and friends together$my+long+title+show+and+friends+together", "My Long Title Show and Friends Together"]], many("lt", 5),
    ], "city episodes: a long AniList query that ranks only some episodes is topped up by a search for the series' own first words, and one episode past the AniList count (25% headroom) is not a mismatch")
    const mn = mkCity()
    const manual = await mn.search({ media: { id: 0, synonyms: [], isAdult: false }, query: "Night Shift Nurses", dub: false })
    eq([manual.map((r) => [r.id, r.title]), await list2(mn, manual[1].id)], [
        [["g$3$night shift nurses$night+shift+nurses", "Night Shift Nurses 3"], ["g$2$night shift nurses$night+shift+nurses", "Night Shift Nurses 2"]], [`3:${id("nb", 1)}`, `4:${id("nb", 2)}`, `5:${id("nb", 3)}`],
    ], "city manual: a typed query lists each season of a matching series and drops padding; episode numbers are the real ones, gaps included")

    const eg = mkCity()
    const egId = `b$${id("eg", 1)}$${id("eg", 1)}$eroge`
    eq([await pick(eg, media(10779, "Eroge!: H mo Game mo Kaihatsu Zanmai", "Eroge! Sex and Gamedev", [], 6)), await list2(eg, egId)], [
        [[egId, "Eroge! Sex and Gamedev"]],
        [`1:${id("eg", 1)}`, `2:${id("eg", 2)}`, `3:${id("eg", 3)}`, `4:${id("en", 4)},${id("eg", 4)}`, `5:${id("en", 5)},${id("eg", 5)}`, `6:${id("en", 6)},${id("eg", 6)}`],
    ], "city dedupe: the box's links plus the re-uploads a search for the series' own name turns up become one entry per episode (newest first); the grid box's own item reads 'Episode 1 - Now Playing'")
    const s4 = await eg.findEpisodeServer({ id: `${id("en", 4)},${id("eg", 4)}`, number: 4, url: "" }, "Hentai City")
    eq([s4.server, s4.headers, s4.videoSources.map((v) => [v.url, v.type, v.quality, v.subtitles])], [
        "Hentai City", { Referer: `${H}/` }, [
            ["https://hls.hentaicity.com/_hls/flv/0315/36933/,default,mobile,480p,720p,1080p,.mp4.urlset/master.m3u8?validfrom=100&validto=7300&hash=Zm9v%2Fbar%3D", "m3u8", "auto", []],
            [`${H}/flv/0315/36933/1080p.mp4`, "mp4", "1080p", []], [`${H}/flv/0315/36933/720p.mp4`, "mp4", "720p", []], [`${H}/flv/0315/36933/480p.mp4`, "mp4", "480p", []],
            [`${H}/flv/0315/36933/mobile.mp4`, "mp4", "360p", []], [`${H}/flv/0315/36933/default.mp4`, "mp4", "240p", []],
        ],
    ], "city server: the signed master plays as 'auto' first (Seanime's default pick), then the unsigned MP4s best-first labelled by height (never 'default'), all through Seanime's proxy via a Referer, with no subtitle tracks")
    const s5 = await eg.findEpisodeServer({ id: `${id("en", 5)},${id("eg", 5)}`, number: 5, url: "" }, "Hentai City")
    eq(s5.videoSources.map((v) => v.quality), ["auto", "480p", "360p", "240p"], "city dedupe: among copies the one with the most qualities plays, even when it is the older upload")
    const dub = mkCity()
    eq([await dub.search({ media: media(368, "Bible Black", "", [], 6), query: "Bible Black", dub: true }), dub.hits.length], [[], 0], "city dub: there is no dub, so a dub search asks nothing")
    const before = bb.hits.length
    eq([await pick(bb, media(368, "Bible Black", "", [], 6)), bb.hits.length - before, bb.al], [[[bbId, "Bible Black"]], 0, [368]], "city cache: Seanime's second search for the same show (the English title pass) is served from the store, AniList included")

    const down = mkCity({ down: true })
    eq([await err(down.search({ media: media(368, "Bible Black", "", [], 6), query: "", dub: false })), down.hits.length], ["hentaicity: search failed - the site could not be found (DNS)", 2], "city errors: an unreachable site is retried once and named")
    const sick = mkCity({ queue: { [`/video/x-${id("nc", 1)}.html`]: [[403, busy], [403, busy]] } })
    eq([await err(sick.findEpisodeServer({ id: id("nc", 1), number: 1, url: "" }, "Hentai City")), sick.logs.map((l) => /^error SEHERRv1 /.test(l) && l.indexOf('"lvl"') === -1)], [
        "hentaicity: episode 1 failed - the site answered HTTP 403 (Service Unavailable)", [true],
    ], "city errors: the edge's 403 'Service Unavailable' page is retried, then reported as an error")
    const flaky = mkCity({ queue: { [`/video/x-${id("nc", 1)}.html`]: [[403, busy]] } })
    eq([(await flaky.findEpisodeServer({ id: id("nc", 1), number: 1, url: "" }, "Hentai City")).videoSources.length, flaky.hits.length], [5, 2], "city errors: one 403 'Service Unavailable' is healed by the retry")
    const shaped = mkCity({ queue: { "/search/video/bible+black": [[200, "<html><body>new layout</body></html>"], [200, "<html><body>new layout</body></html>"]], [`/video/x-${id("nc", 1)}.html`]: [[200, "<html>no player</html>"], [200, "<html>no player</html>"]] } })
    eq([
        await err(shaped.search({ media: media(368, "Bible Black", "", [], 6), query: "", dub: false })),
        await err(shaped.findEpisodeServer({ id: id("nc", 1), number: 1, url: "" }, "Hentai City")),
        await pick(mkCity(), media(990004, "Yakin Byoutou", "", [], 1)),
    ], [
        "hentaicity: the site changed its search page - this extension needs an update",
        "hentaicity: the site changed its video page - this extension needs an update",
        [],
    ], "city errors: a search page with no results list or a video page with no player is a site change, while the site's own 'No files matching' page is simply no match")
    const gone = mkCity()
    eq([await err(gone.findEpisodeServer({ id: id("zz", 3), number: 3, url: "" }, "Hentai City")), gone.hits.length, gone.logs.map((l) => /^warn SEHERRv1 .*"lvl":"info"/.test(l))], [
        "hentaicity: episode 3 is no longer on the site - refresh the episode list", 1, [true],
    ], "city errors: a delisted episode (404) is not retried and is reported as a notice")
    const safe = (pr) => pr.then((v) => v, (e) => String(e))
    const kk = mkCity()
    eq([await safe(kk.search({ media: media(21153, "Kuro no Kyoushitsu", "Kuro no Kyoushitsu", [], 2), query: "", dub: false })), await safe(kk.search({ media: { id: 0, synonyms: [], isAdult: false }, query: "Kuro no Kyoushitsu", dub: false })), kk.logs],
        [[], [], []], "city empty: a result page with the search scaffold but no list and no 'No files matching' text (some words do this) is no match, not a site change")
    const ru = mkCity()
    const ruId = (await ru.search({ media: media(10590, "Reunion", "", [], 2), query: "", dub: false }))[0].id
    const ruEps = await ru.findEpisodes(ruId)
    eq([ruId, ruEps.map((e) => `${e.number}:${e.id}`), (await ru.findEpisodeServer(ruEps[0], "Hentai City")).videoSources[0].url.split("/")[6]], ["g$1$reunion$reunion", [`1:${id("ru", 1)}`, `2:${id("ru", 2)}`], "36556"],
        "city episodes: an unnumbered post of a numbered series is not another copy of episode 1, even when it has more qualities")
    const mm = mkCity()
    const mmId = `b$${id("mm", 3)}$${id("mm", 1)}$monster+musume+everyday+life+with+monster+girls`
    eq([await pick(mm, media(21093, "Monster Musume no Iru Nichijou", "Monster Musume: Everyday Life With Monster Girls", [], 4)), await list2(mm, mmId)], [[[mmId, "Monster Musume: Everyday Life With Monster Girls"]], many("mm", 4)],
        "city episodes: in box mode the box's numbers win over the posts' own titles (unnumbered or misnumbered), and 'X OVA N' posts are not episodes of the series 'X'")
    const hx = mkCity()
    eq([await pick(hx, media(112818, "Dokyuu Hentai HxEros", "SUPER HXEROS", [], 12)), await list2(hx, "g$1$super hxeros$super+hxeros"), await pick(mkCity(), media(123769, "Dokyuu Hentai HxEros OVA", "", ["SUPER HXEROS OVA"], 2)), await list2(hx, "g$1$super hxeros ova$super+hxeros")], [
        [["g$1$super hxeros$super+hxeros", "SUPER HXEROS"]], many("hx", 12), [["g$1$super hxeros ova$super+hxeros", "Dokyuu Hentai HxEros OVA"]], [`1:${id("ho", 1)}`, `2:${id("ho", 2)}`],
    ], "city OVA: the TV entry lists only the TV posts (no OVA posts, no unnumbered compilation), and the AniList 'X OVA' entry gets the 'X OVA N' posts")
    const dead = mkCity()
    eq([await pick(dead, media(1636, "Ai Shimai Tsubomi... Kegashite Kudasai", "Immoral Sisters: Blossoming", [], 2)), dead.hits.filter((h) => h.indexOf("/video/") === 0)], [[], [`/video/x-${id("is", 1)}.html`]],
        "city box: a box section none of whose links the site's search returns (dead links) is not a match")
    eq([await pick(mkCity(), media(21618, "Furueru Kuchibiru: fuzzy lips 0", "Fuzzy Lips 0", [], 1)), await pick(mkCity(), media(21617, "Furueru Kuchibiru: fuzzy lips 1", "Fuzzy Lips", ["Fuzzy Lips 1"], 1))], [[], []],
        "city count: 'X 0' is not 'X', and a one-episode entry never takes a two-episode group (no headroom below 4)")
    const an = mkCity()
    const anId = (await an.search({ media: { ...media(192867, "Android wa Keiken Ninzuu ni Hairimasu ka??", "Does it Count if You Lose Your Innocence to an Android?", [], 8), status: "FINISHED" }, query: "", dub: false }))[0].id
    eq([anId, (await an.findEpisodes(anId)).length], ["g$1$does it count if you lose your innocence to an android$does+it+count+if+you+lose+your+innocence$8", 8], "city count: a finished show lists no episode past its AniList count, though the headroom still lets the group match")
    const pl = mkCity()
    eq([await pick(pl, { ...media(6201, "Princess Lover!", "", [], 12), status: "FINISHED" }), await pick(mkCity(), media(8918, "Princess Lover! OVA", "", ["Kimi to Isshou no Asa"], 2))], [[], [["g$1$princess lover$princess+lover", "Princess Lover! OVA"]]],
        "city count: a 12-episode TV entry never takes its 2-episode OVA's posts (group or box), while the OVA entry still does")
    const n2 = mkCity({ syn: { 1388: ["Night Shift Nurses 2", "Yakin Byoutou 2", "NSN 2"] } })
    eq([await pick(n2, media(1388, "Yakin Byoutou Ni", "", [], 5)), await pick(n2, media(1388, "Yakin Byoutou Ni", "", [], 5)), n2.al], [[["g$2$night shift nurses$night+shift+nurses+2", "Yakin Byoutou Ni"]], [["g$2$night shift nurses$night+shift+nurses+2", "Yakin Byoutou Ni"]], [1388]],
        "city synonyms: AniList's own synonyms (Seanime passes only season-bearing ones) are fetched once per show and find a show known on the site only by a synonym")
    const iv = mkCity()
    eq([await pick(iv, media(3888, "Toumei Ningen", "The Invisible Stud", [], 2)), (await iv.search({ media: { id: 0, synonyms: [], isAdult: false }, query: "the invisible stud", dub: false })).map((r) => r.id)], [[["g$1$invisible stud$the+invisible+stud", "The Invisible Stud"]], ["g$1$invisible stud$the+invisible+stud"]],
        "city titles: a leading 'The' on AniList that the site drops still matches, in auto and manual search")
    eq([await pick(mkCity(), media(3559, "Stringendo", "Stringendo", [], 12)), await pick(mkCity(), media(10420, "Gakuen 3", "", [], 2)), await pick(mkCity(), media(990010, "Gakuen 2", "", [], 2)), await pick(mkCity(), media(990011, "Stringendo", "Stringendo", [], 10))], [
        [["g$1$stringendo private lesson of angels$stringendo", "Stringendo"]], [["g$1$gakuen 3 brilliant insult$gakuen+3", "Gakuen 3"]], [], [],
    ], "city titles: a site title that adds ': subtitle' to the exact AniList title is the show when it is the only such group with every episode; its season must agree and its count must be exact")
    eq([await pick(mkCity(), media(990014, "Lone Show", "", [], 1)), await pick(mkCity(), media(990015, "Anti-Demon Ninja Asagi", "", [], 2))], [[], []],
        "city trap: a franchise title never takes a subtitled entry on its own - not for a one-episode show, and not while a plain franchise group exists (even one the count rules out)")
    const stall = mkCity({ down: true })
    eq([await err(stall.findEpisodeServer({ id: [id("x1", 4), id("x2", 4), id("x3", 4)].join(","), number: 4, url: "" }, "Hentai City")), stall.hits.length], ["hentaicity: episode 4 failed - the site could not be found (DNS)", 2],
        "city errors: when the site does not answer, the other copies of an episode are not tried one by one")
    eq(plain, 0, "city fetch: every request goes out with noCloudflareBypass")
    eq([await err(gone.findEpisodeServer({ id: "../etc", number: 1, url: "" }, "Hentai City")), await gone.findEpisodes("x$y")], ["hentaicity: unrecognized episode id - refresh the episode list", []], "city errors: a malformed id never reaches the site")
}

console.log("hentaihaven")
{
    const CMS = "https://cms.hentaihaven.xxx/wp-json"
    const octo = (uuid) => `https://octopusmanifest.org/${uuid}/playlist.m3u8`
    const lengs = (data) => `https://master-lengs.org/api/v3/hh/${data}/master.m3u8`
    const ch = (id, slug, o = {}) => ({ chapter_id: id, chapter_name: slug, chapter_slug: slug, episode_slug: slug, is_deleted: !!o.del, is_octopus_import: o.legacy ? 0 : 1, video_uuid: o.legacy ? "" : `u${id}`, data_slug: o.legacy || "", indexable_content_url: o.url !== undefined ? o.url : o.legacy ? lengs(o.legacy) : octo(`u${id}`), duration_seconds: 400 })
    const run = (base, n, o = {}) => Array.from({ length: n }, (_, i) => ch(base + i, `episode-${i + 1}`, o))
    const posts = [
        [2131, "overflow", "Overflow", [166]],
        [97163, "overflow-hentai", "Overflow Hentai"],
        [825, "kuroinu", "Kuroinu"],
        [7022, "kuroinu-2-the-animation", "Kuroinu 2 The Animation"],
        [1389, "bible-black", "Bible Black 1"],
        [3409, "enjo-kouhai", "Enjo Kouhai"],
        [7777, "kouhai", "Kouhai"],
        [5410, "boku-no-pico", "Boku no Pico"],
        [4687, "oujo-onna-kishi-w-dogehin-roshutsu-chijoku-no-misemono-dorei", "Oujo &#038; Onna Kishi W Dogehin Roshutsu: Chijoku no Misemono Dorei"],
        [8131, "fault", "Fault!!"],
        [9223, "fault-2", "Fault!!"],
        [6561, "kimekoi-takane-no-hana", "Kimekoi! Takane no Hana"],
        [5555, "lover-in-law-aniyome-wa-ijippari", "Lover in Law / Aniyome wa Ijippari"],
        [99200, "pure-x-holic-junketsu-otome-to-konin-kankei-the-animation", "Pure x Holic: Junketsu Otome to Kon&#8217;in Kankei!? The Animation"],
        [99044, "netorareta-bakunyuu-tsuma-tachi-2", "Netorareta Bakunyuu Tsuma-tachi 2"],
        [97264, "netorareta-bakunyuu-tsuma-tachi", "Netorareta Bakunyuu Tsuma-tachi"],
        [448, "futabu-1", "Futabu 1", [166]],
        [450, "futabu-2", "Watch Futabu 2", [111]],
        [9063, "swing-out-sisters", "Swing Out Sisters", [114]],
        [1318, "itadaki-seieki", "Itadaki Seieki", [166]],
        [97432, "ichigo-aika-zatsu-de-namaiki", "Ichigo Aika: Zatsu de Namaiki &#8230;", [99]],
        [4752, "mou-hasamazu-ni-wa-irarenai", "Mou Hasamazu ni wa Irarenai"],
        [8890, "kowaremono-the-animation", "Kowaremono The Animation", [111]],
        [9017, "kowaremono-risa", "Kowaremono Risa"],
        [9285, "lovely-x-cation-the-animation", "Lovely X Cation The Animation"],
    ].map(([id, slug, title, rel]) => ({ id, slug, title: { rendered: title }, "wp-manga-release": rel || [] }))
    const terms = [{ id: 114, name: "2011" }, { id: 166, name: "2014" }, { id: 111, name: "2015" }, { id: 99, name: "2026" }]
    const filler = Array.from({ length: 100 - posts.length }, (_, i) => ({ id: 60000 + i, slug: `filler-${i}`, title: { rendered: `Filler Show Number ${i + 10}` } }))
    const late = [[2674, "aki-sora-ova", "Aki Sora OVA"], [2677, "aki-sora-in-a-dream", "Aki Sora In a Dream"]].map(([id, slug, title]) => ({ id, slug, title: { rendered: title } }))
    const subMaster = (uuid) => [
        "#EXTM3U", "#EXT-X-VERSION:7",
        '#EXT-X-MEDIA:URI="snd/a.m3u8",TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES',
        '#EXT-X-MEDIA:URI="s/ar.vtt",TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="ar",NAME="Ar",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO',
        '#EXT-X-MEDIA:URI="s/de.vtt",TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="de",NAME="German",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO',
        '#EXT-X-MEDIA:URI="s/en.vtt",TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO',
        `#EXT-X-MEDIA:URI="https://octopusmanifest.org/${uuid}/s/es.vtt",TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="es",NAME="Spanish",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO`,
        '#EXT-X-STREAM-INF:BANDWIDTH=2077570,RESOLUTION=1280x720,CODECS="avc1.4d4028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"', "7sop/v.m3u8",
        '#EXT-X-SESSION-DATA:DATA-ID="hh.octo.thumbnails",URI="t/thumbnails.vtt"',
    ].join("\n")
    const plainMaster = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:URI="snd/a.m3u8",TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=2077570,RESOLUTION=1280x720,AUDIO="audio"\n7sop/v.m3u8\n'
    const legacyMaster = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480\na8Op/index.txt\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\n7sop/index.txt\n#Developed by zarat.dev\n"
    const legacyHosts = { "kuroinu-1": "godriver.top", "kuroinu-2": "eng-madrid.top", "kuroinu-3": "gone.top", "kuroinu-4": "sick.top" }
    const mk = (o = {}) => {
        const store = new Map()
        const calls = []
        const logs = []
        const chapters = {
            2131: run(4086, 8).map((c) => (c.chapter_id === 4088 ? { ...c, indexable_content_url: "" } : c)),
            97163: [ch(97164, "season-1", { legacy: "Overflow-Season-1" })],
            825: run(8251, 6).map((c, i) => ({ ...c, is_octopus_import: 0, video_uuid: "", data_slug: `kuroinu-${i + 1}`, indexable_content_url: lengs(`kuroinu-${i + 1}`) })),
            7022: run(7100, 1),
            1389: [
                ch(10, "episode-3", { legacy: "bb-3" }), ch(11, "episode-1", { legacy: "bb-1" }), ch(12, "episode-2", { legacy: "bb-2" }), ch(13, "episode-2"), ch(14, "episode-2", { legacy: "bb-2b" }),
                ch(15, "episode-4", { legacy: "bb-4", del: true }), ch(16, "episode-4", { legacy: "bb-4" }), ch(9, "episode-5", { legacy: "bb-5a" }), ch(17, "episode-5", { legacy: "bb-5" }), ch(18, "episode-6", { legacy: "bb-6" }),
                ch(19, "bonus"), ch(20, "episode-3-directors-cut-edition"), ch(21, "episodes-1-3"), ch(22, "epsiode-7"), ch(23, "episode-1-bonus"), ch(24, "christmas-extra"), ch(25, "episode-0"), ch(26, "episode-7", { del: true }),
            ],
            3409: [ch(3401, "episode-1"), ch(3402, "episode-2"), ch(3404, "episode-4")],
            7777: run(7778, 1),
            5410: run(5411, 3, { legacy: "pico" }),
            4687: [],
            8131: run(8132, 2),
            9223: run(9224, 3),
            6561: run(6562, 2),
            5555: run(5556, 2),
            99200: run(99201, 2),
            99044: run(99045, 2),
            97264: run(97265, 2),
            448: run(4481, 2),
            450: run(4501, 2),
            9063: run(9064, 1),
            1318: [ch(1319, "episode-1"), ch(1320, "episode-1-bonus")],
            97432: run(97433, 11),
            4752: [ch(1092, "episode-1"), ch(1298, "episode-1-bonus")],
            8890: run(8891, 1),
            9017: run(9018, 1),
            9285: run(9286, 2),
            8119: [ch(2097, "episode", { legacy: "yabai-1" }), ch(2098, "episode-2", { legacy: "yabai-2" })],
            97438: [ch(3071, "episode-1"), ch(3072, "episode-2"), ch(3326, "episode-3"), ch(3337, "epsiode-4")],
            5294: [ch(1328, "episode-1-uncensored", { legacy: "kunoichi-1" })],
            2674: run(2675, 1),
            2677: run(2678, 2),
            555: [{ id: 1, name: "Episode 1" }],
            557: "503",
            558: "403",
            559: "down",
            556: "noroute",
        }
        const reply = (body, status = 200, headers = {}) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers, url: "", text: () => (typeof body === "string" ? body : JSON.stringify(body)), json: () => (typeof body === "string" ? JSON.parse(body) : body) })
        const dns = (url, host) => Promise.reject(new Error(`${o.method || "Get"} "${url}": dial tcp: lookup ${host}: no such host`))
        const prov = load("hentaihaven", {
            console: { log() {}, info() {}, warn: (s) => logs.push("warn " + s), error: (s) => logs.push("error " + s) },
            $store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), has: (k) => store.has(k) },
            fetch: (url, init = {}) => {
                const method = init.method || "GET"
                calls.push({ method, url, bypass: init.noCloudflareBypass, ua: !!(init.headers && init.headers["User-Agent"]) })
                if (/^https:\/\/cms\.hentaihaven\.xxx\/wp-json\/wp\/v2\/wp-manga-release\?per_page=100&_fields=id,name$/.test(url)) {
                    if (o.down) return dns(url, "cms.hentaihaven.xxx")
                    if (o.wall) return reply("<html>Just a moment...</html>", 403, { "Cf-Mitigated": "challenge" })
                    return o.noterms ? reply({ code: "rest_no_route" }, 404) : reply(terms)
                }
                const cat = /^https:\/\/cms\.hentaihaven\.xxx\/wp-json\/wp\/v2\/wp-manga\?per_page=100&page=(\d+)&_fields=id,slug,title,wp-manga-release$/.exec(url)
                if (cat) {
                    if (o.down) return dns(url, "cms.hentaihaven.xxx")
                    if (o.shape) return reply({ items: [] })
                    if (o.wall) return reply("<html>Just a moment...</html>", 403, { "Cf-Mitigated": "challenge" })
                    return reply(cat[1] === "1" ? (o.extra || []).concat(posts, filler).slice(0, 100) : cat[1] === "2" ? late : { code: "rest_post_invalid_page_number" }, +cat[1] > 2 ? 400 : 200)
                }
                const m = /^https:\/\/cms\.hentaihaven\.xxx\/wp-json\/hhaven\/v1\/manga\/(\d+)\/chapters$/.exec(url)
                if (m) {
                    const c = chapters[m[1]]
                    if (c === "503") return reply({ code: "x" }, 503)
                    if (c === "403") return reply("<html></html>", 403, { "Cf-Mitigated": "challenge" })
                    if (c === "down") return dns(url, "cms.hentaihaven.xxx")
                    if (c === "noroute") return reply({ code: "rest_no_route", message: "No route was found matching the URL and request method.", data: { status: 404 } }, 404)
                    return c ? reply(c) : reply({ code: "manga_not_found", message: "Manga post was not found." }, 404)
                }
                if (/^https:\/\/octopusmanifest\.org\/u4086\/playlist\.m3u8$/.test(url)) return reply(subMaster("u4086"))
                if (/^https:\/\/octopusmanifest\.org\/u4090\/playlist\.m3u8$/.test(url)) return reply("<html>bad gateway</html>", 503)
                if (/^https:\/\/octopusmanifest\.org\/[\w-]+\/playlist\.m3u8$/.test(url)) return reply(plainMaster)
                const lm = /^https:\/\/master-lengs\.org\/api\/v3\/hh\/([\w-]+)\/master\.m3u8$/.exec(url)
                if (lm) return lm[1] === "kuroinu-5" ? reply("<html>oops</html>") : lm[1] === "kuroinu-6" ? reply("not found", 404) : reply(legacyMaster)
                const lv = /^https:\/\/master-lengs\.org\/api\/v3\/hh\/([\w-]+)\/a8Op\/index\.txt$/.exec(url)
                if (lv) return reply(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.800000,\nhttps://${legacyHosts[lv[1]] || "godriver.top"}/theme/hnt/${lv[1]}/a8Op/d_000.html\n#EXTINF:3.2,\nhttps://x.top/d_001.html\n`)
                const seg = /^https:\/\/([\w.-]+)\/theme\/hnt\//.exec(url)
                if (seg) {
                    if (method !== "HEAD") return reply("TS BYTES", 200)
                    if (seg[1] === "eng-madrid.top") return Promise.reject(new Error(`Head "${url}": dial tcp: lookup eng-madrid.top: no such host`))
                    if (seg[1] === "gone.top") return reply("", 404)
                    if (seg[1] === "sick.top") return reply("", 503)
                    return reply("", 200, { "Content-Type": "text/html" })
                }
                return reply("nope", 404)
            },
        })
        prov.calls = calls
        prov.logs = logs
        prov.store = store
        prov.chapters = chapters
        return prov
    }
    const media = (id, romaji, o = {}) => ({ id, idMal: 0, romajiTitle: romaji, englishTitle: o.en || "", synonyms: o.syn || [], episodeCount: o.eps === undefined ? 0 : o.eps, startDate: { year: o.year || 2020 }, isAdult: true })
    const err = (p) => p.then(() => "no error", (e) => String(e))
    const pick = async (prov, m) => (await prov.search({ media: m, query: m.romajiTitle, dub: false })).map((r) => r.id)
    const hh = mk()

    const overflow = await hh.search({ media: media(113417, "Overflow", { en: "Overflow", eps: 8 }), query: "Overflow", dub: false })
    eq(overflow, [{ id: "2131$overflow", title: "Overflow", url: "https://hentaihaven.xxx/watch/overflow/", subOrDub: "sub" }], "hh: the exact title wins, and the Hentai-suffixed post holding only a season compilation is skipped")
    eq([hh.calls.filter((c) => c.url.indexOf("/wp/v2/wp-manga?") !== -1).map((c) => /&page=(\d+)/.exec(c.url)[1]), hh.calls.filter((c) => c.url.indexOf("/wp-manga-release?") !== -1).length], [["1", "2"], 1], "hh: the catalog is read page by page until a short page, with the release years once")
    eq([
        await pick(hh, media(132209, "Kuroinu II THE ANIMATION", { eps: 1 })),
        await pick(hh, media(213067, "Netorareta Bakunyuu Tsuma-tachi 2", { eps: 2 })),
        await pick(hh, media(999001, "Enjo Kouhai 2nd Season")),
        await pick(hh, media(999002, "Boku no Pico 2", { eps: 1 })),
    ], [["7022$kuroinu-2-the-animation"], ["99044$netorareta-bakunyuu-tsuma-tachi-2"], [], []],
        "hh: the sequel number must agree - II is 2, and a sequel the site lacks never falls back to the first season")
    eq([
        await pick(hh, media(11827, "Kuroinu: Kedakaki Seijo wa Hakudaku ni Somaru", { en: "Kuroinu ～The proud saint is stained with white filth～", eps: 6 })),
        await pick(hh, media(11827, "Kuroinu: Kedakaki Seijo wa Hakudaku ni Somaru", { eps: 4 })),
        await pick(hh, media(11827, "Kuroinu: Kedakaki Seijo wa Hakudaku ni Somaru", { eps: -1 })),
    ], [["825$kuroinu"], [], ["825$kuroinu"]],
        "hh: a site title that is only the part before ':' needs the AniList episode count to agree when AniList has one (Seanime sends -1 for none)")
    eq([
        await pick(hh, media(112936, "○○ Kouhai", { syn: ["援助交配", "Enjo Kouhai", "Assisted Mating"], eps: -1 })),
        await pick(hh, media(112936, "○○ Kouhai")),
    ], [["3409$enjo-kouhai"], []], "hh: a placeholder romaji is skipped for its synonym and never matches the decoy post named Kouhai")
    eq([
        await pick(hh, media(8577, "Aki-Sora: Yume no Naka", { en: "Aki Sora", eps: 2 })),
        await pick(hh, media(8577, "Aki-Sora: Yume no Naka", { en: "Aki Sora", eps: 2, syn: ["Akisora: Yume no Naka", "Aki-Sora: In a Dream"] })),
        await pick(hh, media(6987, "Aki-Sora", { eps: 1 })),
        await pick(hh, media(1401, "Shin Bible Black", { en: "Bible Black: New Testement", eps: 6 })),
        await pick(hh, media(368, "Bible Black", { eps: 6 })),
        await pick(hh, media(5391, "Pico to Chico", { syn: ["Boku no Piko OVA 2", "Boku no Pico", "Pico & Chico"], eps: 1 })),
        await pick(hh, media(1639, "Boku no Pico", { eps: 1 })),
    ], [[], ["2677$aki-sora-in-a-dream"], ["2674$aki-sora-ova"], [], ["1389$bible-black"], [], ["5410$boku-no-pico"]],
        "hh: traps - an English title that is just the first season's name, an English subtitle the romaji lacks, and a synonym naming another entry all miss instead of landing on the wrong post")
    eq([
        await pick(hh, media(7053, "Fault!!", { eps: 3 })),
        await pick(hh, media(7053, "Fault!!")),
        await pick(hh, media(99556, "Kimekoi! Takane no Hana to Osananajimi ga Kimatta Riyuu", { eps: 2 })),
        await pick(hh, media(99556, "Kimekoi! Takane no Hana to Osananajimi ga Kimatta Riyuu", { eps: 3 })),
        await pick(hh, media(4358, "Aniyome wa Ijippari", { eps: 2 })),
        await pick(hh, media(212574, "Pure x Holic: Junketsu Otome to Kon’in Kankei!? The Animation", { eps: 2 })),
        await pick(hh, media(99999, "Oujo & Onna Kishi W Dogehin Roshutsu: Chijoku no Misemono Dorei", { eps: 1 })),
    ], [["9223$fault-2"], [], ["6561$kimekoi-takane-no-hana"], [], ["5555$lover-in-law-aniyome-wa-ijippari"], ["99200$pure-x-holic-junketsu-otome-to-konin-kankei-the-animation"], []],
        "hh: two same-named posts are told apart by the episode count or not at all, a truncated site title needs the count, a ' / ' title matches either half, entities and apostrophes fold away, and a post with no episodes is skipped")
    eq([
        await pick(hh, media(21076, "Futabu!!", { eps: 2, year: 2015 })),
        await pick(hh, media(21062, "Futabu!", { eps: 2, year: 2014 })),
        await pick(hh, media(20934, "Swing Out Sisters (2014)", { eps: 1, year: 2014 })),
        await pick(hh, media(12143, "Swing Out Sisters", { eps: 1, year: 2011 })),
        await pick(hh, media(21358, "Itadaki! Seieki♥ Special", { eps: 1, year: 2014 })),
        await pick(hh, media(21067, "Itadaki! Seieki♥", { eps: 1, year: 2014 })),
    ], [[], ["448$futabu-1"], [], ["9063$swing-out-sisters"], [], ["1318$itadaki-seieki"]],
        "hh: a site title marked 1 must share the release year, an AniList (YYYY) tag is kept, and a Special never falls onto the main post through a prefix")
    eq([
        await pick(hh, media(198767, "Ichigo Aika: Zatsu de Namaiki na Imouto to Warikirenai Ani", { en: "Ichigo Aika: Strawberry Elegy", eps: 12, year: 2026 })),
        await pick(hh, media(198767, "Ichigo Aika: Zatsu de Namaiki na Imouto to Warikirenai Ani", { en: "Ichigo Aika: Strawberry Elegy", eps: 10, year: 2026 })),
    ], [["97432$ichigo-aika-zatsu-de-namaiki"], []], "hh: a title the site cut off with an ellipsis may hold fewer episodes than AniList, never more")
    eq([
        await pick(hh, media(108983, "Mou Hasamazu ni wa Irarenai: Hoshi ni Onegai Shitara Konna ni Okkiku Nacchatta! Bonus", { eps: 1, year: 2014 })),
        await pick(hh, media(21542, "Mou Hasamazu ni wa Irarenai: Hoshi ni Onegai Shitara Konna ni Okkiku Nacchatta!", { eps: 1, year: 2014 })),
        await pick(hh, media(97621, "Kowaremono: Risa PLUS THE ANIMATION", { eps: 1, year: 2016 })),
        await pick(hh, media(21466, "Kowaremono THE ANIMATION", { eps: 1, year: 2015 })),
        await pick(hh, media(21547, "LOVELY×CATION THE ANIMATION", { eps: 2 })),
    ], [[], ["4752$mou-hasamazu-ni-wa-irarenai"], [], ["8890$kowaremono-the-animation"], ["9285$lovely-x-cation-the-animation"]],
        "hh traps: a bonus or special never takes its main OVA through the short title, a 'PLUS' entry takes neither its sibling nor a post of another year, and × matches the site's plain x")
    const catalogHits = hh.calls.filter((c) => c.url.indexOf("/wp/v2/wp-manga") !== -1).length
    eq([await hh.search({ media: media(113417, "Overflow"), query: "Overflow", dub: true }), catalogHits], [[], 3], "hh: dub finds nothing and the catalog is fetched once for all searches")
    const before = hh.calls.length
    eq([await pick(hh, media(1, "")), await pick(hh, media(2, "○○ Senpai")), hh.calls.length - before], [[], [], 0], "hh: a media with no usable title returns nothing without a request")
    eq([
        (await hh.search({ media: media(0, ""), query: "kuroinu", dub: false })).map((r) => r.id),
        (await hh.search({ media: media(0, ""), query: "oujo", dub: false })).map((r) => r.title),
        (await hh.search({ media: media(0, ""), query: "fault", dub: false })).map((r) => [r.id, r.title]),
    ], [["825$kuroinu", "7022$kuroinu-2-the-animation"], ["Oujo & Onna Kishi W Dogehin Roshutsu: Chijoku no Misemono Dorei"], [["8131$fault", "Fault!! (fault)"], ["9223$fault-2", "Fault!! (fault-2)"]]],
        "hh: a manual query lists every post containing it, the exact title first, with entities decoded and same-titled posts told apart by slug")
    eq(await pick(mk({ noterms: true }), media(113417, "Overflow", { eps: 8 })), ["2131$overflow"], "hh: a missing release-year list only turns the year check off")

    const fresh = mk({ extra: [{ id: 99300, slug: "brand-new-show", title: { rendered: "Brand New Show" } }] })
    fresh.store.set("hentaihaven:catalog", { at: Date.now() - 60000, top: Date.now() - 11 * 60000, data: posts.concat(late).map((p) => ({ id: p.id, slug: p.slug, title: p.title.rendered })) })
    fresh.chapters[99300] = run(99301, 2)
    eq([await pick(fresh, media(300001, "Brand New Show")), fresh.calls.filter((c) => c.url.indexOf("/wp/v2/wp-manga") !== -1).map((c) => /&page=(\d+)/.exec(c.url)[1]), fresh.store.get("hentaihaven:catalog").data.length],
        [["99300$brand-new-show"], ["1"], 102], "hh: a miss on a cached catalog re-reads only the newest page and merges it in, without the release years")

    eq((await hh.findEpisodes("1389$bible-black")).map((e) => [e.number, e.id]), [[1, "1389$11"], [2, "1389$13"], [3, "1389$10"], [4, "1389$16"], [5, "1389$17"], [6, "1389$18"], [7, "1389$22"]],
        "hh: episodes are sorted by their episode-N slug; deleted rows, bonus clips, director's cuts, bundles and episode-0 are dropped; the epsiode-N typo counts; a re-upload keeps the new-player copy, then the newest")
    eq([(await hh.findEpisodes("8119$yabai")).map((e) => [e.number, e.id]), (await hh.findEpisodes("97438$kegareboshi")).map((e) => e.number), (await hh.findEpisodes("5294$kunoichi")).map((e) => [e.number, e.id])],
        [[[1, "8119$2097"], [2, "8119$2098"]], [1, 2, 3, 4], [[1, "5294$1328"]]], "hh: a bare 'episode' slug is episode 1, and the epsiode-N typo and an -uncensored suffix keep their number")
    eq([(await hh.findEpisodes("3409$enjo-kouhai")).map((e) => [e.number, e.url]), await hh.findEpisodes("4687$x")], [[[1, "https://hentaihaven.xxx/watch/enjo-kouhai/episode-1/"], [2, "https://hentaihaven.xxx/watch/enjo-kouhai/episode-2/"], [4, "https://hentaihaven.xxx/watch/enjo-kouhai/episode-4/"]], []],
        "hh: gaps stay gaps and a post with no chapters lists nothing")

    const srv = await hh.findEpisodeServer({ id: "2131$4086", number: 1, url: "" }, "Hentai Haven")
    eq([srv.server, srv.headers, srv.videoSources.map((v) => [v.url, v.type, v.quality]), srv.videoSources[0].subtitles], ["Hentai Haven", {}, [["https://octopusmanifest.org/u4086/playlist.m3u8", "m3u8", "auto"]], [
        { id: "en", url: "https://octopusmanifest.org/u4086/s/en.vtt", language: "English", isDefault: true },
        { id: "ar", url: "https://octopusmanifest.org/u4086/s/ar.vtt", language: "Arabic", isDefault: false },
        { id: "de", url: "https://octopusmanifest.org/u4086/s/de.vtt", language: "German", isDefault: false },
        { id: "es", url: "https://octopusmanifest.org/u4086/s/es.vtt", language: "Spanish", isDefault: false },
    ]], "hh: a new-player episode plays its unsigned master directly with no headers, and its VTT tracks are passed through with English first as the default")
    eq((await hh.findEpisodeServer({ id: "2131$4087", number: 2, url: "" }, "Hentai Haven")).videoSources[0].subtitles, [], "hh: an older import with burned-in subtitles has no tracks")
    const live = await hh.findEpisodeServer({ id: "825$8251", number: 1, url: "" }, "Hentai Haven")
    eq([live.headers, live.videoSources[0].url, live.videoSources[0].type, hh.calls.filter((c) => c.url.indexOf("/theme/hnt/") !== -1).map((c) => c.method + " " + c.url)],
        [{}, "https://master-lengs.org/api/v3/hh/kuroinu-1/master.m3u8", "m3u8", ["HEAD https://godriver.top/theme/hnt/kuroinu-1/a8Op/d_000.html"]],
        "hh: an old-player episode is checked by a HEAD on its first segment (never a GET) and then plays its master directly")
    hh.chapters[825] = hh.chapters[825].map((c) => (c.chapter_id === 8251 ? { ...c, is_octopus_import: 1, video_uuid: "m1", indexable_content_url: octo("m1") } : c))
    eq((await hh.findEpisodeServer({ id: "825$8251", number: 1, url: "" }, "Hentai Haven")).videoSources[0].url, "https://octopusmanifest.org/m1/playlist.m3u8", "hh: the stream link is read fresh, so an episode moved to the new player overnight plays from there")
    const logsBefore = hh.logs.length
    eq([
        await err(hh.findEpisodeServer({ id: "825$8252", number: 2, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "825$8253", number: 3, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "825$8256", number: 6, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "2131$9999", number: 9, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodes("424242$gone")),
    ], [
        "Hentai Haven: episode 2 is still on the site's old mirror eng-madrid.top, which is offline (could not be found in DNS) - it should play again once the site moves it to its new player",
        "Hentai Haven: episode 3 is still on the site's old mirror gone.top, which no longer has it (HTTP 404) - it should play again once the site moves it to its new player",
        "Hentai Haven: episode 6 is still on the site's old mirror master-lengs.org, which no longer has it (HTTP 404) - it should play again once the site moves it to its new player",
        "Hentai Haven: episode 9 is no longer on the site - refresh the episode list",
        "Hentai Haven: this series is no longer on the site - match it again",
    ], "hh: a dead old mirror, a segment or master the old mirror lost, a delisted or deleted episode and a removed series are each named")
    eq(hh.logs.slice(logsBefore).map((l) => /^warn SEHERRv1 .*"ext":"aq-hentaihaven".*"lvl":"info"/.test(l)), [true, true, true, true, true], "hh: those expected misses are notices, not errors")
    eq((await hh.findEpisodeServer({ id: "1389$15", number: 4, url: "" }, "Hentai Haven")).videoSources[0].url, "https://master-lengs.org/api/v3/hh/bb-4/master.m3u8",
        "hh: an episode id from before the site re-uploaded the episode (Seanime keeps episode lists a day) still plays, found again by its number")
    const logsMid = hh.logs.length
    eq([
        await err(hh.findEpisodeServer({ id: "825$8254", number: 4, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "825$8255", number: 5, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "2131$4090", number: 5, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "2131$4088", number: 3, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "557$1", number: 1, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "558$1", number: 1, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodeServer({ id: "559$1", number: 1, url: "" }, "Hentai Haven")),
        await err(hh.findEpisodes("555$x")),
        await err(hh.findEpisodes("556$x")),
        await err(hh.findEpisodes("not-a-post")),
        await err(hh.findEpisodeServer({ id: "2131", number: 1, url: "" }, "Hentai Haven")),
    ], [
        "Hentai Haven: could not check episode 4's old mirror - sick.top answered HTTP 503",
        "Hentai Haven: episode 5's stream on master-lengs.org is not a playlist",
        "Hentai Haven: could not load episode 5's stream - octopusmanifest.org answered (HTTP 503)",
        "Hentai Haven: the site changed how it serves stream links - this extension needs an update",
        "Hentai Haven: could not load the episode list - cms.hentaihaven.xxx answered (HTTP 503)",
        "Hentai Haven: could not load the episode list - cms.hentaihaven.xxx put up a Cloudflare challenge (HTTP 403)",
        "Hentai Haven: could not load the episode list - cms.hentaihaven.xxx could not be found in DNS",
        "Hentai Haven: the site changed how it serves the episode list - this extension needs an update",
        "Hentai Haven: the site changed how it serves the episode list - this extension needs an update",
        "Hentai Haven: unrecognized series id - match the series again",
        "Hentai Haven: unrecognized episode id - refresh the episode list",
    ], "hh: a sick mirror, a non-playlist answer, an HTTP error, a changed stream field, a Cloudflare wall, an unreachable site, a changed or removed API route and a bad id each say what failed")
    eq(hh.logs.slice(logsMid).map((l) => /^error SEHERRv1 /.test(l) && l.indexOf("lvl") === -1), Array(11).fill(true), "hh: real failures are reported as errors")
    eq([
        await err(mk({ down: true }).search({ media: media(113417, "Overflow"), query: "", dub: false })),
        await err(mk({ shape: true }).search({ media: media(113417, "Overflow"), query: "", dub: false })),
        await err(mk({ wall: true }).search({ media: media(0, ""), query: "overflow", dub: false })),
    ], [
        "Hentai Haven: could not load the catalog - cms.hentaihaven.xxx could not be found in DNS",
        "Hentai Haven: the site changed how it serves the catalog - this extension needs an update",
        "Hentai Haven: could not load the catalog - cms.hentaihaven.xxx put up a Cloudflare challenge (HTTP 403)",
    ], "hh: search names an unreachable site, a changed catalog and a Cloudflare wall")
    eq([hh.calls.length > 30, hh.calls.every((c) => c.bypass === true && c.ua), hh.logs.some((l) => /captcha/i.test(l)), hh.getSettings()], [true, true, false, { episodeServers: ["Hentai Haven"], supportsDub: false }],
        "hh: every request uses the plain client with a User-Agent, and the one server is named after the site with no dub")
}

console.log("error channel")
{
    const out = []
    const cap = { console: { log() {}, info() {}, warn: (s) => out.push("warn " + s), error: (s) => out.push(String(s)) } }
    load("animelok", cap).fail("server", "c")
    load("animelok", cap).fail("server", "d", "info")
    eq(out.map((s) => s.replace(/"t":\d+/, "")), ['SEHERRv1 {,"ext":"aq-animelok","scope":"server","msg":"c"}', 'warn SEHERRv1 {,"ext":"aq-animelok","scope":"server","msg":"d","lvl":"info"}'], "lvl: an error goes to console.error with no lvl field; a notice carries its level and goes to console.warn")
    const sites = (name) => { const src = fs.readFileSync(`${ROOT}/extensions/${name}/provider.ts`, "utf8"); return [(src.match(/, "warn"\)/g) || []).length, (src.match(/, "info"\)/g) || []).length] }
    eq(["animelok", "animepahe"].map(sites), [[0, 1], [0, 0]], "lvl: only the listed recovered and expected reports are relabelled")
}

console.log("configuration")
{
    const prefs = (map) => ({ $getUserPreference: (n) => map[n] })
    const DEFAULTS = { animepahe: "https://animepahe.pw", animelok: "https://animelok.cc" }
    for (const name in DEFAULTS) {
        eq(load(name).baseUrl, DEFAULTS[name], `config: ${name} falls back to the manifest default when nothing is set`)
        eq(load(name, prefs({ baseUrl: "{{baseUrl}}" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an unsubstituted placeholder`)
        eq(load(name, prefs({ baseUrl: "" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an empty setting`)
    }
    eq(["https://animelok.online", "https://animelok.live/"].map((b) => load("animelok", prefs({ baseUrl: b })).base), ["https://animelok.cc", "https://animelok.cc"], "config: a legacy animelok domain is remapped once at construction")
    eq(load("animepahe", prefs({ solverUrl: "localhost:8191" })).solverEndpoint(), "", "config: animepahe rejects a schemeless solver URL")
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
    const list = (kind, file) => (fs.existsSync(`${ROOT}/${kind}`) ? fs.readdirSync(`${ROOT}/${kind}`).map((d) => `${kind}/${d}/${file}`) : [])
    const payloads = list("extensions", "provider.ts").concat(list("plugins", "plugin.ts"))
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
console.log(`${checks} checks passed`)
