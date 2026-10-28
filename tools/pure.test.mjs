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
    const p = load("animelok")
    eq(p.subCode("eng", ""), "en", "lang: a three letter code normalises")
    eq(p.subCode("", "Spanish"), "es", "lang: a label-only track still resolves")
    eq(p.subCode("en", "English"), "en", "lang: a two letter code passes through")
    eq(p.trackScore("English", true, false, false) > p.trackScore("English (Signs & Songs)", true, true, true), true, "track: full dialogue beats a default signs track")
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
    const DEFAULTS = { animepahe: "https://animepahe.pw", animelok: "https://animelok.live" }
    for (const name in DEFAULTS) {
        eq(load(name).baseUrl, DEFAULTS[name], `config: ${name} falls back to the manifest default when nothing is set`)
        eq(load(name, prefs({ baseUrl: "{{baseUrl}}" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an unsubstituted placeholder`)
        eq(load(name, prefs({ baseUrl: "" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an empty setting`)
    }
    eq(load("animelok", prefs({ baseUrl: "https://animelok.online" })).base, "https://animelok.live", "config: a legacy animelok domain is remapped once at construction")
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
