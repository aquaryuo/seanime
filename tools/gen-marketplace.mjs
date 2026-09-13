import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"

const FIELDS = ["id", "name", "version", "description", "author", "type", "language", "lang", "icon", "website", "manifestURI"]
const ROOTS = ["extensions", "plugins"]

function entryFrom(manifest) {
    const out = {}
    for (const f of FIELDS) if (manifest[f] !== undefined) out[f] = manifest[f]
    return out
}

function localManifests() {
    const out = []
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        for (const name of fs.readdirSync(root).sort()) {
            const p = path.join(root, name, "manifest.json")
            if (fs.existsSync(p)) out.push(JSON.parse(fs.readFileSync(p, "utf8")))
        }
    }
    return out
}

function refManifests(ref) {
    let names
    try {
        names = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { encoding: "utf8" })
    } catch {
        return null
    }
    const out = []
    for (const p of names.split("\n").filter((l) => /^(extensions|plugins)\/[^/]+\/manifest\.json$/.test(l)).sort()) {
        try {
            out.push(JSON.parse(execFileSync("git", ["show", `${ref}:${p}`], { encoding: "utf8" })))
        } catch {}
    }
    return out
}

const beta = localManifests().map(entryFrom)
const mainRef = process.env.MAIN_REF || "origin/main"
const mainList = refManifests(mainRef)
if (mainList === null) {
    console.error(`cannot read ${mainRef} — fetch it first (CI needs fetch-depth: 0)`)
    process.exit(2)
}
const main = mainList.map(entryFrom)

const seen = new Set()
const entries = []
for (const e of beta.concat(main)) {
    if (!e.id || seen.has(e.id)) continue
    seen.add(e.id)
    entries.push(e)
}

const json = JSON.stringify(entries, null, 2) + "\n"
if (process.argv.includes("--check")) {
    const current = fs.existsSync("marketplace.json") ? fs.readFileSync("marketplace.json", "utf8") : ""
    if (current !== json) {
        console.error("marketplace.json is out of date — run: node tools/gen-marketplace.mjs")
        process.exit(1)
    }
    console.log(`marketplace.json matches ${entries.length} manifests`)
} else {
    fs.writeFileSync("marketplace.json", json)
    console.log(`wrote ${entries.length} entries (${beta.length} beta, ${main.length} stable)`)
}
