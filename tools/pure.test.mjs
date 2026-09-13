import fs from "fs"
import { execFileSync } from "child_process"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

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

function load(name, overrides) {
    const src = `${ROOT}/extensions/${name}/provider.ts`
    const js = execFileSync("npx", ["esbuild", "--loader=ts", "--target=es2018"], {
        input: fs.readFileSync(src),
        encoding: "utf8",
        shell: true,
        stdio: ["pipe", "pipe", "ignore"],
    })
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

console.log("anikoto")
{
    const p = load("anikoto")

    const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: "e" + (i + 1), number: i + 1, url: "u" + (i + 1) }))

    let eps = mk(22)
    p.applySeasonWindow(eps, 12, 0)
    eq(eps.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "season window: part 1 of 22 takes the first 12")
    eq(eps[0].id, "e1", "season window: part 1 keeps the leading source episodes")

    eps = mk(22)
    p.applySeasonWindow(eps, 10, 2)
    eq(eps.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "season window: part 2 of 22 renumbers the last 10 from 1")
    eq(eps[0].id, "e13", "season window: part 2 starts at the site's episode 13")

    eps = mk(12)
    p.applySeasonWindow(eps, 12, 0)
    eq(eps.length, 12, "season window: untouched when the counts already agree")

    eps = mk(1177)
    p.applySeasonWindow(eps, -1, 0)
    eq(eps.length, 1177, "season window: skipped when the tracker reports -1 episodes")

    eq(p.cleanLabel("English"), "English", "label: plain title is untouched")
    eq(p.cleanLabel("English (- (Crunchyroll))"), "English (Crunchyroll)", "label: keeps the group")
    eq(p.cleanLabel("German (- Deutsch)"), "German", "label: drops a bare native name")
    eq(p.cleanLabel("Spanish (- Espanol (LA))"), "Spanish (LA)", "label: keeps the region")

    eq(p.fallbackCode("English"), "en", "lang: english maps to en")
    eq(p.fallbackCode("Danish"), "da", "lang: danish maps to da")
    eq(p.fallbackCode("Klingon"), "", "lang: an unknown language is not English")

    eq(p.plain("a — b…"), "a - b...", "plain: dashes and ellipsis become ASCII")
    eq(p.plain("one\ntwo\tthree"), "one two three", "plain: newlines collapse to spaces")
    eq(/^[\x20-\x7e]*$/.test(p.plain("日本語")), true, "plain: output is ASCII only")
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
    eq(p.lastPageOf("gotoPage(2) gotoPage(7) gotoPage(3)"), 7, "paginator: takes the highest page")
    eq(p.lastPageOf("no paginator"), 60, "paginator: falls back to the cap")
    eq(p.isNonDialogue("English - Full Subtitles"), false, "track: a full dialogue track is not signs-only")
    eq(p.isNonDialogue("English (Signs & Songs)"), true, "track: signs and songs is non-dialogue")
    eq(p.trackScore("English", true, false, false) > p.trackScore("English (Signs)", true, false, true), true, "track: dialogue outranks signs")
    eq(p.trackScore("English", true, true, false) > p.trackScore("English", true, false, false), true, "track: the site default breaks ties upward")

    eq(p.tagAttrs('<track src="a.vtt" srclang="en">').src, "a.vtt", "attrs: a quoted value is read")
    eq(p.tagAttrs("<track src=a.vtt/>").src, "a.vtt", "attrs: the self-closing slash is not part of the value")
    eq(p.tagAttrs('<track label="x src=&quot;wrong&quot;" src=right.vtt>').src, "right.vtt", "attrs: a src inside another value cannot win")
    eq(p.tagAttrs('<track src="a.vtt" default>').default, "", "attrs: a valueless attribute is present and empty")
    eq(Object.prototype.hasOwnProperty.call(p.tagAttrs('<track src="a.vtt">'), "default"), false, "attrs: an absent attribute stays absent")
    eq(p.tagAttrs('<track src="a.vtt" label="Signs &amp; Songs">').label, "Signs & Songs", "attrs: every value is entity-decoded, not just the label")
    eq(p.tagAttrs('<track SRC="a.vtt">').src, "a.vtt", "attrs: names are case-insensitive")
    eq(p.tagAttrs('<track data-type="ass" src="a">')["data-type"], "ass", "attrs: hyphenated names survive")

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
    const trimmed = await probe.trimToExisting("abc123", 5, { 1: true, 2: true })
    eq(seenMethods.length > 0, true, "probe: the tail probe actually ran")
    eq(seenMethods.filter((m) => m !== "GET"), [], "probe: existence is checked with GET - HEAD never completes on this site")
    eq(trimmed, 5, "probe: an all-404 tail leaves the stated count alone")
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
    eq(has("*aquatils-beta*) kill -9"), true, "kill: the port sweep checks the executable is ours")
    eq(has("$p.CommandLine -like '*aquatils-beta*'"), true, "kill: the windows sweep matches on the command line")

    eq(has('const FS_KEEP = ["chromium", "state"]'), true, "state: the keep-list names the state directory")
    eq(has('e.name() !== "chromium"'), false, "state: no bare literal is left to drift from the keep-list")
    eq(count("FS_KEEP.indexOf"), 2, "state: both prune and remove read the keep-list")

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
console.log(`${checks} checks passed`)
