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
        { id: 1, title: "Skeleton Knight in Another World", anilist_id: 132474, seasons: 2, audio: ["Japanese", "English"] },
        { id: 2, title: "Frieren: Beyond Journey’s End", anilist_id: 154587, seasons: 2, audio: ["Japanese"] },
        { id: 3, title: "Skeleton Knight OVA", anilist_id: null, seasons: 1, audio: ["Japanese"] },
    ]
    const ep = (id, n) => ({ id, episode: n, title: "E" + n, stream: `https://cdn.lua.locker/hls/${id}/master.m3u8` })
    const routes = {
        "/series/1": { seasons_detail: [{ season: 0, episodes: [ep("sp", 1)] }, { season: 2, episodes: [ep("b1", 1)] }, { season: 1, episodes: [ep("a2", 2), ep("a1", 1)] }] },
        "/series/3": { seasons_detail: [{ season: 1, episodes: [ep("o3", 3), ep("o2", 2)] }] },
        "/episodes/ja": { stream: "https://x/ja.m3u8", audio: [{ label: "Japanese", language: "jpn" }], subtitles: [{ label: "Forced", language: "eng", url: "https://x/0.vtt" }, { label: "Latin American (CC)", language: "spa", default: true, url: "https://x/1.vtt" }, { label: "Subtitles 3", language: "eng", default: true, url: "https://x/2.vtt" }, { label: "Arabic (Saudi Arabia)", language: "ara", default: true, url: "https://x/3.vtt" }, { label: "Simplified", language: "chi", url: "https://x/4.vtt" }, { label: "Weird", language: "xyz", url: "https://x/5.vtt" }] },
        "/episodes/loc": {
            stream: "https://x/loc.m3u8",
            audio: [{ label: "Japan", language: "ja-JP", default: true }, { label: "United States", language: "en-US" }, { label: "Latin America", language: "es-419" }, { label: "", language: "es-ES" }],
            subtitles: [
                { label: "Saudi Arabia", language: "ar-SA", default: true, url: "https://x/ar.ass" },
                { label: "", language: "en-US", default: true, url: "https://x/en.ass" },
                { label: "Forced", language: "en-US", url: "https://x/enf.ass" },
                { label: "Latin America", language: "es-419", url: "https://x/es419.ass" },
                { label: "Signs & Songs", language: "es-ES", url: "https://x/eses.ass" },
                { label: "Brazil", language: "pt-BR", url: "https://x/ptbr.ass" },
                { label: "", language: "de-DE", url: "https://x/de.ass" },
                { label: "Klingon", language: "tlh-QO", url: "https://x/tlh.ass" },
            ],
        },
        "/episodes/en": { stream: "https://x/en.m3u8", audio: [{ label: "Japanese", language: "jpn" }, { label: "English 2.0", language: "eng" }], subtitles: [] },
    }
    const seen = []
    const mk = (key) => load("haifacdn", {
        $getUserPreference: (k) => (k === "apiKey" ? key : undefined),
        fetch: (url, opts) => {
            seen.push(opts.headers.Authorization)
            const path = url.replace("https://cdn.lua.locker/v1", "")
            if (path.startsWith("/series?") && path.includes("&offset=")) return Promise.resolve({ ok: true, status: 200, json: () => ({ total: 3, series: lib }) })
            if (path.startsWith("/series?")) return Promise.resolve({ ok: true, status: 200, json: () => ({ series: lib }) })
            const body = routes[path.split("?")[0]]
            return Promise.resolve(body ? { ok: true, status: 200, json: () => body } : { ok: false, status: 404, json: () => ({ error: "not_found" }) })
        },
    })
    const p = mk(" ak_test ")
    const media = (id, english = "", romaji = "", synonyms = []) => ({ id, englishTitle: english, romajiTitle: romaji, synonyms, isAdult: false })
    const ids = async (m, dub, query = "skeleton") => (await p.search({ media: m, query, dub })).map((r) => r.id + ":" + r.subOrDub)
    eq([
        await ids(media(132474, "Skeleton Knight in Another World"), false),
        await ids(media(185542, "Skeleton Knight in Another World Season 2", "Gaikotsu Kishi-sama, Tadaima Isekai e Odekakechuu II"), true),
        await ids(media(182255, "Frieren: Beyond Journey's End Season 2", "Sousou no Frieren 2nd Season"), false),
        await ids(media(182255, "Frieren: Beyond Journey's End Season 2", "Sousou no Frieren 2nd Season"), true),
        await ids(media(777777, "Skeleton Knight in Another World Season 3"), false),
        await ids(media(0), false),
        await ids(media(5555, "Something Else"), false),
    ], [["1$s1$sub:both"], ["1$s2$dub:both"], ["2$s2$sub:sub"], [], [], ["1$s1$sub:both", "1$s2$sub:both", "2$s1$sub:sub", "2$s2$sub:sub", "3$s1$sub:sub"], ["3$s1$sub:sub"]],
        "search: the AniList id picks season 1, a sequel picks its season by title, dub needs English audio, a season the library lacks gives nothing, a manual query lists every season, and an unmapped query skips series mapped to other shows")
    eq([(await p.findEpisodes("1$s1$dub")).map((e) => [e.number, e.id]), (await p.findEpisodes("1$s2$sub")).map((e) => [e.number, e.id]), (await p.findEpisodes("1$sub")).map((e) => e.id), (await p.findEpisodes("3$s1$sub")).map((e) => e.number)],
        [[[1, "a1$dub"], [2, "a2$dub"]], [[1, "b1$sub"]], ["a1$sub", "a2$sub"], [2, 3]],
        "episodes: only the picked season is listed with its own numbers, specials stay out, and an id without a season means season 1")
    const srv = await p.findEpisodeServer({ id: "ja$sub", number: 1, url: "" }, "Haifa CDN")
    eq([srv.videoSources[0].url, srv.videoSources[0].type, srv.videoSources[0].subtitles.map((s) => s.language + (s.isDefault ? "*" : "")), Object.keys(srv.headers).length], ["https://x/ja.m3u8", "m3u8", ["English*", "English (Forced)", "Spanish (Latin American, CC)", "Arabic (Saudi Arabia)", "Chinese (Simplified)", "Weird"], 0], "server: the master playlist plays as is with no headers; subtitles are named from their language code, and exactly one default is kept, preferring English dialogue")
    let noDub = ""
    try { await p.findEpisodeServer({ id: "ja$dub", number: 1, url: "" }, "Haifa CDN") } catch (e) { noDub = String(e) }
    eq([noDub, (await p.findEpisodeServer({ id: "en$dub", number: 1, url: "" }, "Haifa CDN")).videoSources[0].url], ["Haifa CDN: this episode has no English audio", "https://x/en.m3u8"], "server: dub needs an English audio track")
    const loc = await p.findEpisodeServer({ id: "loc$dub", number: 1, url: "" }, "Haifa CDN")
    eq(loc.videoSources[0].subtitles.map((t) => t.language + (t.isDefault ? "*" : "")),
        ["English*", "Arabic", "English (Forced)", "Spanish (Latin America)", "Spanish (Spain, Signs & Songs)", "Portuguese", "German", "Klingon"],
        "server: locale-coded tracks (en-US, es-419) are named by language, add the region only when one language comes in several regions, keep Forced/Signs from the label, take English dialogue as the default, and pass dub on an en-US audio track")
    let noKey = ""
    try { await mk("").findEpisodes("1$s1$sub") } catch (e) { noKey = String(e) }
    eq([noKey, seen.every((h) => h === "Bearer ak_test")], ["Haifa CDN: add your API key in the extension settings", true], "auth: the key is sent trimmed as a bearer token, and a missing key says where to set it")
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
