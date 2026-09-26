import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

let failures = 0
let checks = 0
const SV = /const SOLVER_VERSION = "([^"]+)"/.exec(fs.readFileSync(`${ROOT}/plugins/aquatils/plugin.ts`, "utf8"))[1]

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

let aquatilsJs = ""
function bootPlugin(fakes = {}) {
    aquatilsJs = aquatilsJs || compile(`${ROOT}/plugins/aquatils/plugin.ts`)
    const h = {
        now: 1767225600000,
        storage: new Map(Object.entries(fakes.storage || {})),
        files: Object.assign({}, fakes.files),
        handlers: {}, polls: {}, every: {}, writes: [], sets: 0, updates: 0, cmds: [], hashes: [], timers: [], notes: [], toasts: [], reported: [], downloads: [], held: [], watchers: {}, cancels: [], late: [], hung: [], reads: [], asked: [],
    }
    const bytes = (s) => new Uint8Array(Buffer.from(s))
    const under = (p) => Object.keys(h.files).filter((f) => f === p || f.startsWith(p + "/"))
    const running = {}
    const tray = new Proxy({
        update: () => { h.updates++ },
        updateBadge: (b) => { h.badge = b },
        render: (fn) => { h.render = fn },
        onOpen: (fn) => { h.open = fn },
        onClose: (fn) => { h.close = fn },
    }, { get: (o, k) => o[k] || ((a, b) => ({ t: k, a, b })) })
    const ctx = {
        state: (v) => { const s = { value: v, get: () => s.value, set: (x) => { h.sets++; s.value = x } }; return s },
        fieldRef: (v) => ({ current: v, onValueChange() {} }),
        newTray: () => tray,
        dom: { observe() {}, clipboard: { write: (t) => { h.clip = t } } },
        downloader: {
            download: (url, dest) => { h.files[dest] = "zip"; return String(h.downloads.push(url)) },
            watch: (id, cb) => { h.watchers[id] = cb; return () => {} },
            cancel: (id) => {
                h.cancels.push(id)
                const fire = () => h.watchers[id] && h.watchers[id]({ status: "cancelled" })
                if (fakes.lateCancel) h.late.push(fire)
                else setImmediate(fire)
            },
        },
        action: { newAnimePageButton: (p) => (h.anime = { label: p.label, setLabel: (l) => { h.anime.label = l }, setIntent() {}, setTooltipText() {}, onClick: (fn) => { h.anime.click = fn }, mount() {} }) },
        fetch: (url, o) => {
            const body = o && o.body ? JSON.parse(o.body) : {}
            h.asked.push(body.cmd ? url + " " + body.cmd : url)
            const reply = (r) => (r ? Promise.resolve({ ok: !r.status || r.status < 400, status: r.status || 200, json: () => r.json, text: () => r.text || "" }) : Promise.reject(new Error("connection refused")))
            const r = (fakes.fetch || (() => null))(url, body)
            return r && r.hang ? new Promise((res) => h.hung.push((x) => res(reply(x)))) : reply(r)
        },
        jobs: {
            poll: (key, fn, ms, o) => { h.polls[key] = fn; h.every[key] = ms; if (o && o.immediate) fn() },
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
        cacheDir: () => "/cache",
        ...fakes.os,
        stat: (p) => { if (!under(p).length) throw new Error("not found"); return { size: () => (h.files[p] || "").length } },
        readFile: (p) => { h.reads.push(p); if (!(p in h.files)) throw new Error("not found"); return bytes(h.files[p]) },
        openFile: (p) => {
            if (!(p in h.files)) throw new Error("not found")
            return {
                readAt: (buf, off) => { const b = Buffer.from(h.files[p]); if (off + buf.length > b.length) throw new Error("EOF"); buf.set(b.subarray(off, off + buf.length)); return buf.length },
                close() {},
            }
        },
        readDir: (p) => [...new Set(under(p).filter((f) => f !== p).map((f) => f.slice(p.length + 1).split("/")[0]))].map((n) => ({ name: () => n, isDir: () => !((p + "/" + n) in h.files) })),
        removeAll: (p) => under(p).forEach((f) => delete h.files[f]),
        rename: (a, b) => under(a).forEach((f) => { h.files[b + f.slice(a.length)] = h.files[f]; delete h.files[f] }),
        mkdirAll() {},
        truncate: (p) => { h.files[p] = "" },
        cmd: (...args) => {
            const c = { args: args.join(" "), output: () => bytes((fakes.hash || (() => ""))(c)) }
            h.hashes.push(c)
            return c
        },
    }
    const osExtra = {
        unzip: (zip, dest) => {
            if (!(zip in h.files)) throw new Error("open " + zip + ": no such file or directory")
            ;(fakes.unzip || []).forEach((f) => { h.files[dest + "/" + f] = "x".repeat(4096) })
        },
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
                    if (r.hold) { h.held.push(c); return }
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
        $storage: { get: (k) => h.storage.get(k), set: (k, v) => { h.writes.push(k); h.storage.set(k, v) }, remove: (k) => h.storage.delete(k) },
        $os: os,
        $osExtra: osExtra,
        $filepath: { join: (...p) => p.join("/"), base: (p) => p.slice(p.lastIndexOf("/") + 1), dir: (p) => p.slice(0, p.lastIndexOf("/")) },
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

console.log("error channel")
{
    const out = []
    const cap = { console: { log() {}, info() {}, warn() {}, error: (s) => out.push(String(s)) } }
    load("anikoto", cap).reportError("server", "a")
    load("anikoto", cap).reportError("server", "b", "warn")
    for (const name of ["anizone", "animelok"]) {
        load(name, cap).fail("server", "c")
        load(name, cap).fail("server", "d", "info")
    }
    eq(out.map((s) => s.replace(/"t":\d+/, "")), [
        'SEHERRv1 {,"ext":"aq-anikoto","scope":"server","msg":"a"}', 'SEHERRv1 {,"ext":"aq-anikoto","scope":"server","msg":"b","lvl":"warn"}',
        'SEHERRv1 {,"ext":"aq-anizone","scope":"server","msg":"c"}', 'SEHERRv1 {,"ext":"aq-anizone","scope":"server","msg":"d","lvl":"info"}',
        'SEHERRv1 {,"ext":"aq-animelok","scope":"server","msg":"c"}', 'SEHERRv1 {,"ext":"aq-animelok","scope":"server","msg":"d","lvl":"info"}',
    ], "lvl: an error record carries no lvl field; a notice carries its level")
    const sites = (name) => { const src = fs.readFileSync(`${ROOT}/extensions/${name}/provider.ts`, "utf8"); return [(src.match(/, "warn"\)/g) || []).length, (src.match(/, "info"\)/g) || []).length] }
    eq(["anikoto", "anizone", "animelok", "animepahe"].map(sites), [[3, 1], [0, 1], [0, 1], [0, 0]], "lvl: only the listed recovered and expected reports are relabelled")
}

console.log("aquatils (source invariants)")
{
    const src = fs.readFileSync(`${ROOT}/plugins/aquatils/plugin.ts`, "utf8")
    const has = (t) => src.includes(t)
    const count = (t) => src.split(t).length - 1

    eq(has("taskkill"), false, "kill: nothing is stopped by image name alone")
    eq(has("fuser -k"), false, "kill: the port is never cleared without identifying what holds it")
    eq(has('case \\"$X\\" in \\"$D\\"/*|\\"n$D\\"/*) kill -9'), true, "kill: the port sweep checks the executable sits under this plugin's own cache folder")
    eq(has("$p.ExecutablePath -like ('"), true, "kill: the windows sweeps match on the executable path, which a solver started as .\\solver.exe still carries")
    eq([has("[a]quatils"), has("*aquatils"), has("CommandLine -like")], [false, false, false], "kill: no sweep matches an aquatils folder anywhere in a path or command line")
    eq(has("2>/dev/null && pwd -P); then"), true, "kill: the port sweep compares the listener's program with the cache folder's resolved path, which is what /proc and lsof report")
    eq(has('lsof -a -p \\"$P\\" -d txt -Fn'), true, "kill: without /proc the port holder counts as ours only when its program sits under this plugin's own cache folder, not any file it has open")
    const allow = JSON.parse(fs.readFileSync(`${ROOT}/plugins/aquatils/manifest.json`, "utf8")).plugin.permissions.allow
    const scope = (c) => allow.commandScopes.find((s) => s.command === c).description
    eq([allow.commandScopes.map((s) => s.command), /prepare the downloaded Chromium \(chmod, and clear the macOS quarantine flag on both\)/.test(scope("sh")), /check read-only .*ldd on the downloaded Chromium.*never installs system packages/.test(scope("sh")), /\bapt(-get)?\b|\bsudo\b|\broot\b/i.test(scope("sh") + scope("cmd")), /an aquatils folder/.test(scope("sh") + scope("cmd")), [scope("sh"), scope("cmd")].every((d) => /matched exactly on this plugin's own cache folder/.test(d)), /storage\.googleapis\.com/.test(allow.networkAccess.reasoning)],
        [["sh", "cmd"], true, true, false, false, true, true], "manifest: only the sh and cmd scopes exist; sh names the Chromium prep and the read-only probe, says nothing is installed, and no scope mentions apt, sudo or root; both say the stop sweeps match this plugin's own cache folder exactly; the Chromium bucket is a disclosed host")
    eq(count("$osExtra.asyncCmd("), 3, "cmd: only the solver spawn streams raw output; everything else collects it line by line")
    eq(has("continuing unverified"), false, "checksum: a download that can't be verified is never run")
    eq(has('typeof raw === "string"'), false, "checksum: the hash output is read as bytes, not expected as a string")

    eq(count("{ timeout: 900.5 }"), 2, "downloads: the timeout must be non-integral or the host ignores it")

    eq(has('const staging = dir + ".new"'), true, "chromium: the download lands beside the working copy")
    eq(has("$os.rename(dir, previous)"), true, "chromium: the working copy is moved aside, not deleted in place")

    eq(has("aqText(scrubLog(msg))"), true, "privacy: reported errors are scrubbed before they leave")
    eq(has('out.push("lastError=" + scrubLog(err))'), true, "privacy: the diagnostics the user copies are scrubbed")
    eq(has("dl.cancel(fsChromiumDownloadId)"), true, "downloads: Stop cancels a browser download in flight")
    eq(has('setErr("The solver download failed: "'), true, "downloads: a failed solver download is reported, not only noted")
    eq(has('data.solver === "aquatils"'), true, "identity: the probe requires our own solver to claim health")
    eq(has("p.foreign"), true, "identity: another compatible server on the port is reported, not counted as healthy")
    eq(has("tray.tooltip({"), false, "tooltip: the host takes a props object as the tooltip's item, so the item goes first and the text second")
    eq(count('label: "⎘"'), 1, "copy: every ⎘ comes from the one helper that gives it a tooltip")
}

console.log("aquatils (reapers)")
{
    const can = (bin, args) => { try { execFileSync(bin, args, { stdio: "ignore" }); return true } catch (_e) { return false } }
    const shOk = can("sh", ["-c", "printf x | grep -qE x"])
    const psOk = process.platform === "win32" && can("powershell", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
    const sh = (script, env) => execFileSync("sh", [], { input: script, env: { ...process.env, ...env }, encoding: "utf8" })
    const procpsEsc = (s) => s.replace(/[^\x00-\x7f]/gu, (c) => "?".repeat(Buffer.byteLength(c)))
    const stopCmds = async (os) => {
        const h = bootPlugin({ os, storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}`, "fs.wantChromium": false } })
        await h.settle()
        h.cmds.length = 0
        h.fire("fs-stop")
        await h.settle()
        return h.cmds.map((c) => c.args)
    }

    await run("reap: on Linux/macOS each pkill is anchored on this plugin's own cache folder with every regex character escaped; the real solver, Chromium and a browser on the solver's profile still match, and its own shell, an editor, or an aquatils folder elsewhere never do; a non-ASCII folder matches both raw and as procps escapes it outside a UTF-8 locale", async (what) => {
        if (!shOk) { console.log(`  skip ${what} (no sh)`); return }
        const sweep = async (cache) => {
            const dir = `${cache}/aquatils`
            const lines = [
                ["solver", `${dir}/${SV}/solver/solver`],
                ["oldSolver", `${dir}/0.1.99/solver/solver`],
                ["chrome", `${dir}/chromium/chrome-linux64/chrome --type=renderer --user-data-dir=${dir}/browser-profile`],
                ["onProfile", `/usr/bin/chromium --no-first-run --user-data-dir=${dir}/browser-profile --headless=new`],
                ["editor", `vim ${dir}/${SV}/solver/solver`],
                ["solverSibling", `${dir}/${SV}/solver/solver.old --port 8191`],
                ["elsewhere", `/home/u/aquatils/${SV}/solver/solver`],
                ["elsewhereChrome", "/home/u/aquatils/chromium/chrome-linux64/chrome --user-data-dir=/home/u/aquatils/browser-profile"],
                ["siblingProfile", `/usr/bin/chromium --user-data-dir=${dir}/browser-profile2`],
                ["profileTool", `du -sh ${dir}/browser-profile`],
            ].concat(/\./.test(cache) ? [["dotVariant", `${dir.replace(".", "X")}/${SV}/solver/solver`], ["bracketVariant", `${dir.replace("[a]", "a")}/chromium/chrome-linux64/chrome`]] : [])
                .concat(/[^\x00-\x7f]/.test(cache) ? [["solverEscaped", procpsEsc(`${dir}/${SV}/solver/solver`)], ["chromeEscaped", procpsEsc(`${dir}/chromium/chrome-linux64/chrome --user-data-dir=${dir}/browser-profile`)], ["asciiVariant", `${dir.replace("é", "X")}/${SV}/solver/solver`]] : [])
            const cmds = (await stopCmds({ cacheDir: () => cache })).filter((a) => a.includes("pkill")).map((a) => a.slice("sh -c ".length))
            const hits = (cmd) => {
                const all = lines.concat([["self", `sh -c ${cmd}`]])
                const out = sh('pkill() { for a; do p=$a; done; printf "%s\\n" "$L" | grep -E -- "$p"; }; lsof() { :; }; ss() { :; }; ' + cmd, { L: all.map((l) => l[1]).join("\n") })
                return out.split("\n").filter(Boolean).map((o) => (all.find((l) => l[1] === o) || [o])[0])
            }
            return [cmds.length, cmds.map(hits)]
        }
        const want = [2, [["solver", "oldSolver"], ["chrome", "chrome", "onProfile"]]]
        const wantNonAscii = [2, [["solver", "oldSolver", "solverEscaped"], ["chrome", "chromeEscaped", "chrome", "onProfile", "chromeEscaped"]]]
        eq([await sweep("/h o/.c[a](c)he{1}+*?|^$\\'q"), await sweep("/srv/cache"), await sweep("/home/josé/田中/cache")], [want, want, wantNonAscii], what)
    })

    await run("reap: with no readable cache folder, Stop sweeps nothing and doesn't throw", async (what) => {
        const cmds = await stopCmds({ cacheDir: () => { throw new Error("no cache folder") } })
        eq(cmds.filter((a) => /pkill|Get-CimInstance/.test(a)), [], what)
    })

    await run("reap: the port sweep kills the listener only when its program sits under this plugin's own cache folder, via /proc or lsof, even when that folder's name has shell, glob and regex characters", async (what) => {
        if (!shOk) { console.log(`  skip ${what} (no sh)`); return }
        const [tmp, cache] = sh('T=$(mktemp -d) && mkdir -p -- "$T/$N/aquatils" && printf "%s\\n" "$T" && cd -- "$T/$N" && pwd -P', { N: "c.a[b](c) {1}+^$'q" }).trim().split("\n")
        const dir = `${cache}/aquatils`
        const cmd = (await stopCmds({ cacheDir: () => cache })).find((a) => a.includes("pkill -9 -f")).slice("sh -c ".length)
        const stubs = 'pkill() { :; }; ss() { :; }; kill() { echo "KILL $*"; }; readlink() { [ -n "$EXE" ] && printf "%s\\n" "$EXE"; }; lsof() { case "$1" in -t*) echo 4242;; *) printf "%s\\n" "$TXT";; esac; }; '
        const killed = (EXE, TXT = "") => sh(stubs + cmd, { EXE, TXT }).trim()
        const got = [
            killed(`${dir}/${SV}/solver/solver`),
            killed(`${dir}/${SV}/solver/solver (deleted)`),
            killed(`/home/u/aquatils/${SV}/solver/solver`),
            killed(`${dir}x/${SV}/solver/solver`),
            killed(`${cache.replace(".", "X")}/aquatils/${SV}/solver/solver`),
            killed("", `p4242\nftxt\nn/home/u/aquatils/solver\nn${dir}/${SV}/solver/solver`),
            killed("", `p4242\nftxt\nn/usr/bin/vim\nn/home/u/aquatils/${SV}/solver/solver`),
        ]
        sh('rm -rf -- "$T"', { T: tmp })
        eq(got, ["KILL -9 4242", "KILL -9 4242", "", "", "", "KILL -9 4242", ""], what)
    })

    await run("reap: on Windows the solver and Chromium sweeps match only executables under this plugin's own cache folder, with -like wildcards and quotes in its path escaped and no %VAR% or !VAR! left for cmd to expand, even with delayed expansion on", async (what) => {
        if (!psOk) { console.log(`  skip ${what} (no powershell)`); return }
        const cache = "C:\\Us'er\u2019 [1]\\Ap`p*Da?ta\\p%OS%c!OS!d!e\\Local"
        const dir = `${cache}/aquatils`
        const procs = [
            [1, "solver.exe", `${dir}\\${SV}\\solver\\solver.exe`],
            [2, "solver.exe", `C:\\Users\\x\\aquatils\\${SV}\\solver\\solver.exe`],
            [3, "solver.exe", `C:\\Us'er\u2019 1\\Ap\`pXDaXta\\p%OS%c!OS!d!e\\Local/aquatils\\${SV}\\solver\\solver.exe`],
            [4, "chrome.exe", `${dir}\\chromium\\chrome-win64\\chrome.exe`],
            [5, "chrome.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
            [6, "chrome.exe", "D:\\aquatils\\chromium\\chrome-win64\\chrome.exe"],
            [7, "chrome.exe", `${dir}\\chromiumX\\chrome.exe`],
            [8, "solver.exe", `${dir.replace("%OS%", "Windows_NT")}\\${SV}\\solver\\solver.exe`],
            [9, "chrome.exe", `${dir.replace("%OS%", "Windows_NT")}\\chromium\\chrome-win64\\chrome.exe`],
            [10, "solver.exe", `${dir.replace(/%/g, "Y")}\\${SV}\\solver\\solver.exe`],
            [11, "solver.exe", `${dir.replace(/!/g, "Y")}\\${SV}\\solver\\solver.exe`],
            [12, "chrome.exe", `${dir.replace("!OS!", "Windows_NT")}\\chromium\\chrome-win64\\chrome.exe`],
        ]
        const env = { ...process.env, OS: "Windows_NT", AQ_PROCS: JSON.stringify(procs.map(([ProcessId, Name, ExecutablePath]) => ({ ProcessId, Name, ExecutablePath }))) }
        const scripts = (await stopCmds({ platform: "windows", cacheDir: () => cache })).filter((a) => a.includes("Get-CimInstance")).map((a) => a.slice("cmd /c powershell -NoProfile -NonInteractive -Command ".length))
        const hits = (script, viaCmd) => {
            const s = script.replace("Get-CimInstance Win32_Process", () => "($env:AQ_PROCS | ConvertFrom-Json)").replace("Stop-Process -Id $p.ProcessId -Force", () => "Write-Output $p.ProcessId")
            const args = ["-NoProfile", "-NonInteractive"].concat(viaCmd ? ["-Command", s] : ["-EncodedCommand", Buffer.from(s, "utf16le").toString("base64")])
            try {
                return execFileSync(viaCmd ? "cmd" : "powershell", viaCmd ? viaCmd.concat("powershell", args) : args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean).map(Number)
            } catch (_e) {
                return ["powershell rejected the script"]
            }
        }
        eq([scripts.length, scripts.map((s) => hits(s, false)), scripts.map((s) => hits(s, ["/c"])), scripts.map((s) => hits(s, ["/v:on", "/c"]))], [2, [[1], [4]], [[1], [4]], [[1], [4]]], what)
    })
}

console.log("aquatils (boot)")
{
    const BIN = `/cache/aquatils/${SV}/solver/solver`
    const LOG = `/cache/aquatils/${SV}/solver.log`
    const INSTALLED = { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}`, "fs.wantChromium": false }
    const ours = (url) => (url === "http://127.0.0.1:8191/v1" ? { json: { solver: "aquatils", version: `${SV}`, sessions: ["seanime"] } } : null)

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
            "fs-autostart-no", "fs-autostart-toggle", "fs-autostart-yes", "fs-autoupdate-toggle", "fs-chromium-toggle", "fs-consent-toggle", "fs-copy-cache-path", "fs-copy-deps", "fs-copy-diag",
            "fs-copy-url", "fs-customtls-toggle", "fs-dns-custom-save", "fs-doctor", "fs-enable-chromium", "fs-engine-set-chrome", "fs-engine-set-webview2",
            "fs-help-customtls", "fs-help-engine", "fs-help-pacing", "fs-help-verbose", "fs-help-wv2refresh", "fs-help-wv2utls", "fs-help-wv2warm",
            "fs-logs-clear", "fs-logs-copy", "fs-mode-binary", "fs-mode-remote", "fs-pacing-toggle", "fs-remove-chromium",
            "fs-remove-solver", "fs-restart", "fs-restart-update", "fs-save", "fs-simple-start", "fs-start", "fs-stealth", "fs-stop", "fs-test",
            "fs-update-chromium", "fs-verbose-toggle", "fs-wv2refresh-toggle", "fs-wv2utls-toggle", "fs-wv2warm-toggle",
            "seh-clear", "seh-copy-all", "seh-notify-toggle", "seh-save", "ui-mode-toggle", "view-cf", "view-errors", "view-settings",
        ]], what)
    })

    await run("remote: Start with the remote host down ends Off, not Starting", async (what) => {
        const h = bootPlugin({ storage: { "fs.mode": "remote", "fs.host": "10.0.0.5" } })
        await h.settle()
        h.fire("fs-simple-start")
        await h.settle()
        for (let i = 0; i < 3; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        eq(h.status(), "down", what)
    })

    const sweeps = (h) => h.cmds.filter((c) => c.args.includes("pkill -9 -f")).length

    await run("remote: the Simple view offers Reconnect, not the local download, and no local dependency check runs", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.mode": "remote", "fs.host": "10.0.0.5" }, files: { [BIN]: "x", "/cache/aquatils/chromium/chrome-linux64/chrome": "x" } })
        await h.settle()
        for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        const view = JSON.stringify(h.render())
        eq([h.status(), view.includes('"label":"Reconnect"'), view.includes("Download & start"), h.cmds.filter((c) => c.args.includes("Xvfb")).length], ["down", true, false, 0], what)
    })

    await run("mode: switching to Remote stops the local solver and re-checks; switching back re-checks the local one", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.host": "10.0.0.5" }, files: { [BIN]: "x" }, fetch: ours })
        await h.settle()
        h.fire("fs-mode-remote")
        await h.settle()
        const remote = [h.status(), sweeps(h)]
        h.fire("fs-mode-binary")
        await h.settle()
        eq([remote, h.status(), h.spawns().length], [["unknown", 1], "up", 0], what)
    })

    await run("mode: leaving a Remote host that doesn't answer re-checks the local solver at once, and the old host's late answer is dropped", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.mode": "remote", "fs.host": "10.0.0.5" }, files: { [BIN]: "x" }, fetch: (u, b) => (u.startsWith("http://10.0.0.5") ? { hang: true } : ours(u, b)) })
        await h.settle()
        h.fire("fs-mode-binary")
        await h.settle()
        const local = h.status()
        h.hung.splice(0).forEach((f) => f({ json: { status: "ok" } }))
        await h.settle()
        eq([local, h.status(), h.reported], ["up", "up", []], what)
    })

    await run("anime button: reads checking before the first answer and never relaunches a start in progress", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.everInstalled": true }, files: { [BIN]: "x" } })
        await h.settle()
        const checking = h.anime.label
        h.anime.click()
        await h.settle()
        const idle = h.spawns().length
        h.fire("fs-start")
        await h.settle()
        h.anime.click()
        await h.settle()
        eq([checking, idle, h.spawns().length, h.status()], ["Solver ◌ checking", 0, 1, "starting"], what)
    })

    await run("launch: an OS/arch without a build ends Off with the reason shown, not Starting", async (what) => {
        const h = bootPlugin({ os: { arch: "386" } })
        await h.settle()
        h.fire("fs-simple-start")
        await h.settle()
        eq([h.status(), /No prebuilt binary/.test(h.reported[h.reported.length - 1] || "")], ["down", true], what)
    })

    await run("download: a Restart mid-download keeps the new download's state and offers Cancel download", async (what) => {
        const h = bootPlugin({ storage: { "fs.consent": true, "fs.wantChromium": false } })
        await h.settle()
        h.fire("fs-simple-start")
        await h.settle()
        h.fire("fs-restart")
        await h.settle()
        eq([h.downloads.length, h.status(), JSON.stringify(h.render()).includes('"label":"Cancel download"'), h.reported], [2, "starting", true, []], what)
    })

    const CHR = "/cache/aquatils/chromium/chrome-linux64/chrome"
    const CFT = "https://storage.googleapis.com/chrome-for-testing-public/"
    const feedOf = (plt, url = CFT + "200.0.0.0/" + plt + "/chrome-" + plt + ".zip") => (u, body) => (/chrome-for-testing\/last-known/.test(u)
        ? { json: { channels: { Stable: { version: "200.0.0.0", downloads: { chrome: [{ platform: plt, url }] } } } } }
        : ours(u, body))
    const feed = feedOf("linux64")

    await run("chromium update: downloads while the solver keeps running; a Restart meanwhile restarts once with no false error", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.chromiumVer": "100.0.0.0", "fs.chromiumCheckedAt": 1767225600000 }, files: { [BIN]: "x", [CHR]: "x" }, fetch: feed })
        await h.settle()
        h.fire("fs-update-chromium")
        await h.settle()
        h.fire("fs-update-chromium")
        await h.settle()
        const during = [h.status(), h.downloads.length, sweeps(h)]
        h.fire("fs-restart")
        await h.settle()
        eq([during, sweeps(h), h.spawns().length, h.reported], [["up", 1, 0], 1, 1, []], what)
    })

    await run("chromium update: a finished download shows Starting for the swap, then relaunches on the new copy", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.chromiumVer": "100.0.0.0" }, files: { [BIN]: "x", [CHR]: "x" }, fetch: feed, unzip: ["chrome-linux64/chrome"] })
        await h.settle()
        h.fire("fs-update-chromium")
        await h.settle()
        h.watchers["1"]({ status: "completed" })
        const swapping = h.status()
        await h.settle()
        eq([swapping, h.storage.get("fs.chromiumVer"), h.spawns().length, CHR in h.files], ["starting", "200.0.0.0", 1, true], what)
    })

    await run("exit: a stale bind line in solver.log does not mask this launch's library error", async (what) => {
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

    const winExit = async (lines, log) => {
        const h = bootPlugin({ os: { platform: "windows" }, storage: INSTALLED, files: { [BIN + ".exe"]: "x", ...(log ? { [LOG]: log } : {}) } })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        const s = h.spawns()[0]
        lines.forEach(s.fail)
        s.exit(1)
        await h.settle()
        return [h.storage.get("fs.avBlocked") === true, /^(Antivirus|Windows refused)/.exec(h.reported[h.reported.length - 1] || "")?.[0]]
    }
    eq(await winExit(["Access is denied."]), [false, "Windows refused"], "windows: a refusal to execute is reported as itself")
    eq(await winExit(["Access is denied."], "Operation did not complete successfully because the file contains a virus\n"), [false, "Windows refused"], "windows: a scanner line from an earlier run is not scanner evidence")
    eq(await winExit(["Operation did not complete successfully because the file contains a virus or potentially unwanted software.", "Access is denied."]), [true, "Antivirus"], "windows: a scanner verdict in this launch's output outranks the refusal")

    await run("boot: auto-start with the solver not answering launches it at load, before any later poll, and exactly once", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.autoStart": true }, files: { [BIN]: "x" } })
        await h.settle()
        const atLoad = [h.spawns().length, h.status()]
        for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        eq([atLoad, h.spawns().length, sweeps(h)], [[1, "starting"], 1, 1], what)
    })

    await run("boot: auto-start does not launch over a port held by another server", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.autoStart": true }, files: { [BIN]: "x" }, fetch: () => ({ json: { status: "ok" } }) })
        await h.settle()
        eq([h.spawns().length, h.status()], [0, "down"], what)
    })

    await run("poll: a steady Running solver writes no storage, sets no state and renders nothing while the tray is closed", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.avBlocked": true }, files: { [BIN]: "x" }, fetch: ours })
        await h.settle()
        const boot = [h.writes.slice().sort(), h.storage.get("fs.avBlocked"), h.storage.get("fs.everInstalled")]
        h.writes.length = 0
        const sets = h.sets, updates = h.updates
        for (let i = 0; i < 3; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        eq([boot, h.writes, h.sets - sets, h.updates - updates, h.status()], [[["fs.avBlocked", "fs.everInstalled"], false, true], [], 0, 0, "up"], what)
    })

    await run("poll: in Advanced the solver's metrics are fetched only while the tray is open", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch: ours })
        await h.settle()
        h.fire("ui-mode-toggle")
        const metrics = () => h.asked.filter((u) => / metrics$/.test(u)).length
        for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        const closed = metrics()
        h.open()
        h.now += 5000
        await h.tick("aquatils-fs-poll")
        await h.settle()
        eq([closed, metrics() > 0], [0, true], what)
    })

    await run("poll: the error log is read every 60 s with the tray closed, every 6 s with it open or notifications on", async (what) => {
        const h = bootPlugin()
        const closed = h.every["aquatils-seh-poll"]
        h.open()
        const open = h.every["aquatils-seh-poll"]
        h.close()
        eq([closed, open, h.every["aquatils-seh-poll"], bootPlugin({ storage: { "seh.notify": true } }).every["aquatils-seh-poll"]], [60000, 6000, 60000, 6000], what)
    })

    await run("launch: a stored headless flag gives no SOLVER_HEADLESS and is removed at load", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.browserMode": "headless", "fs.logFilter": true }, files: { [BIN]: "x" } })
        await h.settle()
        const kept = ["fs.browserMode", "fs.logFilter"].filter((k) => h.storage.has(k))
        h.fire("fs-start")
        await h.settle()
        const env = h.spawns()[0].cmd.env.filter((e) => /^SOLVER_(HEADLESS|XVFB|BROWSER_MODE)=/.test(e))
        eq([kept, env], [[], ["SOLVER_BROWSER_MODE=auto", "SOLVER_XVFB=1"]], what)
    })

    const SUMS = `https://github.com/aquaryuo/seanime/releases/download/solver-v${SV}/aquatils-solver_checksums.txt`
    const LINUX_SUM = "5132575d736341a4f80aaba04d86357db46d5a2eb852f75eb956d1dbcc41153b"
    const WIN_SUM = "c4f8270aebd421fe1af31dca7e0b400c816c356bd05608153eed401820d71a02"
    const sums = (url) => (url === SUMS ? { text: LINUX_SUM + "  solver-browser_linux_x64.zip\n" + WIN_SUM + "  solver-browser_windows_x64.zip\n" } : null)
    const install = async (fakes) => {
        const h = bootPlugin({ storage: { "fs.consent": true, "fs.wantChromium": false }, unzip: ["solver/solver", "solver/solver.exe"], ...fakes })
        await h.settle()
        h.fire("fs-simple-start")
        await h.settle()
        h.watchers["1"]({ status: "completed" })
        await h.settle()
        return h
    }
    const lastErr = (h) => h.reported[h.reported.length - 1] || ""

    await run("checksum: a download that doesn't match the published SHA-256 is discarded and the solver is never launched", async (what) => {
        const h = await install({ fetch: sums, hash: () => "0".repeat(64) + `  /cache/aquatils/${SV}/solver-browser_linux_x64.zip\n` })
        eq([h.hashes.map((c) => c.args), h.spawns().length, h.status(), h.storage.get("fs.solverReady") || "", /did not match the checksum/.test(lastErr(h))],
            [[`sh -c sha256sum '/cache/aquatils/${SV}/solver-browser_linux_x64.zip'`], 0, "down", "", true], what)
    })

    await run("checksum: a download that can't be verified is discarded with the reason and never launched", async (what) => {
        const noTool = await install({ fetch: sums })
        const noSums = await install({ hash: () => LINUX_SUM + "  x\n" })
        eq([noTool, noSums].map((h) => [h.spawns().length, h.status(), (/^Couldn't verify the solver download \((.*?)\)/.exec(lastErr(h)) || [])[1]]),
            [[0, "down", "this machine couldn't compute its SHA-256"], [0, "down", "the checksum published with the release couldn't be fetched"]], what)
    })

    const certutil = (c) => (c.args === "cmd /c certutil -hashfile solver-browser_windows_x64.zip SHA256" && c.dir === `/cache/aquatils/${SV}`
        ? "SHA256 hash of solver-browser_windows_x64.zip:\r\n" + WIN_SUM + "\r\nCertUtil: -hashfile command completed successfully.\r\n"
        : "")

    await run("checksum: on Windows certutil hashes the file by name from its folder, and a verified solver starts as .\\solver.exe from its own folder", async (what) => {
        const h = await install({ os: { platform: "windows" }, fetch: sums, hash: certutil })
        const s = h.spawns()[0] || { cmd: {} }
        eq([h.spawns().length, s.args, s.cmd.dir, h.status()], [1, "cmd /c .\\solver.exe", `/cache/aquatils/${SV}/solver`, "starting"], what)
    })

    await run("checksum: a solver installed before downloads were verified is fetched and verified again before it runs", async (what) => {
        const h = bootPlugin({ storage: { "fs.solverReady": `${SV}`, "fs.everInstalled": true, "fs.wantChromium": false }, files: { [BIN]: "x" }, fetch: sums, hash: () => LINUX_SUM + "  x\n", unzip: ["solver/solver"] })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        const before = [h.downloads.length, h.hashes.length, h.spawns().length]
        h.watchers["1"] && h.watchers["1"]({ status: "completed" })
        await h.settle()
        eq([before, h.hashes.length, h.spawns().length, h.storage.get("fs.solverVerified")], [[1, 0, 0], 1, 1, `${SV}`], what)
    })

    await run("exit: after two silent starts remove the solver, the fresh copy gets two silent starts of its own", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.everInstalled": true }, files: { [BIN]: "x" }, fetch: sums, hash: () => LINUX_SUM + "  x\n", unzip: ["solver/solver"] })
        await h.settle()
        const silent = async () => { h.spawns()[h.spawns().length - 1].exit(1); await h.settle() }
        for (let i = 0; i < 2; i++) { h.fire("fs-start"); await h.settle(); await silent() }
        const removed = !(BIN in h.files)
        h.fire("fs-start")
        await h.settle()
        h.watchers["1"] && h.watchers["1"]({ status: "completed" })
        await h.settle()
        await silent()
        eq([removed, h.spawns().length, BIN in h.files, /exited \(code 1\) with no output/.test(lastErr(h))], [true, 3, true, true], what)
    })

    await run("exit: a bind error from one launch doesn't make the next launch's silent exit look like a bind race", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" } })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        h.spawns()[0].fail("listen tcp 127.0.0.1:8191: bind: address already in use")
        h.spawns()[0].exit(1)
        await h.settle()
        const first = lastErr(h)
        h.fire("fs-start")
        await h.settle()
        h.spawns()[1].exit(1)
        await h.settle()
        eq([/still shutting down/.test(first), /exited \(code 1\) with no output/.test(lastErr(h))], [true, true], what)
    })

    await run("start: a solver that never answers times out naming this launch's own output, not an older log line", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x", [LOG]: "2026-01-01 00:00:00 ERROR old failure from last week\n" } })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        h.spawns()[0].fail("chromium: failed to launch the browser")
        for (let i = 0; i < 18; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        eq([h.status(), /failed to launch the browser/.test(lastErr(h)), /old failure/.test(lastErr(h))], ["down", true, false], what)
    })

    const DEB = "/cache/aquatils/chromium/chrome-linux64/deb.deps"
    const RPM = "/cache/aquatils/chromium/chrome-linux64/rpm.deps"
    const probed = (lines, code) => (a) => (a.includes("command -v Xvfb") ? { out: lines, code } : {})
    const probeRuns = (h) => h.cmds.filter((c) => c.args.includes("command -v Xvfb"))
    const SU = (c) => "sh -c '" + ('S=; [ "$(id -u)" = 0 ] || S=$(command -v sudo || command -v doas || echo sudo); $S ' + c).replace(/'/g, "'\\''") + "'"
    const INSTALLERS = /\b(sudo|pkexec|doas|dpkg)\b|apt-get (update|install|satisfy)|dnf install|zypper .*install|pacman -S|apk add/

    await run("deps: the probe's Xvfb, ldd and package-manager lines become one apt command built from deb.deps, shown with ⎘ and a line to run it and press Start; the notification points at it; nothing is probed before the solver is installed and no handler ever runs an installer", async (what) => {
        const sh = probed(["NOXVFB", "PM apt-get", "\tlibnss3.so => not found", "\tlibgbm.so.1 => not found"])
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x", [CHR]: "x", [DEB]: "libasound2 (>= 1.0.17)\r\nlibatk-bridge2.0-0 (>= 2.5.3)\n\nlibc6 (>= 2.26)\n" }, sh })
        const fresh = bootPlugin({ sh })
        await h.settle()
        await fresh.settle()
        const view = JSON.stringify(h.render())
        h.fire("fs-copy-deps")
        h.fire("ui-mode-toggle")
        const adv = JSON.stringify(h.render())
        const shown = [view.includes("need these on this machine (uTLS still works): Xvfb, libnss3.so, libgbm.so.1."), view.includes('"b":{"text":"Copy install command"}'), view.includes("Run it in a terminal, then press Start."), view.includes("Install all dependencies"), adv.includes("Run it in a terminal, then press Start.") && adv.includes('"label":"Start","onClick":"fs-start"'), h.clip, h.notes.slice(), probeRuns(h).map((c) => c.args.startsWith(`sh -c c='${CHR}'; `)), probeRuns(fresh).length]
        for (const id of Object.keys(h.handlers)) { try { h.fire(id) } catch (_e) {} }
        await h.settle()
        eq([shown, h.cmds.concat(h.hashes).map((c) => c.args).filter((a) => INSTALLERS.test(a))], [[true, true, true, false, true,
            SU("apt-get update && $S apt-get install -y --no-install-recommends xvfb libx11-xcb1 && $S apt-get satisfy -y --no-install-recommends 'libasound2 (>= 1.0.17), libatk-bridge2.0-0 (>= 2.5.3), libc6 (>= 2.26)'"),
            ["Aqua's Utils: the browser solver is missing 3 system packages on this machine. Open the tray to copy the install command, run it in a terminal, then press Start."],
            [true], 0], []], what)
    })

    await run("deps: dnf and zypper take rpm.deps minus rpmlib() and rich deps, pacman and apk name their packages, NixOS gets a snippet, without the Chromium lists apt and dnf cover Xvfb only but fall back to prose when libraries are missing, an unknown system gets the names in prose, and a failed probe shows nothing", async (what) => {
        const rpm = "rpmlib(CompressedFileNames) <= 3.0.4-1\nlibX11.so.6()(64bit)\n(libfoo.so.1()(64bit) or libbar)\nlibasound.so.2(ALSA_0.9)(64bit)\n"
        const withLists = { [CHR]: "x", [RPM]: rpm }
        const copied = async (lines, files = {}, code) => {
            const h = bootPlugin({ storage: { ...INSTALLED, "fs.wantChromium": true }, files: { [BIN]: "x", ...files }, sh: probed(lines, code) })
            await h.settle()
            h.fire("fs-copy-deps")
            return [h.clip || "", JSON.stringify(h.render()), h.notes.slice()]
        }
        const got = []
        for (const [lines, files] of [[["NOXVFB", "PM dnf"], withLists], [["PM zypper", "\tlibnss3.so => not found"], withLists], [["NOXVFB", "PM pacman"]], [["MUSL", "PM apk"]], [["NIXOS", "NOXVFB"]], [["NOXVFB", "PM apt-get"]], [["NOXVFB", "PM dnf"]]]) got.push(await copied(lines, files))
        const [prose, view, proseNotes] = await copied(["NOXVFB", "\tlibnss3.so => not found"], { [CHR]: "x" })
        const failed = await copied(["NOXVFB", "PM apt-get"], {}, 2)
        const unlisted = []
        for (const pm of ["apt-get", "dnf"]) unlisted.push(await copied(["PM " + pm, "	libnss3.so => not found"], { [CHR]: "x" }))
        eq([got.map((g) => g[0]), prose, view.includes("need these on this machine (uTLS still works): Xvfb, libnss3.so."), view.includes("Install them with your system's package manager, then press Start."), view.includes("Copy install command"), failed[0], failed[1].includes("need these on this machine"), failed[2], proseNotes, got[4][2], unlisted.map((u) => [u[0], u[1].includes("need these on this machine (uTLS still works): libnss3.so."), u[1].includes("Install them with your system's package manager, then press Start.")])], [[
            SU("dnf install -y xorg-x11-server-Xvfb 'libX11.so.6()(64bit)' 'libasound.so.2(ALSA_0.9)(64bit)'"),
            SU("zypper -n install xorg-x11-server-Xvfb 'libX11.so.6()(64bit)' 'libasound.so.2(ALSA_0.9)(64bit)'"),
            SU("pacman -Syu --needed xorg-server-xvfb chromium"),
            SU("apk add chromium xvfb"),
            "environment.systemPackages = with pkgs; [ chromium xorg-server ];",
            SU("apt-get update && $S apt-get install -y --no-install-recommends xvfb"),
            SU("dnf install -y xorg-x11-server-Xvfb"),
        ], "", true, true, false, "", false, [],
            ["Aqua's Utils: the browser solver is missing 2 system packages on this machine. Open the tray to see what to install, install it with your package manager, then press Start."],
            ["Aqua's Utils: the browser solver is missing 2 system packages on this machine. Open the tray to copy the configuration line, add it and rebuild, then press Start."], [["", true, true], ["", true, true]]], what)
    })

    await run("deps: a probe that answers after a newer one is ignored, and a Stop while the probe runs starts no Chromium download and no solver", async (what) => {
        const boot = async () => {
            const h = bootPlugin({ storage: { ...INSTALLED, "fs.wantChromium": true }, files: { [BIN]: "x" }, fetch: feed, sh: (a) => (a.includes("command -v Xvfb") ? { hold: true } : {}) })
            await h.settle()
            h.fire("fs-start")
            await h.settle()
            return h
        }
        const answer = async (h, c, lines) => { lines.forEach(c.line); c.exit(0); await h.settle() }
        const late = await boot()
        const [bootProbe, startProbe] = late.held
        await answer(late, startProbe, ["PM apt-get"])
        await answer(late, bootProbe, ["NOXVFB", "PM apt-get"])
        const stop = await boot()
        stop.fire("fs-stop")
        await stop.settle()
        await answer(stop, stop.held[1], ["PM apt-get"])
        eq([late.held.length, JSON.stringify(late.render()).includes("need these on this machine"), stop.held.length, stop.downloads.length, stop.spawns().length], [2, false, 2, 0, 0], what)
    })

    await run("probe: run by a real shell, it passes over a chromium that is a snap wrapper and reports the next one, and reports musl only when ldd is musl's", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.wantChromium": true }, files: { [BIN]: "x" } })
        await h.settle()
        const script = probeRuns(h)[0].args.replace(/^sh -c /, "")
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-probe-"))
        fs.writeFileSync(path.join(dir, "chromium"), '#!/bin/sh\nexec /snap/bin/chromium "$@"\n', { mode: 0o755 })
        fs.writeFileSync(path.join(dir, "chromium-browser"), '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n', { mode: 0o755 })
        const probe = (ldd) => {
            fs.writeFileSync(path.join(dir, "ldd"), ldd, { mode: 0o755 })
            return execFileSync("sh", ["-c", 'PATH="$PWD:$PATH"; ' + script], { cwd: dir, encoding: "utf8" })
        }
        let outs = null
        try { outs = [probe('#!/bin/sh\necho "ldd (GNU libc) 2.39"\n'), probe('#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n')] } catch (e) { if (e.code !== "ENOENT") throw e } finally { fs.rmSync(dir, { recursive: true, force: true }) }
        if (outs === null) { console.log("  skip " + what + " (no sh on PATH)"); return }
        eq([outs[0].split("\n").filter((l) => l.startsWith("SYS ")).map((l) => l.slice(l.lastIndexOf("/") + 1)), outs.map((o) => /^MUSL$/m.test(o))], [["chromium-browser"], [false, true]], what)
    })

    await run("chrome: a browser already installed on PATH is handed to the solver, and the plugin's own Chromium folder isn't touched", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, sh: (a) => (a.includes("command -v \"$c\"") ? { out: ["/usr/bin/chromium"] } : {}) })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        const s = h.spawns()[0]
        eq([s.cmd.env.filter((e) => e.startsWith("SOLVER_CHROME=")), s.args.includes("/cache/aquatils/chromium")], [["SOLVER_CHROME=/usr/bin/chromium"], false], what)
    })

    await run("chromium on macOS: unpacked with ditto; a failed unpack is named, isn't downloaded again on the next Start, and Update Chromium retries it", async (what) => {
        const MAC = "/cache/aquatils/chromium/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        const macFeed = (url) => (/chrome-for-testing/.test(url)
            ? { json: { channels: { Stable: { version: "200.0.0.0", downloads: { chrome: [{ platform: "mac-arm64", url: CFT + "200.0.0.0/mac-arm64/chrome-mac-arm64.zip" }] } } } } }
            : null)
        let dittos = 0
        const h = bootPlugin({ os: { platform: "darwin", arch: "arm64" }, storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}` }, files: { [BIN]: "x" }, fetch: macFeed, sh: (a) => {
            if (!a.includes("ditto -x -k")) return {}
            if (++dittos === 1) return { out: ["ditto: Couldn't read PKZip signature"], code: 1 }
            h.files[MAC.replace("/chromium/", "/chromium.new/")] = "x"
            return {}
        } })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        h.watchers["1"]({ status: "completed" })
        await h.settle()
        const failed = [/PKZip signature/.test(lastErr(h)), /left in place/.test(lastErr(h)), h.storage.get("fs.chromiumFailVer"), h.spawns().length]
        h.fire("fs-start")
        await h.settle()
        const skipped = [h.downloads.length, h.spawns().length]
        h.fire("fs-update-chromium")
        await h.settle()
        h.watchers["2"]({ status: "completed" })
        await h.settle()
        const s = h.spawns()[h.spawns().length - 1]
        const env = s.cmd.env.filter((e) => e.startsWith("SOLVER_CHROME="))
        eq([failed, skipped, h.downloads.length, h.storage.has("fs.chromiumFailVer"), env, s.args.includes("xattr -dr com.apple.quarantine '/cache/aquatils/chromium'"), dittos],
            [[true, false, "200.0.0.0", 1], [1, 2], 2, false, ["SOLVER_CHROME=" + MAC], true, 2], what)
    })

    await run("prune: only other solver versions are removed, never the browser profile, state or Chromium, and Remove solver leaves them too", async (what) => {
        const OLD = "/cache/aquatils/0.1.99/solver/solver"
        const keep = ["/cache/aquatils/browser-profile/wv2host/Local State", "/cache/aquatils/state/cookies.json", CHR]
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x", [OLD]: "x", ...Object.fromEntries(keep.map((f) => [f, "x"])) } })
        await h.settle()
        const boot = [BIN in h.files, OLD in h.files]
        h.fire("fs-remove-solver")
        await h.settle()
        eq([boot, BIN in h.files, keep.filter((f) => f in h.files).length], [[true, false], false, 3], what)
    })

    await run("quarantine: a solver missing on Linux is offered again, not blamed on antivirus; on Windows a binary gone right after extraction is", async (what) => {
        const h = bootPlugin({ storage: { "fs.solverReady": `${SV}`, "fs.everInstalled": true, "fs.consent": true, "fs.wantChromium": false } })
        await h.settle()
        for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        const view = JSON.stringify(h.render())
        const w = await install({ os: { platform: "windows" }, fetch: sums, hash: certutil, unzip: [] })
        eq([h.notes.some((n) => /antivirus/.test(n)), view.includes("Copy folder to exclude"), view.includes("The solver's files were removed (a cache cleanup?). Press Start to download them again."), w.spawns().length, w.storage.get("fs.avBlocked"), /^Antivirus.*right after it was downloaded/.test(lastErr(w))],
            [false, false, true, 0, true, true], what)
    })

    await run("restart: a new launch drops the cached hard-challenge verdict, and an older instance still answering isn't taken for the new one", async (what) => {
        let canHard = false, uptime = 3600
        const fetch = (url, body) => (body.cmd === "capability" ? { json: { capability: { canStageB: canHard, reason: "no display" } } }
            : body.cmd === "metrics" ? { json: { metrics: { uptimeSec: uptime } } } : ours(url, body))
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch })
        await h.settle()
        const alert = () => JSON.stringify(h.render()).includes("Some protected sites won't load on this machine")
        const before = alert()
        canHard = true
        h.fire("fs-restart")
        await h.settle()
        h.now += 5000
        await h.tick("aquatils-fs-poll")
        await h.settle()
        const old = h.status()
        uptime = 4
        h.now += 5000
        await h.tick("aquatils-fs-poll")
        await h.settle()
        eq([before, old, h.status(), alert()], [true, "starting", "up", false], what)
    })

    await run("logs: an adopted solver's new solver.log lines reach Copy logs once, and our own child's lines aren't read back from the file", async (what) => {
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x", [LOG]: "2026-01-01 00:00:00 INFO old line\n" }, fetch: ours })
        await h.settle()
        h.files[LOG] += "2026-01-01 00:00:05 INFO adopted request\n"
        h.fire("fs-logs-copy")
        const adopted = h.clip
        h.fire("fs-restart")
        await h.settle()
        const s = h.spawns()[0]
        for (const msg of ["child request", "child second"]) {
            s.line("2026-01-01 00:00:09 INFO " + msg)
            h.files[LOG] += "2026-01-01 00:00:09 INFO " + msg + "\n"
            h.fire("fs-logs-copy")
        }
        s.exit(1)
        await h.settle()
        h.fire("fs-logs-copy")
        const n = (t, re) => (t.match(re) || []).length
        eq([n(adopted, /old line/g), n(adopted, /^\S+ INF \[solver\] adopted request$/gm), n(h.clip, /^\S+ INF \[solver\] child request$/gm), n(h.clip, /^\S+ INF \[solver\] child second$/gm), h.reads.filter((f) => f === LOG).length],
            [1, 1, 1, 1, 1], what)
    })

    await run("errors: a missing, second- or microsecond-scale t is dropped, a future watermark is reset at load, and Save re-reads the log from the start", async (what) => {
        const line = (t, msg) => "x |ERR| extension > (console.error): SEHERRv1 " + JSON.stringify({ t, ext: "aq-anikoto", scope: "s", msg }) + "\n"
        const now = 1767225600000
        let log = line(now, "good") + line(now / 1000, "seconds") + line(now * 1000, "micro") + line(undefined, "none")
        const h = bootPlugin({ storage: { "seh.maxT": now * 1000 }, fetch: (url) => (/logs\/latest/.test(url) ? { json: { data: log } } : null) })
        await h.settle()
        const first = (h.storage.get("seh.errors") || []).map((e) => e.msg)
        h.now += 1000
        log = line(h.now, "new server") + "y".repeat(log.length) + "\n"
        h.fire("seh-save")
        await h.settle()
        eq([first, h.storage.get("seh.maxT"), h.storage.get("seh.errors").map((e) => e.msg)], [["good"], h.now, ["good", "new server"]], what)
    })

    await run("port: a non-default address says to update animepahe and anikoto; Remote says how to expose the solver and keeps the host out of diagnostics", async (what) => {
        const adv = async (storage) => { const h = bootPlugin({ storage }); await h.settle(); h.fire("ui-mode-toggle"); return h }
        const view = (h) => JSON.stringify(h.render())
        const def = await adv({})
        const port = await adv({ "fs.port": "8192" })
        port.fire("fs-copy-url")
        const remote = await adv({ "fs.mode": "remote", "fs.host": "10.0.0.5" })
        remote.fire("fs-copy-diag")
        eq([view(def).includes("Solver URL"), view(port).includes("in animepahe and anikoto to http://127.0.0.1:8192/v1"), port.clip, view(remote).includes("SOLVER_ALLOW_EXTERNAL=1"), /endpoint=remote:8191\/v1/.test(remote.clip), remote.clip.includes("10.0.0.5")],
            [false, true, "http://127.0.0.1:8192/v1", true, true, false], what)
    })

    await run("test: says a page was fetched, and puts hard-challenge readiness on its own line", async (what) => {
        const fetch = (url, body) => (body.cmd === "request.get" ? { json: { status: "ok" } } : body.cmd === "capability" ? { json: { capability: { canStageB: false, reason: "no display" } } } : ours(url, body))
        const h = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch })
        await h.settle()
        h.fire("ui-mode-toggle")
        h.fire("fs-test")
        await h.settle()
        const view = JSON.stringify(h.render())
        eq([view.includes("Cloudflare test passed"), view.includes(`✓ Fetched a test page through the solver · v${SV}\\n✗ Hard challenges: not on this machine — no display`)], [false, true], what)
    })

    await run("chromium: a week-old copy doesn't hold the launch; it's updated while the solver runs and swapped in with one restart; with the download off, or the feed silent, nothing waits or retries", async (what) => {
        const start = async (fetch, storage = {}) => {
            const h = bootPlugin({ storage: { ...INSTALLED, "fs.wantChromium": true, "fs.chromiumVer": "100.0.0.0", ...storage }, files: { [BIN]: "x", [CHR]: "x" }, fetch, unzip: ["chrome-linux64/chrome"] })
            await h.settle()
            h.fire("fs-start")
            await h.settle()
            return h
        }
        const feedAsks = (h) => h.asked.filter((u) => /last-known/.test(u)).length
        const h = await start(feed)
        const during = [h.downloads.length, h.spawns().length, (h.spawns()[0] || { cmd: { env: [] } }).cmd.env.includes("SOLVER_CHROME=" + CHR)]
        h.watchers["1"] && h.watchers["1"]({ status: "completed" })
        await h.settle()
        const off = await start(feed, { "fs.wantChromium": false })
        const silent = await start((u, b) => (/last-known/.test(u) ? { hang: true } : ours(u, b)))
        silent.fire("fs-restart")
        await silent.settle()
        eq([during, h.storage.get("fs.chromiumVer"), h.storage.get("fs.chromiumCheckedAt"), h.spawns().length, [feedAsks(off), off.downloads.length, off.spawns().length], [feedAsks(silent), silent.spawns().length, silent.storage.get("fs.chromiumCheckedAt")]],
            [[1, 1, true], "200.0.0.0", 1767225600000, 2, [0, 0, 1], [1, 2, 1767225600000]], what)
    })

    await run("chromium: the feed's download must be exactly the CfT zip for that version and platform", async (what) => {
        const urls = [CFT + "200.0.0.0/linux64/chrome-linux64.zip", "https://mirror.example/200.0.0.0/linux64/chrome-linux64.zip", CFT + "200.0.0.0/linux64/../../113.0.5672.0/linux64/chrome-linux64.zip", CFT + "200.0.0.0/linux64/chrome-linux64.zip?x=1"]
        const got = []
        for (const url of urls) {
            const h = bootPlugin({ storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}` }, files: { [BIN]: "x" }, fetch: feedOf("linux64", url) })
            await h.settle()
            h.fire("fs-start")
            await h.settle()
            got.push([h.downloads.length, h.spawns().length])
        }
        eq(got, [[1, 0], [0, 1], [0, 1], [0, 1]], what)
    })

    await run("chromium: a cancelled download's late report leaves the download that replaced it alone; a Stop mid-download still clears the partial file", async (what) => {
        const first = () => bootPlugin({ storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}` }, files: { [BIN]: "x" }, fetch: feed, unzip: ["chrome-linux64/chrome"], lateCancel: true })
        const h = first()
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        h.fire("fs-restart")
        await h.settle()
        h.late.splice(0).forEach((f) => f())
        h.watchers["2"]({ status: "completed" })
        await h.settle()
        const s = h.spawns()[h.spawns().length - 1] || { cmd: { env: [] } }
        const stop = first()
        await stop.settle()
        stop.fire("fs-start")
        await stop.settle()
        stop.fire("fs-stop")
        await stop.settle()
        stop.late.splice(0).forEach((f) => f())
        eq([h.downloads.length, h.storage.get("fs.chromiumFailVer"), h.storage.get("fs.chromiumVer"), h.spawns().length, s.cmd.env.filter((e) => e.startsWith("SOLVER_CHROME=")), Object.keys(stop.files).filter((f) => f.includes("chromium.new"))],
            [2, undefined, "200.0.0.0", 1, ["SOLVER_CHROME=" + CHR], []], what)
    })

    await run("chromium: switching to Remote cancels an Update Chromium started while stopped, and the remote status still resolves", async (what) => {
        const h = bootPlugin({ storage: { ...INSTALLED, "fs.chromiumVer": "100.0.0.0", "fs.host": "10.0.0.5" }, files: { [BIN]: "x", [CHR]: "x" }, fetch: (u, b) => (/last-known/.test(u) ? feed(u, b) : null) })
        await h.settle()
        h.fire("fs-update-chromium")
        await h.settle()
        const downloading = h.downloads.length
        h.fire("fs-mode-remote")
        await h.settle()
        for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
        await h.settle()
        eq([downloading, h.cancels, h.status()], [1, ["1"], "down"], what)
    })

    await run("chromium on linux arm64: the CfT linux-arm64 build is fetched and handed to the solver", async (what) => {
        const h = bootPlugin({ os: { arch: "arm64" }, storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}` }, files: { [BIN]: "x" }, fetch: feedOf("linux-arm64"), unzip: ["chrome-linux-arm64/chrome"] })
        await h.settle()
        h.fire("fs-start")
        await h.settle()
        h.watchers["1"]({ status: "completed" })
        await h.settle()
        const s = h.spawns()[0] || { cmd: { env: [] } }
        eq([h.downloads, s.cmd.env.filter((e) => e.startsWith("SOLVER_CHROME="))], [[CFT + "200.0.0.0/linux-arm64/chrome-linux-arm64.zip"], ["SOLVER_CHROME=/cache/aquatils/chromium/chrome-linux-arm64/chrome"]], what)
    })

    await run("chrome on musl and NixOS: the system Chromium is used over a cached Google build and nothing is fetched; with none the reason stays visible after the solver is up; on glibc the probe runs again on Start and after the download", async (what) => {
        const cap = (u, b) => (b.cmd === "capability" ? { json: { capability: { canStageB: false, reason: "no browser configured" } } } : feed(u, b))
        const start = async (lines, files = {}) => {
            const h = bootPlugin({ storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}` }, files: { [BIN]: "x", ...files }, fetch: cap, sh: probed(lines), unzip: ["chrome-linux64/chrome"] })
            await h.settle()
            h.fire("fs-start")
            await h.settle()
            return h
        }
        const chrome = (h) => (h.spawns()[0] || { cmd: { env: [] } }).cmd.env.filter((e) => e.startsWith("SOLVER_CHROME="))
        const feedAsks = (h) => h.asked.filter((u) => /last-known/.test(u)).length
        const musl = await start(["MUSL", "PM apk", "SYS /usr/bin/chromium"], { [CHR]: "x" })
        const nix = await start(["NIXOS"])
        const nixErr = /can't run on NixOS/.test(lastErr(nix))
        nix.now += 5000
        await nix.tick("aquatils-fs-poll")
        await nix.settle()
        const glibc = await start(["PM apt-get"])
        glibc.watchers["1"]({ status: "completed" })
        await glibc.settle()
        eq([[chrome(musl), musl.downloads.length, feedAsks(musl)], [chrome(nix), nix.downloads.length, feedAsks(nix), nixErr, nix.status(), JSON.stringify(nix.render()).includes("the fast path keeps working meanwhile. Sites behind a light check still work.") && JSON.stringify(nix.render()).includes("need these on this machine (uTLS still works): Chromium.")], [probeRuns(glibc).map((c) => /^sh -c c=('[^']*')/.exec(c.args)[1]), chrome(glibc)]],
            [[["SOLVER_CHROME=/usr/bin/chromium"], 0, 0], [[], 0, 0, true, "up", true], [["''", "''", `'${CHR}'`], ["SOLVER_CHROME=" + CHR]]], what)
    })

    await run("chrome on musl and NixOS: no Chromium download toggle or Update Chromium is offered, and a stale Update Chromium press fetches nothing", async (what) => {
        const seen = async (lines) => {
            const h = bootPlugin({ storage: { "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}`, "fs.chromiumVer": "100.0.0.0", "ui.mode": "advanced" }, files: { [BIN]: "x", [CHR]: "x" }, fetch: feed, sh: probed(lines) })
            await h.settle()
            const cf = JSON.stringify(h.render())
            h.fire("view-settings")
            const settings = JSON.stringify(h.render())
            h.fire("fs-update-chromium")
            await h.settle()
            return [cf.includes('"label":"Update Chromium"'), settings.includes("Download Chromium from Google"), h.downloads.length]
        }
        eq([await seen(["MUSL", "PM apk", "SYS /usr/bin/chromium"]), await seen(["NIXOS", "SYS /run/current-system/sw/bin/chromium"]), await seen(["PM apt-get"])], [[false, false, 0], [false, false, 0], [true, true, 1]], what)
    })

    await run("first run: the consent tick names what it agrees to, the Chromium row is worded per OS and stays after consent and in Settings, and it writes only its own key", async (what) => {
        const linRow = "Download Chromium from Google (~200 MB) — needed for the hardest checks"
        const lin = bootPlugin()
        await lin.settle()
        const before = JSON.stringify(lin.render())
        lin.fire("fs-consent-toggle")
        const after = JSON.stringify(lin.render())
        lin.fire("view-settings")
        const settings = JSON.stringify(lin.render())
        lin.writes.length = 0
        lin.fire("fs-chromium-toggle")
        const win = bootPlugin({ os: { platform: "windows" } })
        await win.settle()
        const wv = JSON.stringify(win.render())
        const up = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch: ours })
        await up.settle()
        up.fire("fs-chromium-toggle")
        eq([before.includes("I agree to download and run the solver from GitHub"), before.includes(linRow), before.includes("WebView2"), before.includes("Cloudflare's encrypted DNS"),
            after.includes(linRow), settings.includes(linRow), lin.writes, lin.storage.get("fs.wantChromium"),
            wv.includes("Also download Chromium from Google (~200 MB) — only needed if WebView2 can't clear a site"), wv.includes("WebView2 engine is built into Windows"),
            up.toasts.some((t) => /Chromium download on — restarting the solver/.test(t))],
            [true, true, false, true, true, true, ["fs.wantChromium"], false, true, true, true], what)
    })

    await run("auto-start: offered once after a healthy local start; Yes turns it on, Not now only ends the offer", async (what) => {
        const offer = "Start the solver automatically with Seanime?"
        const boot = async (storage = {}) => { const h = bootPlugin({ storage: { ...INSTALLED, ...storage }, files: { [BIN]: "x" }, fetch: ours }); await h.settle(); return h }
        const shows = (h) => JSON.stringify(h.render()).includes(offer)
        const yes = await boot()
        const shown = shows(yes)
        yes.fire("fs-autostart-yes")
        const no = await boot()
        no.fire("fs-autostart-no")
        const down = bootPlugin()
        await down.settle()
        const others = [await boot({ "fs.autoStartAsked": true }), await boot({ "fs.autoStart": true }), await boot({ "fs.mode": "remote" }), down]
        eq([shown, [yes, no].map((h) => [h.storage.get("fs.autoStart") === true, h.storage.get("fs.autoStartAsked"), shows(h)]), others.map(shows)],
            [true, [[true, true, false], [false, true, false]], [false, false, false, false]], what)
    })

    await run("noise: a solver never installed sends no 'isn't running' notification and keeps the badge and anime button quiet; an installed one still does", async (what) => {
        const quiet = bootPlugin()
        const loud = bootPlugin({ storage: { "fs.everInstalled": true, "fs.solverReady": `${SV}`, "fs.solverVerified": `${SV}`, "fs.wantChromium": false }, files: { [BIN]: "x" } })
        for (const h of [quiet, loud]) {
            await h.settle()
            for (let i = 0; i < 2; i++) { h.now += 5000; await h.tick("aquatils-fs-poll") }
            await h.settle()
        }
        eq([quiet, loud].map((h) => [h.status(), h.notes.filter((n) => /isn't running/.test(n)).length, h.badge && h.badge.number ? h.badge.intent : "", h.anime.label]),
            [["down", 0, "", "Solver"], ["down", 1, "error", "Solver ⏻ off"]], what)
    })

    await run("errors: the row, row copy and Copy all share one timed line built from the grouped rows; the badge and tab count only unread groups", async (what) => {
        const at = 1767225600000
        const line = (t, msg) => "x |ERR| extension > (console.error): SEHERRv1 " + JSON.stringify({ t, ext: "aq-anizone", scope: "server", msg }) + "\n"
        let log = line(at - 60000, "episode page failed (404)") + line(at - 30000, "episode page failed (404)") + line(at - 5000, "solver unreachable")
        const h = bootPlugin({ fetch: (url) => (/logs\/latest/.test(url) ? { json: { data: log } } : null) })
        await h.settle()
        const hm = (t) => new Date(t).toTimeString().slice(0, 5)
        const want = [hm(at - 5000) + " [aq-anizone · server] solver unreachable", hm(at - 30000) + " [aq-anizone · server] episode page failed (404) ×2"]
        const tab = () => (/"label":"(Errors[^"]*)"/.exec(JSON.stringify(h.render())) || [])[1]
        const unread = [h.badge.number, tab()]
        h.fire("view-errors")
        const read = [h.badge.number, tab(), h.storage.get("seh.readAt") >= at]
        const view = JSON.stringify(h.render())
        h.fire("seh-copy-1")
        const row = h.clip
        h.fire("seh-copy-all")
        const all = h.clip
        h.fire("view-cf")
        h.now += 60000
        log += line(h.now, "solver unreachable")
        await h.tick("aquatils-seh-poll")
        await h.settle()
        eq([unread, read, view.includes(want[1]), view.includes("Listening to Seanime's log · checked 0s ago"), view.includes('"b":{"text":"Copy this error"}'), row, all, [h.badge.number, tab()]],
            [[2, "Errors (2 new)"], [0, "Errors (2)", true], true, true, true, want[1], want.join("\n"), [1, "Errors (1 new)"]], what)
    })

    await run("errors: warn and info records show dimmed and labelled but stay out of the badge, the tab count and notifications; an unknown lvl is an error", async (what) => {
        const at = 1767225600000
        const line = (t, msg, lvl) => "x |ERR| extension > (console.error): SEHERRv1 " + JSON.stringify({ t, ext: "aq-anikoto", scope: "server", msg, lvl }) + "\n"
        const log = line(at - 3000, "broke") + line(at - 2000, "fell back", "warn") + line(at - 1000, "no dub", "info") + line(at, "odd", "fatal")
        const h = bootPlugin({ storage: { "seh.notify": true }, fetch: (url) => (/logs\/latest/.test(url) ? { json: { data: log } } : null) })
        await h.settle()
        const hm = (t) => new Date(t).toTimeString().slice(0, 5)
        const tab = () => (/"label":"(Errors[^"]*)"/.exec(JSON.stringify(h.render())) || [])[1]
        const color = (a) => { let hit = ""; JSON.stringify(h.render(), (k, v) => { if (v && v.t === "text" && v.a === a) hit = v.b.style.color; return v }); return hit }
        const unread = [h.badge.number, tab(), h.notes.filter((n) => /aq-anikoto/.test(n)), h.toasts.filter((t) => /aq-anikoto/.test(t))]
        h.fire("view-errors")
        const rows = [hm(at - 3000) + " [aq-anikoto · server] broke", hm(at - 2000) + " warn [aq-anikoto · server] fell back", hm(at - 1000) + " info [aq-anikoto · server] no dub", hm(at) + " [aq-anikoto · server] odd"].map(color)
        h.fire("seh-copy-all")
        eq([unread, [h.badge.number, tab()], rows, h.clip.includes(hm(at - 2000) + " warn [aq-anikoto · server] fell back"), h.storage.get("seh.errors").map((e) => e.lvl || "")],
            [[2, "Errors (2 new)", ["[aq-anikoto · server] broke", "[aq-anikoto · server] odd"], ["error: [aq-anikoto · server] broke", "error: [aq-anikoto · server] odd"]],
                [0, "Errors (2)"], ["rgba(255,255,255,0.8)", "rgba(255,255,255,0.45)", "rgba(255,255,255,0.45)", "rgba(255,255,255,0.8)"], true, ["", "warn", "info", ""]], what)
    })

    await run("errors: a 401 replaces the empty list without advice to drop the password, Save reports what the probe found, and a read that stops answering goes stale", async (what) => {
        let reply = { status: 401 }
        const h = bootPlugin({ fetch: (url) => (/logs\/latest/.test(url) ? reply : null) })
        await h.settle()
        h.fire("view-errors")
        const locked = JSON.stringify(h.render())
        const warned = h.toasts.slice()
        reply = null
        h.fire("seh-save")
        await h.settle()
        const refused = h.toasts[h.toasts.length - 1]
        reply = { json: { data: "" } }
        h.fire("seh-save")
        await h.settle()
        const ok = [h.toasts[h.toasts.length - 1], JSON.stringify(h.render()).includes("No extension errors reported.")]
        reply = { hang: true }
        h.tick("aquatils-seh-poll")
        h.now += 181000
        const stale = JSON.stringify(h.render())
        eq([locked.includes("Can't read Seanime's log (HTTP 401) — extension errors won't appear here while a server password is set. The solver is unaffected."), locked.includes("No extension errors reported."),
            warned, refused, ok, stale.includes("Seanime's log isn't answering (last read 3m ago)")],
            [true, false, ["warning: The Errors tab can't read Seanime's log while a server password is set. The solver is unaffected."],
                "error: Can't read Seanime's log (unreachable) — extension errors won't appear here. Check the Seanime URL in ⚙.", ["success: Connected to Seanime's log", true], true], what)
    })

    await run("actions: the Running row is Test, Restart, then a subtle Stop; no plain Restart while an update waits; the crash row's Retry is Advanced-only", async (what) => {
        const labels = (h) => [...JSON.stringify(h.render()).matchAll(/"label":"(Test|Restart|Stop|Restart to update|Retry|Start)","onClick":"[^"]+","intent":"([^"]+)"/g)].map((m) => m[1] + ":" + m[2])
        const up = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch: ours })
        const old = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" }, fetch: (u, b) => ours(u, b) && { json: { solver: "aquatils", version: "0.1.9", sessions: ["seanime"] } } })
        const crash = bootPlugin({ storage: INSTALLED, files: { [BIN]: "x" } })
        for (const h of [up, old, crash]) await h.settle()
        const running = labels(up)
        up.fire("fs-restart")
        let stop = null
        JSON.stringify(up.render(), (k, v) => { if (v && v.t === "button" && v.a.label === "Stop") stop = v.a; return v })
        crash.fire("fs-start")
        await crash.settle()
        crash.spawns()[0].exit(1)
        await crash.settle()
        const simple = labels(crash)
        crash.fire("ui-mode-toggle")
        eq([running, labels(old), simple, labels(crash).includes("Retry:gray-subtle"), [up.status(), !!stop && !stop.disabled]],
            [["Test:gray-subtle", "Restart:warning-subtle", "Stop:alert-subtle"], ["Restart to update:primary", "Test:gray-subtle", "Stop:alert-subtle"], ["Start:success"], true, ["starting", true]], what)
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
console.log(`${checks} checks passed`)
