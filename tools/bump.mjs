import fs from "fs"
import path from "path"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

export const MAX_MAJOR = 9
export const MAX_MINOR = 9
export const MAX_PATCH = 99

export function parse(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v))
    if (!m) return null
    return { major: +m[1], minor: +m[2], patch: +m[3] }
}

export function isValid(v) {
    const p = parse(v)
    return !!p && p.major <= MAX_MAJOR && p.minor <= MAX_MINOR && p.patch <= MAX_PATCH
}

export function next(v) {
    const p = parse(v)
    if (!p) throw new Error(`unparseable version: ${v}`)
    let { major, minor, patch } = p
    patch++
    if (patch > MAX_PATCH) { patch = 0; minor++ }
    if (minor > MAX_MINOR) { minor = 0; major++ }
    if (major > MAX_MAJOR) throw new Error(`${v} cannot be bumped: major would exceed ${MAX_MAJOR}`)
    return `${major}.${minor}.${patch}`
}

export function normalise(v) {
    const p = parse(v)
    if (!p) throw new Error(`unparseable version: ${v}`)
    let { major, minor, patch } = p
    if (patch > MAX_PATCH) { patch = 0; minor++ }
    if (minor > MAX_MINOR) { minor = 0; major++ }
    if (major > MAX_MAJOR) throw new Error(`${v} cannot be normalised: major would exceed ${MAX_MAJOR}`)
    return `${major}.${minor}.${patch}`
}

export function manifests() {
    const out = []
    for (const kind of ["extensions", "plugins"]) {
        const dir = path.join(ROOT, kind)
        if (!fs.existsSync(dir)) continue
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name, "manifest.json")
            if (fs.existsSync(p)) out.push(p)
        }
    }
    return out
}

function apply(file, mode) {
    const m = JSON.parse(fs.readFileSync(file, "utf8"))
    const before = String(m.version)
    const after = mode === "normalise" ? normalise(before) : next(before)
    if (after === before) return null
    m.version = after
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n")
    return { before, after }
}

const args = process.argv.slice(2)
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("bump.mjs")) {
    if (args[0] === "--check") {
        const bad = []
        for (const f of manifests()) {
            const m = JSON.parse(fs.readFileSync(f, "utf8"))
            if (!isValid(m.version)) bad.push(`${path.relative(ROOT, f)}: ${m.version}`)
        }
        if (bad.length) {
            console.error(`versions must be <=${MAX_MAJOR}.<=${MAX_MINOR}.<=${MAX_PATCH}:`)
            for (const b of bad) console.error("  " + b)
            process.exit(1)
        }
        console.log(`all ${manifests().length} manifest versions are within ${MAX_MAJOR}.${MAX_MINOR}.${MAX_PATCH}`)
    } else if (args[0] === "--normalise") {
        for (const f of manifests()) {
            const r = apply(f, "normalise")
            if (r) console.log(`${path.relative(ROOT, f)}: ${r.before} -> ${r.after}`)
        }
    } else if (args.length) {
        for (const name of args) {
            const f = manifests().find((p) => p.split(/[\\/]/).slice(-2, -1)[0] === name)
            if (!f) { console.error(`no manifest for ${name}`); process.exit(1) }
            const r = apply(f, "next")
            console.log(`${name}: ${r.before} -> ${r.after}`)
        }
    } else {
        console.error("usage: bump.mjs <component>... | --check | --normalise")
        process.exit(1)
    }
}
