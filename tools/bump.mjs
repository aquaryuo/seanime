import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

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

export function manifests() {
    const dir = path.join(ROOT, "extensions")
    return fs.readdirSync(dir).sort().map((name) => path.join(dir, name, "manifest.json")).filter(fs.existsSync)
}

const args = process.argv.slice(2)
if (process.argv[1].endsWith("bump.mjs")) {
    if (!args.length) {
        console.error("usage: bump.mjs <component>...")
        process.exit(1)
    }
    for (const name of args) {
        const f = manifests().find((p) => p.split(/[\\/]/).slice(-2, -1)[0] === name)
        if (!f) { console.error(`no manifest for ${name}`); process.exit(1) }
        const m = JSON.parse(fs.readFileSync(f, "utf8"))
        const before = m.version
        m.version = next(before)
        fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n")
        console.log(`${name}: ${before} -> ${m.version}`)
    }
}
