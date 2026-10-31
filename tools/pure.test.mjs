import fs from "fs"
import { fileURLToPath } from "url"
import esbuild from "esbuild"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

let failures = 0
let checks = 0

function eq(actual, expected, what) {
    checks++
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) {
        failures++
        console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`)
    }
}

const compiled = {}
const compile = (src) => compiled[src] || (compiled[src] = esbuild.transformSync(fs.readFileSync(src, "utf8"), { loader: "ts", target: "es2018", minifyWhitespace: true, minifySyntax: true }).code)

const store = (mem) => ({ get: (k) => mem[k], set: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)) }, remove: (k) => { delete mem[k] }, has: (k) => k in mem })
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => (typeof body === "string" ? body : JSON.stringify(body)), json: () => (typeof body === "string" ? JSON.parse(body) : body) })

function load(name, overrides) {
    const js = compile(`${ROOT}/extensions/${name}/provider.ts`)
    const boom = (who) => () => { throw new Error(`pure test touched ${who}`) }
    const g = Object.assign({
        fetch: boom("fetch"),
        LoadDoc: boom("LoadDoc"),
        $getUserPreference: () => undefined,
        $store: { get: () => undefined, set: () => {}, remove: () => {}, has: () => false },
        $scannerUtils: { normalizeTitle: () => null, buildSmartSearchTitles: () => null },
        $toBytes: (s) => new Uint8Array(Buffer.from(String(s), "utf8")),
        CryptoJS: {},
        console: { log() {}, info() {}, warn() {}, error() {} },
    }, overrides)
    const Provider = new Function(...Object.keys(g), `${js}\nreturn Provider`)(...Object.values(g))
    return new Provider()
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
    const rlErr = await rl.findEpisodes("https://anikototv.to/watch/show-1$sub").catch((e) => e)
    eq([limited, rlErr], [1, "anikoto: too many requests right now - wait a minute and retry"], "episodes: a rate-limited site is asked once, not again through every mirror, and says so")

    const r429 = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: {}, text: () => (typeof body === "string" ? body : JSON.stringify(body)), json: () => (typeof body === "string" ? JSON.parse(body) : body) })
    const kept = load("anikoto", {
        fetch: (url) => {
            if (url.indexOf("/ajax/server?get=L2") !== -1) return r429(429, "")
            if (url.endsWith("master.m3u8")) return r429(200, "#EXTM3U\nseg-1.ts\n")
            if (url.endsWith("seg-1.ts")) return r429(206, "G@\x00\x10")
            return r429(404, "")
        },
    })
    kept.serverListDoc = async () => null
    kept.collectServers = () => [{ name: "HD-2", linkId: "L1" }, { name: "HD-1", linkId: "L2" }]
    const keptSources = kept.fetchSources
    kept.fetchSources = function (id) { return id === "L1" ? Promise.resolve({ origin: "https://c.cdn", file: "https://c.cdn/a/master.m3u8", embedAudio: "", tracks: [] }) : keptSources.call(this, id) }
    eq(await kept.findEpisodeServer({ id: "1,2$sub", number: 1, url: "" }, "Auto").then((s) => s.videoSources[0].url, (e) => e), "https://c.cdn/a/master.m3u8", "server: a 429 on a later candidate keeps the playable server already found")

    const found = load("anikoto", {
        $scannerUtils: { normalizeTitle: () => null, buildSmartSearchTitles: () => ({ titles: ["Show A", "Show A Alt"] }) },
        LoadDoc: () => (sel) => ({ length: () => (sel === "footer" ? 1 : 0), children: () => ({ length: () => 0 }) }),
        fetch: (url) => (url.indexOf("keyword=Show%20A%20Alt") !== -1 ? r429(429, "") : r429(200, "<footer></footer>")),
    })
    found.parseSearchInto = function (doc, audio, wantDub, seen, results) {
        if (results.length === 0) results.push({ id: "https://anikototv.to/watch/show-a$sub", title: "Show A", url: "https://anikototv.to/watch/show-a", subOrDub: "sub" })
        return 1
    }
    eq(await found.search({ query: "Show A", dub: false, media: { id: 1, romajiTitle: "Show A", englishTitle: "", episodeCount: 12, format: "TV" } }).then((rs) => rs.map((r) => r.id), (e) => e), ["https://anikototv.to/watch/show-a$sub"], "search: a 429 on a later query keeps what the earlier queries found")

    eq(p.cleanLabel("English"), "English", "label: plain title is untouched")
    eq(p.cleanLabel("English (- (Crunchyroll))"), "English (Crunchyroll)", "label: keeps the group")
    eq(p.cleanLabel("German (- Deutsch)"), "German", "label: drops a bare native name")
    eq(p.cleanLabel("Spanish (- Espanol (LA))"), "Spanish (LA)", "label: keeps the region")

    eq(p.isEnglish("English"), true, "lang: english is English")
    eq(p.isEnglish("Danish"), false, "lang: danish is not English")
    eq(p.isEnglish("Klingon"), false, "lang: an unknown language is not English")

    eq(p.buildSubtitles([{ file: "https://c/ara.vtt", label: "Arabic" }, { file: "https://c/eng.vtt", label: "Eng_sub" }]).map((s) => [s.url, s.isDefault]), [["https://c/eng.vtt", true], ["https://c/ara.vtt", false]], "subs: the English track leads and is the default even when the site lists it second")
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
    const { ok } = await p.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url: "https://c.cdn/a/master.m3u8", type: "m3u8", quality: "default", subtitles: [] }] })
    eq(ok, true, "budget: a stream whose master loaded is kept when the clock runs out before the variants are checked")

    const q = load("anikoto", {
        fetch: (url) => {
            if (url.indexOf("master") !== -1) return Promise.resolve({ ok: true, status: 200, text: () => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv2.m3u8\n" })
            q.deadline = 1
            return Promise.reject(new Error("i/o timeout"))
        },
    })
    eq((await q.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url: "https://c.cdn/a/master.m3u8", type: "m3u8", quality: "default", subtitles: [] }] })).ok, false, "budget: a stream whose first variant just failed is not kept because the clock ran out")

    const learned = []
    const lp = load("anikoto", {
        $store: { get: () => undefined, set: (k, v) => { if (k === "anikoto:cdnhosts") learned.push(v.data[0]) }, remove() {}, has: () => false },
        fetch: () => Promise.resolve({ ok: true, status: 200, text: () => "#EXTM3U\n" }),
    })
    for (const url of ["https://megap.x.top/0a4afc550434c2fa75a83a3fbdb408d0/b/master.m3u8", "https://fetch.y.top/anime/a/b/master.m3u8"]) {
        await lp.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url, type: "m3u8", quality: "default", subtitles: [] }] })
    }
    eq(learned, ["fetch.y.top"], "cdn: only hosts with the /anime/ layout are learned as subtitle and failover hosts")

    const wrappedAs = async (seg, head) => {
        const asked = []
        const wp = load("anikoto", {
            fetch: (url) => {
                asked.push(url)
                const body = url.indexOf("master") !== -1 ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n" : url.indexOf("index") !== -1 ? "#EXTM3U\n#EXTINF:4.0,\n" + seg + "\n" : head
                return Promise.resolve({ ok: true, status: 200, text: () => body })
            },
        })
        const { ok, wrapped } = await wp.isPlayable({ server: "Auto", headers: {}, videoSources: [{ url: "https://c.cdn/a/master.m3u8", type: "m3u8", quality: "default", subtitles: [] }] })
        return [ok, wrapped, asked[2]]
    }
    eq([await wrappedAs("seg-1.jpg", "�PNG\r\n\x1a\n"), await wrappedAs("/s/seg-1.jpg", "G@\x00\x10"), await wrappedAs("https://img.cdn/x.image?sig=1", "�PNG\r\n\x1a\n")],
        [[true, true, "https://c.cdn/a/v/seg-1.jpg"], [true, false, "https://c.cdn/s/seg-1.jpg"], [true, true, "https://img.cdn/x.image?sig=1"]],
        "segments: a stream whose first segment is a PNG-wrapped TS is flagged, a plain TS is not, and the segment URL resolves relative, root-relative and absolute")
    const heads = ["����\0\x10JF", "GIF89a\x01\0", "<html><h", "\0\0\0\x18styp", "\0\0��moof", "ID3\x04\0\0\0\0"]
    eq((await Promise.all(heads.map((h) => wrappedAs("s.ts", h)))).map((r) => r[1]), [true, true, true, false, false, false],
        "segments: JPEG, GIF and HTML heads are flagged as disguised; fMP4 boxes and ID3 packed audio are not")
    eq((await wrappedAs("#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:4.0,\ns.ts", "�PNG\r\n\x1a\n"))[1], false, "segments: encrypted streams are not probed")
}

console.log("anikoto: enc resolve cost")
{
    const EMBED = "https://megaplay.buzz/stream/s-2/1/sub?s=bcdn"
    const fetched = []
    const p = load("anikoto", {
        LoadDoc: () => () => ({ first: () => ({ attr: () => "", text: () => "" }), length: () => 0, each: () => {}, find: () => ({ first: () => ({ text: () => "" }) }) }),
        CryptoJS: { AES: { decrypt: () => ({ toString: () => JSON.stringify({ file: "https://cdn.test/a/master.m3u8" }) }) }, enc: { Utf8: 1 } },
        fetch: (url) => {
            fetched.push(url)
            if (url.indexOf("/ajax/server?get=") !== -1) return reply(200, { status: 200, result: { url: EMBED } })
            if (url === EMBED) return reply(200, '<div id="megaplay-player" data-id="177919"></div><script src="/lib/newclient.min.js"></script>')
            if (url.indexOf("getSources") !== -1) return reply(200, { tracks: [], enc: "AAAA" })
            return reply(404, "")
        },
    })

    const got = await p.fetchSources("L1")
    eq(got && got.file, "https://cdn.test/a/master.m3u8", "enc: the hardcoded key resolves the file")
    eq(fetched.filter((u) => u === EMBED).length, 1, "enc: the embed page is fetched once, not re-scanned")
    eq(fetched.some((u) => u.indexOf("/lib/") !== -1), false, "enc: no player script is downloaded when a known key works")
    eq(fetched.filter((u) => u.indexOf("getSources") !== -1), ["https://megaplay.buzz/stream/getSourcesNew?id=177919&s=bcdn"], "enc: one source request, carrying the embed's CDN selector")

    const scan = load("anikoto", {
        fetch: (url) => reply(200, url === EMBED
            ? '<script src="https://megaplay.buzz/lib/newclient.min.js"></script>'
            : 'a=String(e.pick(["trustAesKey","TRUST_AES_KEY"],"0123456789abcdef")),k=(new TextEncoder).encode("0123456789abcdef"),v=(new TextEncoder).encode("fedcba9876543210")'),
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

console.log("anikoto: megaplay by AniList id")
{
    // A fake MegaPlay with `aired` episodes per AniList id: a player page carries data-id, anything past it is MegaPlay's error page.
    const mega = (aired, down, o = {}) => {
        const hits = []
        const p = load("anikoto", {
            $store: store({}),
            LoadDoc: () => () => ({ first: () => ({ attr: () => "" }), length: () => 0 }),
            fetch: (url, opts) => {
                hits.push(url.replace("https://megaplay.buzz", "").replace("https://graphql.anilist.co", "anilist"))
                if (url === "https://graphql.anilist.co") {
                    hits.push(JSON.parse(opts.body).query.indexOf("idMal:") !== -1 ? "by mal" : "by id")
                    return typeof o.al === "number" ? reply(o.al, "") : reply(200, { data: { Media: o.al || null } })
                }
                const m = /\/stream\/(ani|mal)\/\d+\/(\d+)\//.exec(url)
                if (m) return down ? Promise.reject(new Error("i/o timeout")) : reply(200, +m[2] <= (m[1] === "mal" ? o.mal || 0 : aired) ? `<div id="megaplay-player" data-id="f${m[2]}"></div>` : "<title>Error - MegaPlay</title>")
                if (url.indexOf("getSources") !== -1) return reply(200, { sources: [{ file: "https://c.cdn/anime/a/master.m3u8" }], tracks: [{ file: "https://c.cdn/anime/a/eng.vtt", label: "English" }] })
                if (url.endsWith("master.m3u8")) return reply(200, "#EXTM3U\nseg-1.ts\n")
                if (url.endsWith("seg-1.ts")) return reply(206, "G@\x00\x10")
                return reply(404, "")
            },
        })
        return { p, hits }
    }
    const media = { id: 7, romajiTitle: "Show", englishTitle: "Show EN", format: "TV", episodeCount: 12 }
    const probes = (n) => n.map((e) => `/stream/ani/7/${e}/sub`)

    const a = mega(12)
    eq([await a.p.search({ query: "Show", dub: true, media }), a.hits], [[{ id: "mp:7$dub$ec12$pt0", title: "Show EN", url: "https://megaplay.buzz/stream/ani/7/1/dub", subOrDub: "dub" }], ["/stream/ani/7/1/dub"]], "megaplay: an AniList id MegaPlay knows answers the search in one request, with no site search")
    eq([(await a.p.search({ query: "Shou", dub: true, media }))[0].id, a.hits.length], ["mp:7$dub$ec12$pt0", 1], "megaplay: a second search for the same id under another query reuses the MegaPlay answer")
    const done = await a.p.findEpisodes("mp:7$sub$ec12$pt0")
    eq([done.length, done[11].id, done[11].url, a.hits.slice(1)], [12, "mp:7:12$sub", "https://megaplay.buzz/stream/ani/7/12/sub", probes([12])], "megaplay: a finished show costs one check of its last episode")

    const airing = mega(4)
    eq([(await airing.p.findEpisodes("mp:7$sub$ec12$pt0")).map((e) => e.number), airing.hits], [[1, 2, 3, 4], probes([12, 6, 3, 4, 5])], "megaplay: an airing show is cut to its aired episodes by bisecting below the planned count")
    const long = mega(1180, false, { al: { episodes: null, nextAiringEpisode: { episode: 1181 } } })
    const longId = (await long.p.search({ query: "Show", dub: false, media: { ...media, episodeCount: -1 } }))[0].id
    const longEps = await long.p.findEpisodes(longId)
    await long.p.findEpisodes(longId)
    eq([longId, longEps.length, long.hits], ["mp:7$sub", 1180, ["/stream/ani/7/1/sub", "anilist", "by id", "/stream/ani/7/1180/sub"]], "megaplay: a title with no tracker count still stays on MegaPlay, taking its aired count from AniList's next episode, kept for a while")
    const lost = mega(20, false, { al: 500 })
    eq([(await lost.p.findEpisodes("mp:7$sub$pt0")).length, lost.hits.slice(2)], [20, probes([1, 2, 4, 8, 16, 32, 24, 20, 22, 21])], "megaplay: with no count from AniList either, the last episode is found by doubling then bisecting on MegaPlay")
    const malOnly = mega(0, false, { mal: 12, al: { episodes: 12 } })
    const viaMal = await malOnly.p.search({ query: "Show", dub: false, media: { ...media, idMal: 70 } })
    const malEps = await malOnly.p.findEpisodes(viaMal[0].id)
    const malGot = await malOnly.p.findEpisodeServer({ id: malEps[2].id, number: 3, url: "" }, "Auto")
    eq([viaMal[0].id, viaMal[0].url, malEps.length, malEps[2].id, malGot.videoSources[0].url, malOnly.hits.filter((h) => /^\/stream\/(ani|mal)\//.test(h))], ["mp:m70$sub$ec12$pt0", "https://megaplay.buzz/stream/mal/70/1/sub", 12, "mp:m70:3$sub", "https://c.cdn/anime/a/master.m3u8", ["/stream/ani/7/1/sub", "/stream/mal/70/1/sub", "/stream/mal/70/12/sub", "/stream/mal/70/3/sub"]], "megaplay: a title MegaPlay maps only by MAL id is found, listed and played through the MAL route")
    const malLong = mega(0, false, { mal: 100, al: { episodes: null, nextAiringEpisode: { episode: 101 } } })
    eq([(await malLong.p.findEpisodes("mp:m70$sub$pt0")).length, malLong.hits], [100, ["anilist", "by mal", "/stream/mal/70/100/sub"]], "megaplay: a MAL-route title with no count asks AniList by MAL id")
    eq(await mega(0).p.findEpisodes("mp:7$sub$ec1$pt0").catch((e) => e), "MegaPlay lists no sub episodes for this title", "megaplay: an id whose episodes are gone fails clearly instead of listing nothing")
    const gone = mega(12, true)
    eq([await gone.p.findEpisodes("mp:7$sub$ec12$pt0").catch((e) => e), gone.hits.length], ["MegaPlay did not answer the episode check - retry in a moment", 1], "megaplay: an unreachable MegaPlay fails the list after one unretried check instead of guessing a count")

    for (const [what, site] of [["does not know", mega(0)], ["cannot be reached for", mega(0, true)]]) {
        const ask = () => site.p.search({ query: "Show", dub: false, media }).catch((e) => e)
        await ask()
        const first = site.hits.slice()
        await ask()
        const mp = (h) => h.filter((u) => u.indexOf("/stream/ani/") === 0).length
        eq([first[0], mp(first), first.some((h) => h.indexOf("anikototv.to/filter?keyword=") !== -1), mp(site.hits.slice(first.length))], ["/stream/ani/7/1/sub", 1, true, what === "does not know" ? 0 : 1], `megaplay: a title MegaPlay ${what} falls back to the site search after one unretried check; only a real miss is remembered`)
    }

    const s = mega(12)
    const got = await s.p.findEpisodeServer({ id: "mp:7:3$sub", number: 3, url: "" }, "Auto")
    eq([got.videoSources[0].url, got.headers.Referer, got.videoSources[0].subtitles.length, s.hits.slice(0, 2), s.hits.some((h) => h.indexOf("anikoto") !== -1 || h.indexOf("s=tcdn") !== -1)], ["https://c.cdn/anime/a/master.m3u8", "https://megaplay.buzz/", 1, ["/stream/ani/7/3/sub", "/stream/getSourcesNew?id=f3"], false], "megaplay: an episode plays straight from its MegaPlay player via Vidstream-2 first, never touching the site's server list or HD-1")
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

    const tail = (status, newest) => {
        const hits = []
        const t = load("anizone", {
            fetch: (url, opts) => {
                hits.push((opts && opts.method) || "GET")
                if (opts && opts.method === "POST") {
                    const html = `items: JSON.parse('${JSON.stringify((newest || []).map((n) => ({ slug: String(n) })))}')`
                    return Promise.resolve(newest ? { ok: true, status: 200, json: () => ({ components: [{ effects: { html } }] }) } : { ok: false, status: 429 })
                }
                if (!status) return Promise.reject(new Error("timeout"))
                return Promise.resolve({ ok: status === 200, status, text: () => "" })
            },
        })
        const html = `<div wire:snapshot="{&quot;data&quot;:{&quot;slug&quot;:&quot;abc123&quot;}}" data-csrf="t"></div><span>1184 Episodes</span>`
        return t.trimToExisting({ cookies: {} }, html, "abc123", 24).then((r) => [r, hits])
    }
    eq(await tail(200), [{ last: 1184, sure: true }, ["GET"]], "probe: a stated count that exists is trusted after one GET - HEAD never completes on this site")
    eq(await tail(404, [1180, 1179, "s2"]), [{ last: 1180, sure: true }, ["GET", "POST"]], "probe: announced episodes that 404 are trimmed to the newest the site lists newest-first")
    eq((await tail(0, [1180]))[0], { last: 1180, sure: true }, "probe: a probe that times out still asks for the newest episode")
    eq((await tail(404))[0], { last: 1183, sure: false }, "probe: with no newest-first listing the 404 is dropped and the result is undecided")
    eq((await tail(429))[0], { last: 1184, sure: false }, "probe: a rate-limited probe keeps the stated count and reports it as undecided")

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
    eq(await site(true, "c1", null, { status: 429 }), [[1, 2, 10, 11, 12], 4, []], "episodes: a rate-limited listing keeps the stated count and is not cached")
    const page = (html) => load("anizone", { fetch: () => Promise.resolve({ ok: true, status: 200, text: () => html, cookies: {} }) }).findEpisodes("abc123$sub").catch((e) => e)
    eq(await page(`items: JSON.parse('[]'), nextCursor: null, hasMore: false`), [], "episodes: a series page whose episode list is empty has no episodes")
    eq(await page("<p>checking your browser</p>"), "anizone: episode list not recognized - the site changed its layout", "episodes: a series page without the episode list markup fails instead of reading as no episodes")

    const listed = { "anizone:eps:abc123$al5$sub": { at: Date.now(), data: [{ number: 7 }] } }
    const gone = load("anizone", { $store: store(listed), fetch: () => Promise.resolve({ ok: false, status: 404, text: () => "" }) })
    const err = await gone.findEpisodeServer({ id: "abc123$7$al5$sub", number: 7, url: "" }, "Auto").catch((e) => e)
    eq([err, Object.keys(listed)], ["anizone: episode 7 is not on anizone yet - refresh the episode list", []], "server: a missing episode drops the cached list so a refresh refetches it")

    const timeouts = []
    const slow = load("anizone", { fetch: (url, opts) => { timeouts.push(opts.timeout); return Promise.reject(new Error("anizone.to did not answer in time")) } })
    const slowErr = await slow.findEpisodes("abc123$sub").catch((e) => e)
    await slow.trimToExisting({ cookies: {} }, "<span>9 Episodes</span>", "abc123", 1)
    eq([timeouts, slowErr], [[60, 5], "anizone: series page failed - the site did not answer in time"], "timeout: page loads outwait the host default and a caller's own timeout wins")

    const BLOCK = "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><h2>You are unable to access anizone.to</h2></body></html>"
    const CHALLENGE = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>"
    const answer = (status, body, headers = {}) => () => Promise.resolve({ ok: status >= 200 && status < 300, status, headers, cookies: {}, text: () => body })
    const refuse = (m) => () => Promise.reject(new Error(m))
    const searched = async (f) => {
        let n = 0
        const r = await load("anizone", { fetch: (u, o) => (n++, f(u, o)) }).search({ media: { id: 0, romajiTitle: "Foo", englishTitle: "Foo English" }, query: "Foo", dub: false }).then((x) => x.map((y) => y.id), (e) => e)
        return [r, n]
    }
    const sf = "anizone: search failed - the site "
    eq([
        await searched(answer(403, BLOCK)),
        await searched(answer(403, CHALLENGE)),
        await searched(answer(403, "<h1>Forbidden</h1>", { "Cf-Mitigated": "challenge" })),
        await searched(answer(403, "<h1>Forbidden</h1>")),
        await searched(answer(401, "")),
    ], [
        [sf + "blocks this server (Cloudflare block page, HTTP 403)", 1],
        [sf + "wants a captcha from this server (Cloudflare check, HTTP 403)", 1],
        [sf + "wants a captcha from this server (Cloudflare check, HTTP 403)", 1],
        [sf + "answered HTTP 403", 1],
        [sf + "answered HTTP 401", 1],
    ], "why: a Cloudflare block page, a Cloudflare check by title or header, and a plain 401 or 403 are each named and stop the remaining queries")
    const said = async (f) => (await searched(f))[0].slice(sf.length)
    eq([
        await said(answer(503, "")),
        await said(refuse("anizone.to did not answer in time")),
        await said(refuse("anizone.to refused the connection")),
        await said(refuse("anizone.to reset the connection")),
        await said(refuse("Cannot resolve anizone.to")),
        await said(refuse("anizone.to could not be found")),
        await said(refuse("anizone.to failed the TLS check")),
        await said(refuse("anizone.to rejected the TLS handshake")),
        await said(refuse("Too many redirects")),
        await said(refuse("anizone.to redirected")),
        await said(refuse("something odd")),
    ], [
        "answered HTTP 503",
        "did not answer in time",
        "refused the connection",
        "reset the connection",
        "could not be found (DNS)",
        "could not be found (DNS)",
        "failed the TLS handshake",
        "failed the TLS handshake",
        "redirected too many times",
        "redirected",
        "could not be reached (something odd)",
    ], "why: a server error and each of the host's transport failures are named")
    eq([
        await said(refuse('Get "https://anizone.to/anime?search=Reset": dial tcp: lookup anizone.to: no such host')),
        await said(refuse('Get "https://anizone.to/anime?search=Foo": stopped after 10 redirects')),
        await said(refuse('Get "https://anizone.to/anime?search=Foo": context deadline exceeded (Client.Timeout exceeded while awaiting headers)')),
        await said(refuse("read tcp 10.0.0.1:5000->1.2.3.4:443: read: connection reset by peer")),
        await said(refuse('Get "https://anizone.to/anime?search=Closed": tls: failed to verify certificate: x509: certificate has expired')),
    ], ["could not be found (DNS)", "redirected too many times", "did not answer in time", "reset the connection", "failed the TLS handshake"], "why: Seanime's Go errors are named by their cause, not by words in the URL they quote")
    const mixed = async (first, mem = {}) => {
        let n = 0
        const r = await load("anizone", { $store: store(mem), fetch: (u) => (n++, n === 1 ? first() : answer(403, BLOCK)()) }).search({ media: { id: 0, romajiTitle: "Foo Bar", englishTitle: "Foo Bar English" }, query: "Foo", dub: false }).then((x) => x.map((y) => y.id), (e) => e)
        return [r, n]
    }
    const settled = { "anizone:q:foo bar english": { at: Date.now(), data: [{ sid: "abc123", titles: ["Foo Bar English"], type: "", year: 0, eps: 0 }] } }
    eq([
        await mixed(answer(200, "items: JSON.parse('[]')")),
        await mixed(answer(403, BLOCK), settled),
    ], [
        [sf + "blocks this server (Cloudflare block page, HTTP 403)", 2],
        [["abc123$sub"], 1],
    ], "why: a block after an answered query still names itself, but a query already in the cache can still settle the pick")
    const epsErr = (f) => load("anizone", { fetch: f }).findEpisodes("abc123$sub").catch((e) => e)
    const srcErr = (f) => load("anizone", { fetch: f }).findEpisodeServer({ id: "abc123$1$sub", number: 1, url: "" }, "Auto").catch((e) => e)
    eq([
        await epsErr(answer(403, BLOCK)),
        await epsErr(refuse("anizone.to refused the connection")),
        await srcErr(answer(403, CHALLENGE)),
        await srcErr(answer(403, "<h1>Forbidden</h1>")),
        await srcErr(refuse("anizone.to did not answer in time")),
    ], [
        "anizone: series page failed - the site blocks this server (Cloudflare block page, HTTP 403)",
        "anizone: series page failed - the site refused the connection",
        "anizone: episode page failed - the site wants a captcha from this server (Cloudflare check, HTTP 403)",
        "anizone: episode page failed - the site answered HTTP 403",
        "anizone: episode page failed - the site did not answer in time",
    ], "why: the series and episode pages name the same cases")

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
        $store: store(mem),
        fetch: (url) => {
            gets++
            return Promise.resolve({ ok: true, status: 200, text: () => url.endsWith("=Foo") ? `items: JSON.parse('[{"slug":"abc123","main_title":"Foo"}]')` : "<p>checking your browser</p>" })
        },
    })
    const find = (title) => cached.search({ media: { id: 0, romajiTitle: title }, query: title, dub: false }).then((r) => r.map((x) => x.id), () => "err")
    eq([await find("Foo"), await find("Foo"), gets], [["abc123$sub"], ["abc123$sub"], 1], "search: a repeated query is answered from the store, not refetched")
    eq([await find("Bar"), await find("Bar"), gets], ["err", "err", 3], "search: a page with no result markup is never cached")

    const paced = async (status) => {
        let n = 0
        const s = load("anizone", { fetch: () => { n++; return Promise.resolve({ ok: status === 200, status, text: () => `items: JSON.parse('[{"slug":"abc123","main_title":"Foo"}]')` }) } })
        const found = await s.search({ media: { id: 0, romajiTitle: "Foo", englishTitle: "Foo English" }, query: "Foo", dub: false }).then((r) => r.map((x) => x.id), (e) => e)
        return [found, n, status === 429 ? await s.findEpisodes("abc123$sub").catch((e) => e) : ""]
    }
    const busy = "anizone: too many requests right now - wait a minute and retry"
    eq(await paced(200), [["abc123$sub"], 1, ""], "search: a query that settles the pick stops the rest - anizone allows 60 requests a minute per IP")
    eq(await paced(429), [busy, 1, busy], "rate limit: a 429 stops the search and the episode list with its own message")

    eq(load("anizone", { $getUserPreference: () => { throw new Error("no config") } }).baseUrl, "https://anizone.to", "config: a host that throws for an unset preference still gets the default")
    const legacy = load("anizone", { fetch: () => Promise.resolve({ ok: true, status: 200, cookies: {}, text: () => `items: JSON.parse('[{"slug":"1"},{"slug":"2"}]'), hasMore: false` }) })
    eq((await legacy.findEpisodes("abc$al5")).map((e) => e.id), ["abc$1$al5$sub", "abc$2$al5$sub"], "episodes: an id saved by an older version without its audio is normalised")
    const stale = {}
    const evict = load("anizone", { $store: store(stale) })
    stale.k = { at: 1, data: "old" }
    eq([evict.readCache("k", 1000), Object.keys(stale)], [undefined, []], "cache: an expired entry is dropped when read")
    eq(p.searchQueries({ media: { id: 0, romajiTitle: "Show Dai 2 Bu", englishTitle: "" }, query: "", dub: false }).part, 2, "search: a 'Dai N Bu' title asks for part N")
}

console.log("error channel")
{
    const out = []
    const cap = { console: { log() {}, info() {}, warn: (s) => out.push("warn " + s), error: (s) => out.push(String(s)) } }
    load("anikoto", cap).reportError("server", "a")
    load("anikoto", cap).reportError("server", "b", "warn")
    for (const name of ["anizone", "kickassanime"]) {
        load(name, cap).fail("server", "c")
        load(name, cap).fail("server", "d", "info")
    }
    eq(out.map((s) => s.replace(/"t":\d+/, "")), [
        'SEHERRv1 {,"ext":"aq-anikoto","scope":"server","msg":"a"}', 'warn SEHERRv1 {,"ext":"aq-anikoto","scope":"server","msg":"b","lvl":"warn"}',
        'SEHERRv1 {,"ext":"aq-anizone","scope":"server","msg":"c"}', 'warn SEHERRv1 {,"ext":"aq-anizone","scope":"server","msg":"d","lvl":"info"}',
        'SEHERRv1 {,"ext":"aq-kickassanime","scope":"server","msg":"c"}', 'warn SEHERRv1 {,"ext":"aq-kickassanime","scope":"server","msg":"d","lvl":"info"}',
    ], "lvl: an error goes to console.error with no lvl field; a notice carries its level and goes to console.warn, so hosts that treat console.error as failure don't")
    const sites = (name) => { const src = fs.readFileSync(`${ROOT}/extensions/${name}/provider.ts`, "utf8"); return [(src.match(/, "warn"\)/g) || []).length, (src.match(/, "info"\)/g) || []).length] }
    eq(["anikoto", "anizone", "kickassanime", "mkissa"].map(sites), [[6, 1], [0, 1], [0, 3], [1, 1]], "lvl: only the listed recovered and expected reports are relabelled")
}

console.log("kickassanime")
{
    const busy = "kickassanime: too many requests right now - wait a minute and retry"
    const doc = (html) => () => ({ attr: () => { const m = /<astro-island\b[^>]*?\sprops="([^"]*)"/.exec(html); return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") : undefined } })
    // A fake kaa.lt: routes are "METHOD path" prefixes, the player host reads as @player, anything unrouted is a 404.
    const site = (routes, mem = {}) => {
        const hits = []
        const p = load("kickassanime", {
            $store: store(mem),
            LoadDoc: doc,
            fetch: (url, opts) => {
                const key = `${(opts && opts.method) || "GET"} ${url.replace("https://kaa.lt", "").replace("https://krussdomi.com", "@player")}`
                hits.push(opts && opts.body ? `${key} ${opts.body}` : key)
                for (const k in routes) if (key.startsWith(k)) return reply(routes[k][0], routes[k][1])
                return reply(404, "")
            },
        })
        return { p, hits, mem }
    }
    const props = (manifest, subs) => JSON.stringify({
        manifest: [0, manifest],
        subtitles: [1, subs.map(([language, name, src]) => [0, { language: [0, language], name: [0, name], src: [0, src] }])],
        title: [0, "Say &quot;hi&quot;"],
    }).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    const player = (manifest, subs) => `<astro-island uid="x" component-url="/_astro/VidstackPlayer.js" props="${props(manifest, subs)}" ssr client="only">`

    const p = load("kickassanime", { LoadDoc: doc })
    const vid =p.parsePlayer(player("//hls.cdn.test/manifest/a/master.m3u8", [["ara", "Arabic", "https://subs.test/a.vtt"], ["eng", "English", "https:///subs.test/e.srt"], ["eng", "English [Signs & Songs]", "https://subs.test/s.vtt"]]))
    eq(vid.m3u8, "https://hls.cdn.test/manifest/a/master.m3u8", "player: the props attribute is decoded once, so an escaped quote in a title cannot break it, and a protocol-relative manifest is made absolute")
    eq(vid.subs.map((s) => [s.lang, s.origin]), [["ar", "https://subs.test/a.vtt"], ["en", "https://subs.test/e.srt"], ["en", "https://subs.test/s.vtt"]], "player: three-letter track codes fold to two letters and a https:/// link is repaired")
    eq(p.buildSubs(vid.subs).map((s) => [s.language, s.isDefault]), [["English", true], ["Arabic", false], ["English [Signs & Songs]", false]], "subs: full English dialogue is the default ahead of an earlier track and of signs")
    eq(p.parsePlayer(player("https:////bl.cdn.test/mpd/1/master.mpd", [])).m3u8, "", "player: a DASH manifest is not offered as a stream")

    const card = (slug, title, title_en, type, year, locales) => ({ slug, title, title_en, type, year, locales, episode_count: 0 })
    const frieren = {
        maxPage: 1,
        result: [
            card("frieren-2d15", "Sousou no Frieren", "Frieren: Beyond Journey's End", "tv", 2023, ["ja-JP", "en-US"]),
            card("frieren-mini-561b", "Sousou no Frieren: no Mahou", "Frieren Mini Anime", "ona", 2023, []),
            card("frieren-s2-7dcd", "Sousou no Frieren 2nd Season", "Frieren: Beyond Journey's End Season 2", "tv", 2026, ["ja-JP", "en-US"]),
        ],
    }
    const media = { id: 154587, romajiTitle: "Sousou no Frieren", englishTitle: "Frieren: Beyond Journey's End", synonyms: [], format: "TV", startDate: { year: 2023 } }
    const s1 = site({ "POST /api/fsearch": [200, frieren] })
    eq([await s1.p.search({ media, query: "Frieren", dub: false }), s1.hits], [[{ id: "frieren-2d15$ja-JP$sub", title: "Sousou no Frieren", url: "https://kaa.lt/frieren-2d15", subOrDub: "sub" }], ['POST /api/fsearch {"page":1,"query":"Sousou no Frieren"}']], "search: the first query settles the pick and stops the rest; the id carries the site locale and the audio")
    const s2 = site({ "POST /api/fsearch": [200, frieren] })
    const sequel = { ...media, id: 182255, romajiTitle: "Sousou no Frieren 2nd Season", englishTitle: "Frieren: Beyond Journey's End Season 2", startDate: { year: 2026 } }
    eq((await s2.p.search({ media: sequel, query: "x", dub: false })).map((r) => r.id), ["frieren-s2-7dcd$ja-JP$sub"], "match: a sequel season takes its own entry")
    const bare = site({ "POST /api/fsearch": [200, { result: [card("douluo-91c0", "Douluo Dalu", null, "ona", 2018, [])] }] })
    eq(await bare.p.search({ media: { id: 1, romajiTitle: "Douluo Dalu", synonyms: [], startDate: { year: 2018 } }, query: "x", dub: false }), [], "search: an entry the site lists with no episodes is no match, not an error")
    const donghua = site({ "POST /api/fsearch": [200, { result: [card("link-click-0e5d", "Shiguang Dailiren", "Link Click", "ona", 2021, ["zh-CN", "en-US"])] }] })
    eq((await donghua.p.search({ media: { id: 2, romajiTitle: "Shiguang Dailiren", englishTitle: "Link Click", synonyms: [], startDate: { year: 2021 } }, query: "x", dub: false })).map((r) => r.id), ["link-click-0e5d$zh-CN$sub"], "search: a donghua's original Chinese audio is its sub")

    const eps = (slugs) => ({ current_page: 1, pages: [{ number: 1, from: "01", to: String(slugs.length), eps: slugs.map((_, i) => i + 1) }], result: slugs.map((s, i) => ({ slug: s, episode_number: i + 1, episode_string: String(i + 1) })) })
    const vidstream = { name: "VidStreaming", src: "https://krussdomi.com/cat-player/player?id=1&source=vidstream&ln=en-US" }
    const dubSite = (servers) => site({ "POST /api/fsearch": [200, frieren], "GET /api/show/frieren-2d15/episodes?ep=1&lang=en-US": [200, eps(["aa", "bb"])], "GET /api/show/frieren-2d15/episode/ep-1-aa": [200, { servers }] })
    const dead = dubSite([])
    eq(await dead.p.search({ media, query: "x", dub: true }).catch((e) => e), "kickassanime: no dub for this title on kickassanime", "dub: a listed dub whose first episode has no stream is reported, not matched - the site lists dead en-US episodes")
    const dub = dubSite([vidstream])
    const dubRes = await dub.p.search({ media, query: "x", dub: true })
    const dubEps = await dub.p.findEpisodes(dubRes[0].id)
    eq([dubRes.map((r) => [r.id, r.subOrDub]), dubEps.length, dub.hits.length], [[["frieren-2d15$en-US$dub", "dub"]], 2, 3], "dub: a playable dub costs two checks, and the episode list they fetched is reused")

    const twins = { result: [card("fb-one-1111", "Fruits Basket", null, "tv", 2019, ["ja-JP"]), card("fb-two-2222", "Fruits Basket", null, "tv", 2019, ["ja-JP"])] }
    const fb = { id: 3, romajiTitle: "Fruits Basket", synonyms: [], format: "TV", startDate: { year: 2019, month: 4, day: 6 } }
    const shown = (slug, start) => [200, { slug, title: "Fruits Basket", type: "tv", year: 2019, locales: ["ja-JP"], start_date: start }]
    const dated = site({ "POST /api/fsearch": [200, twins], "GET /api/show/fb-one-1111": shown("fb-one-1111", "2019-01-11T00:00:00.000Z"), "GET /api/show/fb-two-2222": shown("fb-two-2222", "2019-04-06T00:00:00.000Z") })
    const datedIds = async (m) => (await dated.p.search({ media: m, query: "x", dub: false })).map((r) => r.id)
    eq([await datedIds(fb), await datedIds(fb), dated.hits.filter((h) => h.startsWith("GET /api/show/"))], [["fb-two-2222$ja-JP$sub"], ["fb-two-2222$ja-JP$sub"], ["GET /api/show/fb-one-1111", "GET /api/show/fb-two-2222"]], "date: two entries the titles cannot split are settled by the site's exact start date, and the dates are kept")
    const undated = site({ "POST /api/fsearch": [200, twins], "GET /api/show/": [500, ""] })
    eq([
        (await undated.p.search({ media: { ...fb, startDate: { year: 2019 } }, query: "x", dub: false })).length,
        (await undated.p.search({ media: fb, query: "x", dub: false })).length,
        undated.hits.filter((h) => h.startsWith("GET /api/show/")).length,
    ], [2, 2, 1], "date: no full start date asks nothing, and a show lookup that fails keeps every candidate")

    const limited = site({ "POST /api/fsearch": [429, ""] })
    eq([await limited.p.search({ media, query: "x", dub: false }).catch((e) => e), limited.hits.length], [busy, 1], "rate limit: a 429 stops the search at once")
    eq(await site({ "GET /api/show/": [429, ""] }).p.findEpisodes("op-0948$ja-JP$sub").catch((e) => e), busy, "rate limit: a 429 stops the episode list with the same message")

    const many = {
        current_page: 1,
        pages: [{ number: 1, from: "01", to: "100", eps: [1, 2, 2.5, 3] }, { number: 2, from: "101", to: "102", eps: [101, 102] }],
        result: [{ slug: "s1", episode_number: 1, title: "One" }, { slug: "s2", episode_number: 2 }, { slug: "s25", episode_number: 2.5 }, { slug: "s3", episode_number: 3 }],
    }
    const op = site({ "GET /api/show/op-0948/episodes?ep=1&lang=ja-JP": [200, many] })
    const list = await op.p.findEpisodes("op-0948$ja-JP$sub")
    eq(list.map((e) => [e.number, e.id]), [[1, "op-0948$1$s1$ja-JP$sub"], [2, "op-0948$2$s2$ja-JP$sub"], [3, "op-0948$3$s3$ja-JP$sub"], [101, "op-0948$101$$ja-JP$sub"], [102, "op-0948$102$$ja-JP$sub"]], "episodes: one request lists every page's numbers, x.5 recaps are dropped, and only the first page carries slugs")
    await op.p.findEpisodes("op-0948$ja-JP$sub")
    eq([op.hits.length, Object.keys(op.mem)], [1, ["kickassanime:eps:op-0948$ja-JP$sub"]], "episodes: the list is cached per show, locale and audio")

    const html = player("https://hls.cdn.test/manifest/x/master.m3u8", [["eng", "English", "https://subst.test/e.vtt"]])
    const srv = site({
        "GET /api/show/op-0948/episodes?ep=101&lang=ja-JP": [200, { current_page: 2, pages: [], result: [{ slug: "z101", episode_number: 101 }] }],
        "GET /api/show/op-0948/episode/ep-101-z101": [200, { servers: [{ name: "BirdStream", src: "https://krussdomi.com/cat-player/player?id=b&type=dash" }, { name: "CatStream", src: "https://krussdomi.com/cat-player/vast?id=c" }] }],
        "GET @player/cat-player/player?id=c": [200, html],
    })
    const ep101 = { id: "op-0948$101$$ja-JP$sub", number: 101, url: "" }
    const got = await srv.p.findEpisodeServer(ep101, "Auto")
    eq([got.server, got.headers, got.videoSources[0].url, got.videoSources[0].type, got.videoSources[0].subtitles.length, srv.hits], [
        "Auto", { Origin: "https://krussdomi.com", Referer: "https://krussdomi.com/" }, "https://hls.cdn.test/manifest/x/master.m3u8", "m3u8", 1,
        ["GET /api/show/op-0948/episodes?ep=101&lang=ja-JP", "GET /api/show/op-0948/episode/ep-101-z101", "GET @player/cat-player/player?id=c"],
    ], "server: an episode past the first page resolves its slug, skips the DASH server unfetched, opens the player instead of its ad page, and plays HLS with the player's origin - segments 403 without it")
    await srv.p.findEpisodeServer(ep101, "Auto")
    eq(srv.hits.length, 3, "server: the source is cached")

    const stale = site({ "GET /api/show/f/episodes?ep=1&lang=ja-JP": [200, { pages: [], result: [{ slug: "new", episode_number: 1 }] }], "GET /api/show/f/episode/ep-1-new": [200, { servers: [] }] })
    const staleErr = await stale.p.findEpisodeServer({ id: "f$1$old$ja-JP$sub", number: 1, url: "" }, "Auto").catch((e) => e)
    eq([staleErr, stale.hits.length], ["kickassanime: the site has no sub stream for episode 1", 3], "server: a replaced slug is re-resolved, and an episode with no servers says so")
    const listed = { "kickassanime:eps:f$ja-JP$sub": { at: Date.now(), data: [{ number: 7 }] } }
    const gone = site({ "GET /api/show/f/episodes?ep=7": [200, { pages: [], result: [] }] }, listed)
    const goneErr = await gone.p.findEpisodeServer({ id: "f$7$old$ja-JP$sub", number: 7, url: "" }, "Auto").catch((e) => e)
    eq([goneErr, Object.keys(listed)], ["kickassanime: episode 7 (sub) is not on kickassanime anymore - refresh the episode list", []], "server: a vanished episode drops the cached list so a refresh refetches it")

    const down = site({ "POST /api/fsearch": [522, ""] })
    const downErr = await down.p.search({ media: { id: 1, romajiTitle: "Sousou no Frieren", englishTitle: "Frieren" }, query: "Frieren", dub: false }).catch((e) => e)
    eq([downErr, down.hits.length], ["kickassanime: search failed (site unreachable)", 1], "search: a failing site stops the search at its first answer instead of sending every query")
    const moved = site({ "GET /api/show/f/episode/ep-1-s1": [200, { servers: [{ name: "VidStreaming", src: "https://krussdomi.com/cat-player/player?id=v" }] }], "GET @player/cat-player/player?id=v": [200, "<html>new player</html>"] })
    eq(await moved.p.findEpisodeServer({ id: "f$1$s1$ja-JP$sub", number: 1, url: "" }, "Auto").catch((e) => e), "kickassanime: no playable stream for episode 1 - the player page was not recognized - the site changed its player; this extension needs an update", "server: a player page in a new shape says the extension needs an update, not to retry")
    eq(load("kickassanime", { $getUserPreference: () => "https://kaa.mirror/" }).baseUrl, "https://kaa.mirror", "config: a mirror loses its trailing slash")
}

console.log("mkissa")
{
    const crypto = await import("crypto")
    const p = load("mkissa")
    const bytes = (b) => [...b]
    const msg = Buffer.from("葬送のフリーレン — 1 sub " + "x".repeat(150))
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    eq(p.sha256(bytes(msg)), bytes(crypto.createHash("sha256").update(msg).digest()), "crypto: sha256 matches node over a multi-block utf8 message")
    eq(p.hmac(bytes(key), bytes(msg)), bytes(crypto.createHmac("sha256", key).update(msg).digest()), "crypto: hmac-sha256 matches node")
    const c = crypto.createCipheriv("aes-256-gcm", key, iv)
    const sealed = Buffer.concat([c.update(msg), c.final(), c.getAuthTag()])
    eq(p.gcm(bytes(key), bytes(iv), bytes(msg), true), bytes(sealed), "crypto: aes-256-gcm encrypt matches node, tag included")
    eq(p.gcm(bytes(key), bytes(iv), bytes(sealed.subarray(0, msg.length)), false), bytes(msg), "crypto: aes-256-gcm decrypt round-trips")
    eq(p.unhex("1748485141"), "/ppiy", "sources: a -- link is hex with every byte xored by 56")

    const show = { _id: "ReHMC7TQnch3C6z8j", name: "Sousou no Frieren", englishName: "Frieren: Beyond Journey's End", aniListId: "154587", type: "TV", availableEpisodes: { sub: 4, dub: 1 }, availableEpisodesDetail: { sub: ["3", "2", "1", "0", "1.5"], dub: ["1"] } }
    const frieren = { id: 154587, romajiTitle: "Sousou no Frieren", englishTitle: "Frieren: Beyond Journey's End", synonyms: [], isAdult: false, startDate: { year: 2023 } }

    // A fake api.mkissa.net: show lookups, the bootstrap and a sealed episode answer, all checked with node's own crypto.
    const site = (o = {}) => {
        const mem = {}
        const hits = []
        const mask = Buffer.from(p.mask, "hex")
        const wk = crypto.randomBytes(32)
        const epoch = Math.floor(Date.now() / 604800000)
        let crypt = o.crypt || 0
        const s = load("mkissa", {
            $store: store(mem),
            $getUserPreference: (k) => (k === "captchaRelay" ? o.relay : undefined),
            CryptoJS: { enc: { Base64: { stringify: (u) => Buffer.from(u).toString("base64") } } },
            fetch: (url, opts = {}) => {
                const body = opts.body ? JSON.parse(opts.body) : null
                hits.push(body ? (/episode\(/.test(body.query) ? "episode" : /shows\(/.test(body.query) ? "shows:" + body.variables.search.query : "show:" + body.variables._id) : url.replace(/\?.*$/, ""))
                if (o.reject) return Promise.reject(new Error(o.reject))
                if (o.status) return reply(o.status, {})
                if (url.indexOf("/client-crypto/v1/bootstrap") !== -1) {
                    if (o.boot) return reply(o.boot[0], o.boot[1])
                    const k1 = crypto.createHmac("sha256", mask).update("KoCGqjW:179").digest()
                    const want = crypto.createHmac("sha256", k1).update(["179", "mkissa", "k7", epoch, "mkissa.to"].join("|")).digest("hex")
                    if (opts.headers["x-aa-boot"] !== want) return reply(403, { error: "invalid_boot_token" })
                    return reply(200, { epoch, switchAt: Date.now() + 86400000, partB: Buffer.from(wk.map((b, i) => b ^ mask[i])).toString("base64"), k: "k7" })
                }
                if (body && /episode\(/.test(body.query)) {
                    if (o.gate && !(body.extensions.captcha && body.extensions.captcha.token === o.gate)) return reply(200, { errors: [{ message: body.extensions.captcha ? "CAPTCHA_INVALID" : "NEED_CAPTCHA" }], data: { episode: null } })
                    if (o.errors) return reply(200, { errors: [{ message: o.errors }], data: { episode: null } })
                    if (o.garble) return reply(200, { data: { _m: "b7", tobeparsed: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } })
                    if (crypt-- > 0) return reply(200, { errors: [{ message: "AA_CRYPTO_STALE" }], data: { episode: null } })
                    const t = Buffer.from(body.extensions.aaReq, "base64")
                    const d = crypto.createDecipheriv("aes-256-gcm", wk, t.subarray(1, 13))
                    d.setAuthTag(t.subarray(t.length - 16))
                    const req = JSON.parse(Buffer.concat([d.update(t.subarray(13, t.length - 16)), d.final()]).toString())
                    if (req.qh !== crypto.createHash("sha256").update(body.query).digest("hex") || req.k !== "k7" || req.buildId !== "179") return reply(200, { errors: [{ message: "AA_CRYPTO_QUERY_MISMATCH" }] })
                    const ivo = crypto.randomBytes(12)
                    const e = crypto.createCipheriv("aes-256-gcm", wk, ivo)
                    const out = JSON.stringify({ episode: { episodeString: body.variables.episodeString, sourceUrls: o.sources } })
                    return reply(200, { data: { _m: "b7", tobeparsed: Buffer.concat([Buffer.from([1]), ivo, e.update(out), e.final(), e.getAuthTag()]).toString("base64") } })
                }
                if (body && /shows\(/.test(body.query)) return reply(200, { data: { shows: { edges: o.edges || [] } } })
                if (body) return reply(200, { data: { show: o.missing ? null : show } })
                return o.page ? o.page(url, opts) : reply(404, "")
            },
        })
        return { s, hits, mem }
    }

    const a = site()
    const found = await a.s.search({ media: frieren, query: "Frieren", dub: true })
    eq([found, a.hits], [[{ id: "ReHMC7TQnch3C6z8j$dub", title: "Frieren: Beyond Journey's End", url: "https://mkissa.to/anime/ReHMC7TQnch3C6z8j", subOrDub: "both" }], ["show:154587"]], "search: the AniList id resolves in one request and the id carries the audio")
    const eps = await a.s.findEpisodes("ReHMC7TQnch3C6z8j$sub")
    eq([eps.map((e) => e.number), eps[0].id, eps[0].url, a.hits.length], [[1, 2, 3], "ReHMC7TQnch3C6z8j$sub$1", "https://mkissa.to/anime/ReHMC7TQnch3C6z8j/p-1-sub", 1], "episodes: listed from the show the search cached, recaps and episode 0 dropped, ascending")

    const subOnly = site()
    subOnly.s.gql = () => Promise.resolve({ show: Object.assign({}, show, { availableEpisodes: { sub: 4, dub: 0 } }) })
    eq((await subOnly.s.search({ media: frieren, query: "", dub: true })).map((r) => [r.id, r.subOrDub]), [], "search: a dub request on a sub-only show finds nothing rather than passing the sub off as a dub")

    const edges = [{ _id: "x1", name: "Sousou no Frieren: Mini", aniListId: "1", availableEpisodes: { sub: 1 } }, { _id: "x2", name: "Sousou no Frieren", aniListId: "154587", availableEpisodes: { sub: 28 } }]
    const fb = site({ missing: true, edges })
    eq([(await fb.s.search({ media: frieren, query: "", dub: false })).map((r) => r.id), fb.hits], [["x2$sub"], ["show:154587", "shows:Sousou no Frieren"]], "search: when the id lookup misses, a title search takes the candidate carrying the AniList id and stops there")
    const titled = site({ edges: [{ _id: "x3", name: "Sousou no Frieren", availableEpisodes: { sub: 28 } }, { _id: "x4", name: "Some Other Show", availableEpisodes: { sub: 3 } }] })
    eq((await titled.s.search({ media: Object.assign({}, frieren, { id: 0 }), query: "", dub: false })).map((r) => r.id), ["x3$sub"], "search: with no id the title score settles a single pick")

    const mp4 = (url) => reply(200, url.indexOf("www.mp4upload.com/embed-abc.html") !== -1 ? 'player.src({ type: "video/mp4", src: "https://a4.mp4upload.com:183/d/tok/video.mp4" })' : "")
    const srv = site({ sources: [{ sourceUrl: "https://streamwish.to/e/x", sourceName: "Sw", priority: 5.5 }, { sourceUrl: "https://mp4upload.com/embed-abc.html", sourceName: "Mp4", priority: 4 }], page: mp4 })
    const got = await srv.s.findEpisodeServer({ id: "ReHMC7TQnch3C6z8j$sub$1", number: 1, url: "" }, "Auto")
    eq([got, srv.hits], [{ server: "Auto", headers: { Referer: "https://www.mp4upload.com/" }, videoSources: [{ url: "https://a4.mp4upload.com:183/d/tok/video.mp4", type: "mp4", quality: "auto", subtitles: [] }] }, ["https://api.mkissa.net/client-crypto/v1/bootstrap", "episode", "https://www.mp4upload.com/embed-abc.html"]], "server: the sealed episode answer opens and mp4upload resolves with its referer, unsupported players skipped")
    await srv.s.findEpisodeServer({ id: "ReHMC7TQnch3C6z8j$sub$1", number: 1, url: "" }, "Auto")
    eq(srv.hits.slice(3), ["https://www.mp4upload.com/embed-abc.html"], "server: the boot key and the source list are reused from the store")

    const clockPath = Buffer.from("/apivtwo/clock?id=7d24").map((b) => b ^ 56).toString("hex")
    const own = site({
        sources: [{ sourceUrl: "https://ok.ru/videoembed/1", sourceName: "Ok", priority: 3.5 }, { sourceUrl: "--" + clockPath, sourceName: "Default", priority: 8.5 }],
        page: (url) => reply(url.indexOf("clock.json") !== -1 ? 200 : 404, url === "https://filelotion.fyi/apivtwo/clock.json?id=7d24" ? { links: [{ link: "https://repackager.wixmp.com/v/,1080p,720p,/mp4/file.mp4.urlset/master.m3u8", hls: true, resolutionStr: "Hls", subtitles: [{ src: "https://s.test/signs.vtt", lang: "en", label: "English (Signs)" }, { src: "https://s.test/full.vtt", lang: "en", label: "English" }] }] } : {}),
    })
    const mine = await own.s.findEpisodeServer({ id: "ReHMC7TQnch3C6z8j$dub$1", number: 1, url: "" }, "Auto")
    eq([mine.videoSources[0].type, mine.videoSources[0].subtitles.map((t) => [t.url, t.isDefault])], ["m3u8", [["https://s.test/full.vtt", true], ["https://s.test/signs.vtt", false]]], "server: the site's own upload goes first via the clock API and full English dialogue is the default track")

    const hung = site({
        sources: [{ sourceUrl: "--" + clockPath, sourceName: "Default", priority: 8.5 }, { sourceUrl: "https://mp4upload.com/embed-abc.html", sourceName: "Mp4", priority: 4 }],
        page: (url) => (url.indexOf("clock.json") !== -1 ? new Promise((r) => setTimeout(() => r(reply(200, { links: [] })), 300)) : mp4(url)),
    })
    hung.s.serverBudget = 150
    const hungErr = await hung.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e)
    hung.s.serverBudget = 15000
    const before = hung.hits.length
    const after = await hung.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto")
    eq([hungErr, hung.hits.slice(before), after.videoSources[0].type], ["mkissa: episode 1 ran out of time on Default - retry to try Mp4", ["https://www.mp4upload.com/embed-abc.html"], "mp4"], "server: a host that eats the budget keeps the source list and goes last, so the retry costs no new lookup")

    const ok = site({ sources: [{ sourceUrl: "https://ok.ru/videoembed/9", sourceName: "Ok" }], page: () => reply(200, `<div data-options="{&quot;flashvars&quot;:{&quot;metadata&quot;:&quot;{\\&quot;ondemandHls\\&quot;:\\&quot;https://vd.okcdn.ru/x.m3u8\\&quot;}&quot;}}"></div>`) })
    const okGot = await ok.s.findEpisodeServer({ id: "ReHMC7TQnch3C6z8j$sub$2", number: 2, url: "" }, "Auto")
    eq([okGot.videoSources[0].url, okGot.headers.Referer], ["https://vd.okcdn.ru/x.m3u8", "https://ok.ru/"], "server: ok.ru metadata gives its HLS manifest")

    const stale = site({ crypt: 1, sources: [{ sourceUrl: "https://mp4upload.com/embed-abc.html", sourceName: "Mp4" }], page: mp4 })
    await stale.s.findEpisodeServer({ id: "ReHMC7TQnch3C6z8j$sub$1", number: 1, url: "" }, "Auto")
    eq(stale.hits.slice(0, 4), ["https://api.mkissa.net/client-crypto/v1/bootstrap", "episode", "https://api.mkissa.net/client-crypto/v1/bootstrap", "episode"], "server: a stale crypto answer refetches the bootstrap and retries once")
    const dead = site({ crypt: 9, sources: [] })
    eq([await dead.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e), dead.hits.filter((h) => h === "episode").length], ["mkissa: the site refused the sealed request (AA_CRYPTO_STALE) - this extension needs an update", 2], "server: a second stale answer names the site's code and says the extension needs an update")
    const lookup = (o) => {
        const x = site(o)
        return x.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").then(() => "returned", (e) => e).then((e) => [e, x.hits])
    }
    const BOOT = "https://api.mkissa.net/client-crypto/v1/bootstrap"
    eq(await lookup({ boot: [404, { error: "unknown_build_id" }] }), ["mkissa: the site retired build 179 (bootstrap: unknown_build_id) - this extension needs an update", [BOOT]], "boot: a retired build is named from the bootstrap's own error, with no episode request")
    eq([
        (await lookup({ boot: [403, { error: "invalid_boot_token" }] }))[0],
        (await lookup({ boot: [500, { error: "oops" }] }))[0],
        (await lookup({ boot: [502, "<html>bad gateway</html>"] }))[0],
        (await lookup({ boot: [200, { epoch: 1, partB: "AAAA" }] }))[0],
    ], [
        "mkissa: the site rejected the build 179 boot token (invalid_boot_token) - this extension needs an update",
        "mkissa: the handshake bootstrap answered 500 oops",
        "mkissa: the handshake bootstrap answered 502",
        "mkissa: the handshake bootstrap answered without a key",
    ], "boot: a refused token, any other status with or without an error field, and a missing key each name themselves")
    const mismatch = await lookup({ errors: "AA_CRYPTO_BUILD_MISMATCH" })
    eq([mismatch[0], mismatch[1].filter((h) => h === "episode").length], ["mkissa: the site refused the sealed request (AA_CRYPTO_BUILD_MISMATCH) - this extension needs an update", 1], "crypto: a code other than stale or expired is named at once, with no retry")
    const expired = await lookup({ errors: "AA_CRYPTO_EXPIRED" })
    eq([expired[0], expired[1].filter((h) => h === "episode").length], ["mkissa: the site refused the sealed request (AA_CRYPTO_EXPIRED) - this extension needs an update", 2], "crypto: an expired answer gets the one retry, then is named")
    const garbled = await lookup({ garble: true })
    eq([garbled[0], garbled[1].filter((h) => h === "episode").length], ["mkissa: the sealed answer did not open with the build 179 key - this extension needs an update", 2], "crypto: an answer that will not open is retried once, then named")
    eq([
        (await lookup({ reject: "api.mkissa.net did not answer in time" }))[0],
        (await lookup({ reject: "api.mkissa.net refused the connection" }))[0],
        (await lookup({ reject: "api.mkissa.net reset the connection" }))[0],
        (await lookup({ reject: "Cannot resolve api.mkissa.net" }))[0],
    ], ["mkissa: the site did not answer in time", "mkissa: the site refused the connection", "mkissa: the site reset the connection", "mkissa: the site could not be found (DNS)"], "transport: each of the host's failures is named")

    const busy = "mkissa: too many requests right now - wait a minute and retry"
    eq(await site({ status: 429 }).s.search({ media: frieren, query: "", dub: false }).catch((e) => e), busy, "rate limit: an HTTP 429 stops the search at once")
    const limited = site({ errors: "Too many requests, please try again in 2 seconds." })
    eq([await limited.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e), limited.hits.length], [busy, 2], "rate limit: the API's own throttle message is a 429 too, with no retry")
    eq(await site({ errors: "NEED_CAPTCHA" }).s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e), "mkissa: the site asks for a captcha (NEED_CAPTCHA) for episode links from this server's IP", "captcha: a captcha demand is reported with its code, not mistaken for a missing episode")
    const relay = (token) => (url) => (url === "http://127.0.0.1:8192/token" ? reply(token ? 200 : 404, token ? { token, provider: "turnstile" } : {}) : mp4(url))
    const relayed = site({ gate: "t1", relay: "http://127.0.0.1:8192/", sources: [{ sourceUrl: "https://mp4upload.com/embed-abc.html", sourceName: "Mp4" }], page: relay("t1") })
    const pass = await relayed.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").then((r) => r.videoSources[0].type, (e) => e)
    eq([pass, relayed.hits], ["mp4", ["https://api.mkissa.net/client-crypto/v1/bootstrap", "episode", "http://127.0.0.1:8192/token", "episode", "https://www.mp4upload.com/embed-abc.html"]], "captcha: a solved check from the relay is sent with one retry of the same lookup")
    const askRelay = "mkissa: the site wants a captcha for episode links from this IP - complete the check on your captcha relay page at http://127.0.0.1:8192/ and retry"
    const empty = site({ gate: "t1", relay: "http://127.0.0.1:8192", page: relay("") })
    eq([await empty.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e), empty.hits.length], [`${askRelay} (the relay has no solved check yet)`, 3], "captcha: with no solved check waiting, the user is pointed at the relay page")
    const down = site({ gate: "t1", relay: "http://127.0.0.1:8192", page: (url) => (url.endsWith("/token") ? Promise.reject(new Error("127.0.0.1 refused the connection")) : mp4(url)) })
    const broken = site({ gate: "t1", relay: "http://127.0.0.1:8192", page: (url) => reply(500, "") })
    const html = site({ gate: "t1", relay: "http://127.0.0.1:8192", page: (url) => reply(200, "<!DOCTYPE html><p>proxy</p>") })
    eq([
        await down.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e),
        await broken.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e),
        await html.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e),
    ], [`${askRelay} (the relay refused the connection)`, `${askRelay} (the relay answered HTTP 500)`, `${askRelay} (the relay answered without a token)`], "captcha: a relay that is down, failing or answering something else says so")
    const refused = site({ gate: "t1", relay: "http://127.0.0.1:8192", page: relay("old") })
    eq([await refused.s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e), refused.hits.filter((h) => h === "episode").length], ["mkissa: the site rejected the relayed captcha token (CAPTCHA_INVALID)", 2], "captcha: a rejected token is named and fails once instead of looping")
    eq(await site({ sources: [{ sourceUrl: "https://bysekoze.com/e/x", sourceName: "Fm-Hls" }] }).s.findEpisodeServer({ id: "a$sub$1", number: 1, url: "" }, "Auto").catch((e) => e), "mkissa: episode 1 only has players this extension cannot play (Fm-Hls)", "server: an episode with only unsupported players says which")

    eq(load("mkissa", { $getUserPreference: () => "https://mkissa.to/" }).baseUrl, "https://mkissa.to", "config: a trailing slash is stripped")
}

console.log("shared helpers")
{
    // Payloads are single files and cannot import each other, so shared helpers are copied; this keeps the copies from drifting.
    const body = (name, method) => {
        const src = fs.readFileSync(`${ROOT}/extensions/${name}/provider.ts`, "utf8").replace(/\r\n/g, "\n")
        const m = new RegExp(`^    (?:private |async )*${method}(?:<[^>]*>)?[(]`, "m").exec(src)
        return m ? src.slice(m.index, src.indexOf("\n    }\n", m.index)) : null
    }
    const SAME = [
        [["anikoto", "anizone", "kickassanime", "mkissa"], ["normTitle", "writeCache"]],
        [["anikoto", "anizone", "kickassanime"], ["simNorm", "lev"]],
        [["anikoto", "anizone", "mkissa"], ["isNonDialogue"]],
        [["anikoto", "anizone", "kickassanime", "mkissa"], ["cfg"]],
        [["anizone", "kickassanime", "mkissa"], ["fail", "readCache"]],
        [["anizone", "mkissa"], ["net"]],
        [["anizone", "kickassanime"], ["searchQueries", "firstWords", "norm", "matchTargets", "scoreTitles", "cardYear", "yearPenalty", "disambiguate", "byPart", "cardMax", "yearOf", "partOf", "bestTitle", "toInt", "displayName", "langName"]],
    ]
    const drift = []
    for (const [names, methods] of SAME) for (const method of methods) {
        const bodies = names.map((n) => body(n, method))
        if (bodies.includes(null) || new Set(bodies).size !== 1) drift.push(`${method} (${names.join(", ")})`)
    }
    eq(drift, [], "shared helpers: methods copied between payloads stay identical")
}

console.log("configuration")
{
    const prefs = (map) => ({ $getUserPreference: (n) => map[n] })
    const DEFAULTS = {
        anikoto: "https://anikototv.to",
        anizone: "https://anizone.to",
        kickassanime: "https://kaa.lt",
        mkissa: "https://mkissa.to",
    }
    for (const name in DEFAULTS) {
        eq(load(name).baseUrl, DEFAULTS[name], `config: ${name} falls back to the manifest default when nothing is set`)
        eq(load(name, prefs({ baseUrl: "{{baseUrl}}" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an unsubstituted placeholder`)
        eq(load(name, prefs({ baseUrl: "" })).baseUrl, DEFAULTS[name], `config: ${name} rejects an empty setting`)
    }
    eq(load("anikoto", prefs({ baseUrl: "https://mirror.example" })).baseUrl, "https://mirror.example", "config: a configured mirror is used")

    const solverOn = load("anikoto", prefs({ useCustomSolver: "on", solverUrl: "http://127.0.0.1:9999/v1" }))
    eq(solverOn.solverEndpoint(), "http://127.0.0.1:9999/v1", "config: the solver endpoint follows the setting")
    eq(solverOn.solverEnabled(), true, "config: the solver is enabled when turned on and pointed somewhere")
    eq(load("anikoto").solverEnabled(), false, "config: the solver stays off by default")
    eq(load("anikoto", prefs({ useCustomSolver: "on", solverUrl: "" })).solverEndpoint(), "http://127.0.0.1:8191/v1", "config: clearing the solver URL falls back to the default, the on/off switch is what disables it")
    eq(load("anikoto", prefs({ useCustomSolver: "on", solverUrl: "localhost:8191" })).solverEnabled(), false, "config: a solver URL with no scheme disables the solver")
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
    eq(v.isValid("1.4.0"), true, "version: three fields inside the caps are valid")
    eq(v.isValid("1.3.103"), false, "version: a three-digit patch is not")
    eq(v.isValid("0.10.28"), false, "version: a two-digit minor is not")
    eq(v.isValid("1.4"), false, "version: two fields are not a version")
    eq(v.manifests().filter((f) => !v.isValid(JSON.parse(fs.readFileSync(f, "utf8")).version)), [], "version: every shipped manifest is inside 9.9.99")
}

console.log("payloads")
{
    const bad = []
    for (const d of fs.readdirSync(`${ROOT}/extensions`)) {
        const src = `${ROOT}/extensions/${d}/provider.ts`
        compile(src)
        const i = fs.readFileSync(src, "latin1").search(/[\x00-\x08\x0b\x0c\x0e-\x1f]/)
        if (i >= 0) bad.push(`${d}@${i}`)
    }
    eq(bad, [], "bytes: every payload compiles the way the host does and carries no stray control character")
}

console.log()
if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed`)
    process.exit(1)
}
console.log(`${checks} checks passed`)
